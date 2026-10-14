import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { applyBoundGuards } from "../bounds/tool-guards.js";
import { assertToolAllowed, type ExecutionContext } from "../bounds/execution-context.js";
import { intersectExecutionScope, scopeFingerprint, type ExecutionScope } from "../bounds/execution-scope.js";
import type { ToolMeta, Bound } from "../bounds/types.js";
import type { ToolContext } from "./define-tool.js";
import { encodeEffectJson } from "./effect-json.js";

export class EffectOutcomeUnknown extends Error {
  constructor(cause?: unknown) {
    super("OutcomeUnknown: reconcile the destination before repeating this effect", cause === undefined ? undefined : { cause });
  }
}
export interface ScopedInvocation {
  key: string; node: string; tool: string; input: Record<string, unknown>;
  approvedFingerprint?: string;
}
export interface InvocationAuthority {
  approved: ExecutionScope; current: ExecutionContext; catalog: ToolMeta[];
  restrictions?: (Bound | null)[];
}
export interface ScopedTool {
  namespace: string; name: string; access: "read" | "write";
  contractHash?: string;
  parse(input: unknown): Record<string, unknown>;
  invoke(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
  secrets?: string[];
}

/** Destination-owned receipts. Construct explicitly on a caller-owned database. */
export class ScopedToolInvoker {
  constructor(private readonly options: {
    db: DatabaseSync; node: string; tools: ScopedTool[];
    authorize: (request: ScopedInvocation) => Promise<InvocationAuthority>;
    credentials: (identity: string | undefined, names: readonly string[]) => Promise<Record<string, string>>;
    enforceable: (tool: ScopedTool, bound: Bound | null) => boolean;
  }) {
    options.db.exec("CREATE TABLE IF NOT EXISTS tool_effect_receipts(key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT,identity TEXT,scope_hash TEXT NOT NULL)");
  }
  async invoke(request: ScopedInvocation, verifyAdmission?: () => void): Promise<unknown> {
    verifyAdmission?.();
    z.string().min(1).max(500).parse(request.key);
    const tool = this.options.tools.find(tool => `${tool.namespace}:${tool.name}` === request.tool);
    if (!tool || request.node !== this.options.node) throw new Error("unknown effect destination");
    // Current authorization is checked even on receipt reads; a receipt does not bypass revocation.
    const authority = await this.options.authorize(request);
    verifyAdmission?.();
    if (request.approvedFingerprint && authority.approved.fingerprint !== request.approvedFingerprint) throw new Error("effect authority differs from the approved run grant");
    const context = intersectExecutionScope(authority.approved, authority.current, authority.catalog, authority.restrictions);
    assertToolAllowed(context, { namespace: tool.namespace, toolName: tool.name }, request.node);
    if (authority.approved.tools[request.tool] !== tool.access) throw new Error("tool access classification changed");
    if (!tool.contractHash || authority.approved.contracts?.[request.tool] !== tool.contractHash) throw new Error("ToolContractUnavailable: approved tool contract must match the destination");
    if (!this.options.enforceable(tool, context.bound)) throw new Error("required resource restrictions cannot be enforced");
    const input = tool.parse(request.input);
    encodeEffectJson(input);
    const hash = scopeFingerprint({ node: request.node, tool: request.tool, input, identity: context.identity });
    type Receipt = { request_hash: string; state: string; result: string | null; identity: string | null };
    const previous = this.options.db.prepare("SELECT * FROM tool_effect_receipts WHERE key=?").get(request.key) as Receipt | undefined;
    if (previous) {
      if (previous.request_hash !== hash || previous.identity !== (context.identity ?? null)) throw new Error("effect key conflicts with another request");
      if (previous.state !== "complete") throw new EffectOutcomeUnknown();
      return JSON.parse(previous.result!);
    }
    const secrets = await this.options.credentials(context.identity, tool.secrets ?? []);
    const narrowed = Object.fromEntries((tool.secrets ?? []).map(name => {
      if (!Object.hasOwn(secrets, name)) throw new Error(`required identity credential is unavailable: ${name}`);
      return [name, secrets[name]];
    }));
    // Recheck after awaiting credentials; no transaction is held across external work.
    const latest = await this.options.authorize(request);
    if (request.approvedFingerprint && latest.approved.fingerprint !== request.approvedFingerprint) throw new Error("effect authority differs from the approved run grant");
    if (latest.approved.tools[request.tool] !== tool.access || !tool.contractHash || latest.approved.contracts?.[request.tool] !== tool.contractHash) throw new Error("ToolContractUnavailable: destination contract changed during effect admission");
    const live = intersectExecutionScope(latest.approved, latest.current, latest.catalog, latest.restrictions);
    assertToolAllowed(live, { namespace: tool.namespace, toolName: tool.name }, request.node);
    if (scopeFingerprint(live) !== scopeFingerprint(context)) throw new Error("execution policy changed during invocation admission; retry");
    verifyAdmission?.();
    const inserted = this.options.db.prepare("INSERT OR IGNORE INTO tool_effect_receipts VALUES(?,?,'admitted',NULL,?,?)").run(request.key, hash, context.identity ?? null, authority.approved.fingerprint);
    if (!inserted.changes) return this.invoke(request, verifyAdmission);
    try {
      const guarded = applyBoundGuards([{ name: tool.name, handler: (params: Record<string, unknown>, callContext: ToolContext) => tool.invoke(params, callContext) }], context.bound ?? {})[0];
      const result = await guarded.handler(input, { secrets: narrowed, availableTools: live.allowedToolIds });
      const encoded = encodeEffectJson(result ?? null);
      this.options.db.prepare("UPDATE tool_effect_receipts SET state='complete',result=? WHERE key=? AND request_hash=?").run(encoded, request.key, hash);
      return JSON.parse(encoded);
    } catch (error) {
      this.options.db.prepare("UPDATE tool_effect_receipts SET state='uncertain' WHERE key=? AND state='admitted'").run(request.key);
      // Once admitted, a handler failure cannot prove that no effect occurred.
      // Surface uncertainty immediately instead of spending a retry to discover it.
      throw new EffectOutcomeUnknown(error);
    }
  }
  /** Only a destination's trusted reconciliation operation supplies evidence. */
  reconcile(key: string, requestHash: string, result: unknown): void {
    const encoded = encodeEffectJson(result ?? null);
    const changed = this.options.db.prepare("UPDATE tool_effect_receipts SET state='complete',result=? WHERE key=? AND request_hash=? AND state IN ('admitted','uncertain')").run(encoded, key, requestHash);
    if (!changed.changes) throw new Error("unknown or already reconciled effect");
  }
}
