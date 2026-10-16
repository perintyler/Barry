import { createHash } from "node:crypto";
import { z } from "zod";
import { BoundSchema, type Bound, type ToolDescriptor } from "./types.js";
import { resolveToolCallBounds, assertNodeAllowed, type ToolCallBounds } from "./resolve-bound.js";
import { mergeBounds } from "./merge-bounds.js";
import { filterToolsQualified, qualifyToolId } from "./filter-tools.js";

const reference = z.string().min(1).max(200);

const V1_EVIDENCE_SYMBOL = Symbol.for("barry.workflowBounds.v1Evidence");

interface V1EvidenceMetadata {
  hadVersion: boolean;
  rawVersion: unknown;
  hadBags: boolean;
  hadBounds: boolean;
  rawBound: unknown;
  rawTraits: unknown;
}

const baseApprovedBoundsSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]).optional(),
  identity: reference.optional(),
  bags: z.array(reference).max(100).optional(),
  bounds: z.array(reference).max(100).optional(),
  traits: z.array(reference).max(100).optional().default([]),
  bound: BoundSchema.nullable(),
  harness: reference.optional(),
  tools: z
    .record(reference, z.enum(["read", "write"]))
    .refine((value) => Object.keys(value).length <= 1000),
  contracts: z
    .record(reference, z.string().regex(/^[a-f0-9]{64}$/))
    .refine((value) => Object.keys(value).length <= 1000)
    .optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

function convertV1EvidenceBound(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const toolDeny: string[] = [
    ...(Array.isArray((obj.tools as { deny?: unknown })?.deny)
      ? ((obj.tools as { deny: string[] }).deny)
      : []),
    ...(Array.isArray(obj.deniedTools) ? (obj.deniedTools as string[]) : []),
  ];
  if (Array.isArray(obj.deniedAccess)) {
    for (const entry of obj.deniedAccess as string[]) {
      if (entry === "read" || entry === "write") toolDeny.push(`*:${entry}`);
      else if (entry.includes(":")) toolDeny.push(entry);
      else toolDeny.push(`${entry}:write`);
    }
  }
  const out: Record<string, unknown> = {};
  if (typeof obj.name === "string") out.name = obj.name;
  if (typeof obj.description === "string") out.description = obj.description;
  const toolsObj = obj.tools && typeof obj.tools === "object" ? { ...(obj.tools as Record<string, unknown>) } : {};
  if (toolDeny.length > 0) toolsObj.deny = [...new Set(toolDeny)];
  if (Object.keys(toolsObj).length > 0) out.tools = toolsObj;
  if (obj.inputs) out.inputs = obj.inputs;
  if (obj.files && typeof obj.files === "object") {
    const f = { ...(obj.files as Record<string, unknown>) };
    if (f.allow === undefined && f.allowOnly !== undefined) f.allow = f.allowOnly;
    delete f.allowOnly;
    if (Object.keys(f).length > 0) out.files = f;
  }
  if (obj.bash && typeof obj.bash === "object") {
    const b = { ...(obj.bash as Record<string, unknown>) };
    const bDeny = [
      ...(Array.isArray(b.deny) ? (b.deny as string[]) : []),
      ...(Array.isArray(b.denyPrograms) ? (b.denyPrograms as string[]) : []),
    ];
    delete b.denyPrograms;
    if (bDeny.length > 0) b.deny = [...new Set(bDeny)];
    if (Object.keys(b).length > 0) out.bash = b;
  }
  if (obj.network && typeof obj.network === "object") {
    const n = { ...(obj.network as Record<string, unknown>) };
    if (n.allow === undefined && n.allowDomains !== undefined) n.allow = n.allowDomains;
    const nDeny = [
      ...(Array.isArray(n.deny) ? (n.deny as string[]) : []),
      ...(Array.isArray(n.actions) ? (n.actions as string[]) : []),
      ...(Array.isArray(n.domains) ? (n.domains as string[]) : []),
    ];
    delete n.allowDomains;
    delete n.actions;
    delete n.domains;
    if (nDeny.length > 0) n.deny = [...new Set(nDeny)];
    if (Object.keys(n).length > 0) out.network = n;
  }
  if (obj.nodes) out.nodes = obj.nodes;
  return out;
}

