import type { Request, RequestHandler } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { authenticateCredential, requestCredential, revalidateRequestAuthorization } from "@barry-rocks/sdk/internal/auth";
import { access } from "@barry-rocks/identities-bag";
import type { WorkflowSessionCredential } from "@barry-rocks/sdk/internal/auth";

import { authorizeSessionExecution } from "@barry-rocks/sessions-bag/execution-authorization";
import { TransportDelivery } from "./transport-delivery.js";

type Principal = { kind: "installation"; actorId: number }
  | ({ kind: "workflow" } & WorkflowSessionCredential);
interface TransportLease { principal: Principal; sessionId: string | null; namespace: string }
interface LiveTransportLease extends TransportLease {
  check(): Promise<boolean>;
  dispose(): void;
  stop?: () => void;
}

/** A transport ID identifies a connection; it never authorizes access to its session on its own. */
export class TransportAuthorization {
  private readonly leases = new Map<string, LiveTransportLease>();
  private readonly pending = new WeakMap<Request, LiveTransportLease>();
  private readonly requests = new AsyncLocalStorage<Request>();

  constructor(private readonly workflow: (request: Request) => WorkflowSessionCredential | undefined,
    private readonly checkWorkflow?: (request: Request) => Promise<boolean>,
    private readonly disposeWorkflow?: (request: Request) => void) {}

  readonly middleware: RequestHandler = (request, response, next) => {
    const path = /^\/mcp(?:\/ns\/([^/]+))?\/?$/.exec(request.path);
    if (!path) return next();
    void this.authorize(request, path[1] ?? "").then(allowed => {
      if (response.destroyed || response.writableEnded) return;
      if (allowed === "missing") {
        response.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found or expired" }, id: null });
        return;
      }
      if (allowed) this.requests.run(request, next);
      else response.status(403).json({ ok: false, error: "Forbidden" });
    }).catch(() => {
      if (!response.destroyed && !response.writableEnded) response.status(403).json({ ok: false, error: "Forbidden" });
    });
  };

  bind(id: string, request: Request, transport?: Transport, onRejected?: () => void): void {
    const lease = this.pending.get(request);
    if (!lease) throw new Error("Transport authorization is unavailable");
    this.release(id);
    this.leases.set(id, lease);
    this.pending.delete(request);
    if (!transport) return;
    let closed = false;
    const reject = async () => {
      if (closed) return;
      closed = true;
      this.release(id);
      onRejected?.();
      try { await transport.close(); } catch { /* Authority has already been released. */ }
    };
    const delivery = new TransportDelivery(transport, () => this.revalidateTransport(id), reject);
    transport.send = (...args) => delivery.send(...args);
    let checking = false;
    let dirty = false;
    const check = async () => {
      dirty = true;
      if (checking || closed) return;
      checking = true;
      try {
        do {
          dirty = false;
          if (!await this.revalidateTransport(id)) { await reject(); return; }
        } while (dirty && !closed);
      } finally { checking = false; }
    };
    const timer = setInterval(() => { void check(); }, 1000);
    timer.unref();
    const unsubscribe = access.subscribe(() => { void check(); });
    lease.stop = () => { closed = true; delivery.close(); clearInterval(timer); unsubscribe(); };
  }
  release(id: string): void {
    const lease = this.leases.get(id);
    this.leases.delete(id);
    lease?.stop?.();
    lease?.dispose();
  }
  async revalidateTransport(id: string): Promise<boolean> {
    const lease = this.leases.get(id);
    if (!lease) return false;
    try {
      return await lease.check() && this.leases.get(id) === lease;
    } catch { return false; }
  }
  readonly authorizeCall = async (): Promise<boolean> => {
    const request = this.requests.getStore();
    if (!request || request.aborted || request.res?.destroyed || request.res?.writableEnded) return false;
    try {
      if (this.workflow(request) && (!this.checkWorkflow || !await this.checkWorkflow(request))) return false;
      const allowed = await this.revalidate(request);
      return allowed && !request.aborted && !request.res?.destroyed && !request.res?.writableEnded;
    } catch { return false; }
  };
  async revalidate(request: Request): Promise<boolean> {
    const path = /^\/mcp(?:\/ns\/([^/]+))?\/?$/.exec(request.path);
    return Boolean(path) && await this.authorize(request, path![1] ?? "") === true;
  }

  private async authorize(request: Request, encodedNamespace: string): Promise<boolean | "missing"> {
    const namespace = decodeURIComponent(encodedNamespace);
    if (namespace && !/^[A-Za-z0-9._-]{1,128}$/.test(namespace)) return false;
    const header = request.headers["mcp-session-id"];
    if (header !== undefined && (typeof header !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(header))) return false;
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index].toLowerCase() === "mcp-session-id" && ++count > 1) return false;
    }
    const selected = request.query.sessionId;
    if (selected !== undefined && (typeof selected !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(selected))) return false;
    const workflow = this.workflow(request);
    const principal: Principal | undefined = workflow ? { kind: "workflow", ...workflow }
      : request.authPrincipal?.kind === "installation" ? { kind: "installation", actorId: request.authPrincipal.actorId } : undefined;
    if (!principal) return false;
    const existing = typeof header === "string" ? this.leases.get(header) : undefined;
    if (header && !existing) return "missing";
    const sessionId = existing?.sessionId ?? (typeof selected === "string" ? selected : null);
    if (existing && (existing.namespace !== namespace || (selected !== undefined && selected !== existing.sessionId)
      || !this.samePrincipal(existing.principal, principal))) return false;
    if (existing && !await this.revalidateTransport(header as string)) return false;
    if (principal.kind === "workflow") {
      if (sessionId !== principal.sessionId || principal.expiresAt <= Date.now()) return false;
    } else {
      if (!await revalidateRequestAuthorization(request)) return false;
      await authorizeSessionExecution(request.authPrincipal!, { sessionId: sessionId ?? undefined });
    }
    if (!header && request.method === "POST" && isInitializeRequest(request.body)) {
      if (!this.pending.has(request)) {
        const retained = principal.kind === "installation"
          ? await authenticateCredential(requestCredential(request) ?? "", { verifyCredential: access.verifyCredential }) : undefined;
        if (principal.kind === "installation" && (!retained || retained.principal.kind !== "installation"
          || retained.principal.actorId !== principal.actorId)) { retained?.dispose(); return false; }
        const lease: LiveTransportLease = {
          principal: Object.freeze(principal), sessionId, namespace,
          check: retained ? () => retained.authorize({ scopes: ["sessions:read"], authorize: async current => {
            await authorizeSessionExecution(current, { sessionId: sessionId ?? undefined }); return true;
          } }) : async () => principal.kind === "workflow" && principal.expiresAt > Date.now()
            && await this.checkWorkflow?.(request) === true,
          dispose: () => { retained?.dispose(); if (!retained) this.disposeWorkflow?.(request); },
        };
        this.pending.set(request, lease);
        request.res?.once("close", () => {
          if (this.pending.get(request) === lease) { this.pending.delete(request); lease.dispose(); }
        });
      }
    }
    return true;
  }

  private samePrincipal(first: Principal, second: Principal): boolean {
    if (first.kind === "installation") return second.kind === first.kind && first.actorId === second.actorId;
    return second.kind === first.kind && first.actorId === second.actorId && first.credentialId === second.credentialId && first.identityId === second.identityId
      && first.sessionId === second.sessionId && first.identity === second.identity
      && first.boundFingerprint === second.boundFingerprint && first.expiresAt === second.expiresAt;
  }
}