export const approvedBoundsSchema = z.unknown().transform((raw, ctx) => {
  const direct = baseApprovedBoundsSchema.safeParse(raw);
  if (direct.success && (raw as Record<string, unknown>)?.version !== 1) {
    if (raw && typeof raw === "object") {
      const existingMeta = Reflect.get(raw, V1_EVIDENCE_SYMBOL) as V1EvidenceMetadata | undefined;
      if (existingMeta) {
        Object.defineProperty(direct.data, V1_EVIDENCE_SYMBOL, {
          value: existingMeta,
          enumerable: false,
        });
      }
    }
    return direct.data;
  }
  const isV1Object =
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).version !== 2;
  const candidate = isV1Object
    ? {
        ...(raw as Record<string, unknown>),
        bound: convertV1EvidenceBound((raw as Record<string, unknown>).bound),
      }
    : raw;
  const result = baseApprovedBoundsSchema.safeParse(candidate);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
    return z.NEVER;
  }
  const parsed = result.data;
  if (raw && typeof raw === "object") {
    const existingMeta = Reflect.get(raw, V1_EVIDENCE_SYMBOL) as V1EvidenceMetadata | undefined;
    if (existingMeta) {
      Object.defineProperty(parsed, V1_EVIDENCE_SYMBOL, {
        value: existingMeta,
        enumerable: false,
      });
      return parsed;
    }
    const record = raw as Record<string, unknown>;
    const isLegacyV1 = record.version !== 2;
    if (isLegacyV1) {
      const meta: V1EvidenceMetadata = {
        hadVersion: "version" in record,
        rawVersion: record.version,
        hadBags: "bags" in record,
        hadBounds: "bounds" in record,
        rawBound: record.bound !== undefined ? structuredClone(record.bound) : null,
        rawTraits: record.traits !== undefined ? structuredClone(record.traits) : undefined,
      };
      if (parsed.bound) {
        parsed.bound = mergeBounds(null, parsed.bound);
      }
      if (parsed.bags === undefined && parsed.traits.length > 0) {
        const bags: string[] = [];
        const bounds: string[] = [...(parsed.bounds ?? [])];
        let impliedReadBound: Bound | null = null;
        for (const trait of parsed.traits) {
          if (trait.endsWith(":read") && trait.length > ":read".length) {
            const bagName = trait.slice(0, -":read".length);
            if (!bags.includes(bagName)) bags.push(bagName);
            if (!bounds.includes(trait)) bounds.push(trait);
            impliedReadBound = mergeBounds(impliedReadBound, {
              tools: { deny: [`${bagName}:write`] },
            });
          } else if (!bags.includes(trait)) {
            bags.push(trait);
          }
        }
        parsed.bags = bags;
        if (bounds.length > 0) parsed.bounds = bounds;
        if (impliedReadBound) {
          parsed.bound = mergeBounds(parsed.bound, impliedReadBound);
        }
      }
      Object.defineProperty(parsed, V1_EVIDENCE_SYMBOL, {
        value: meta,
        enumerable: false,
      });
    }
  }
  return parsed;
});

export type ApprovedBounds = z.output<typeof baseApprovedBoundsSchema>;

/** Canonical bound evidence; never contains credentials or transport tokens. */
export function boundFingerprint(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") {
      return `{${Object.keys(item)
        .filter((key) => Reflect.get(item, key) !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(item, key))}`)
        .join(",")}}`;
    }
    return JSON.stringify(item ?? null);
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function matchesApprovedFingerprint(approved: ApprovedBounds): boolean {
  const { fingerprint, ...evidence } = approved;
  if (boundFingerprint(evidence) === fingerprint) return true;
  const { traits: _omittedTraits, ...withoutTraits } = evidence;
  if ((approved.version === 2 || approved.bags) && boundFingerprint(withoutTraits) === fingerprint) return true;
  const meta = Reflect.get(approved, V1_EVIDENCE_SYMBOL) as V1EvidenceMetadata | undefined;
  if (meta) {
    // Ensure `traits` was not tampered with after parsing if rawTraits existed.
    if (
      Array.isArray(meta.rawTraits) &&
      JSON.stringify(approved.traits) !== JSON.stringify(meta.rawTraits)
    ) {
      return false;
    }
    const v1Candidate: Record<string, unknown> = {
      ...(meta.hadVersion ? { version: meta.rawVersion } : {}),
      ...(approved.identity !== undefined ? { identity: approved.identity } : {}),
      ...(meta.hadBags ? { bags: approved.bags } : {}),
      ...(meta.hadBounds ? { bounds: approved.bounds } : {}),
      ...(meta.rawTraits !== undefined ? { traits: meta.rawTraits } : {}),
      bound: meta.rawBound,
      ...(approved.harness !== undefined ? { harness: approved.harness } : {}),
      tools: approved.tools,
      ...(approved.contracts !== undefined ? { contracts: approved.contracts } : {}),
    };
    if (boundFingerprint(v1Candidate) === fingerprint) return true;
  }
  return false;
}

/** Resolve explicit selections. No identity/default union occurs here. */
export async function approveWorkflowBounds(
  options: Parameters<typeof resolveToolCallBounds>[0] & { version?: 2 },
): Promise<ApprovedBounds> {
  const context = await resolveToolCallBounds(options);
  const tools = Object.fromEntries(
    options.tools
      .filter((tool) =>
        context.allowedToolIds.includes(qualifyToolId(tool.namespace, tool.toolName)),
      )
      .map((tool) => [qualifyToolId(tool.namespace, tool.toolName), tool.access]),
  );
  const contracts = Object.fromEntries(
    options.tools
      .filter(
        (tool) =>
          tool.contractHash && Object.hasOwn(tools, qualifyToolId(tool.namespace, tool.toolName)),
      )
      .map((tool) => [qualifyToolId(tool.namespace, tool.toolName), tool.contractHash!]),
  );
  const value = {
    version: 2 as const,
    identity: context.identity,
    ...(context.bags !== undefined ? { bags: context.bags } : {}),
    ...(context.bounds !== undefined ? { bounds: context.bounds } : {}),
    traits: options.traitNames ? [...options.traitNames] : ([] as string[]),
    bound: context.bound,
    harness: context.harness,
    tools,
    contracts,
  };
  return approvedBoundsSchema.parse(
    JSON.parse(JSON.stringify({ ...value, fingerprint: boundFingerprint(value) })),
  );
}

/** Each bound must allow the operation; approvals can only shrink after creation. */
export function intersectWorkflowBounds(
  approved: ApprovedBounds,
  current: ToolCallBounds,
  tools: readonly ToolDescriptor[],
  restrictions: readonly (Bound | null)[] = [],
): ToolCallBounds {
  approved = approvedBoundsSchema.parse(approved);
  if (!matchesApprovedFingerprint(approved)) {
    throw new Error("execution scope fingerprint mismatch");
  }
  if (approved.identity !== current.identity || approved.harness !== current.harness) {
    throw new Error("execution identity or harness changed");
  }
  const bound = [approved.bound, current.bound, ...restrictions].reduce<Bound | null>(
    (result, next) => mergeBounds(result, next),
    null,
  );
  const allowed = new Set(filterToolsQualified([...tools], bound));
  return {
    ...current,
    bound,
    allowedToolIds: tools
      .filter((tool) => {
        const id = qualifyToolId(tool.namespace, tool.toolName);
        return (
          approved.tools[id] === tool.access &&
          (!approved.contracts?.[id] || approved.contracts[id] === tool.contractHash) &&
          current.allowedToolIds.includes(id) &&
          allowed.has(id)
        );
      })
      .map((tool) => qualifyToolId(tool.namespace, tool.toolName)),
  };
}

export function assertBoundDelegation(
  approved: ApprovedBounds,
  delegator: ToolCallBounds,
  tools: readonly ToolDescriptor[],
): void {
  const effective = intersectWorkflowBounds(
    approved,
    { ...delegator, identity: approved.identity, harness: approved.harness },
    tools,
  );
  if (Object.keys(approved.tools).some((id) => !effective.allowedToolIds.includes(id))) {
    throw new Error("selected job capabilities exceed delegable authority");
  }
  if (approved.bound?.nodes?.allow) {
    for (const node of approved.bound.nodes.allow) assertNodeAllowed(node, delegator.bound);
  }
}

