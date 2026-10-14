import type { Request, RequestHandler, Response } from "express";
import { requestCredential } from "./credentials.js";
import { AuthPrincipalSchema, DeviceScopeSchema, hasScope, type AuthPrincipal, type DeviceScope } from "./principal.js";
import { samePrincipal } from "./principal-comparison.js";
import { withDeadline } from "./with-deadline.js";

declare global {
  // Express's Request can only be augmented through its namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { readonly authPrincipal?: AuthPrincipal }
  }
}

export interface RequestPolicy {
  scopes: readonly DeviceScope[];
  authorize: (principal: AuthPrincipal, request: Request, signal: AbortSignal) => boolean | Promise<boolean>;
}
export interface RequestAuthorizationOptions {
  /** The principal it vouches for, or a promise of it. */
  verifyCredential: (credential: string, signal: AbortSignal) => unknown;
  policy: (request: Request) => RequestPolicy | null;
  timeoutMs?: number;
}

const revalidators = new WeakMap<Request, (signal?: AbortSignal) => Promise<boolean>>();

/** Only requests admitted by this middleware carry a private credential revalidator. */
export async function revalidateRequestAuthorization(request: Request, signal?: AbortSignal): Promise<boolean> {
  return revalidators.get(request)?.(signal) ?? false;
}

function authorizationContext(request: Request): Request {
  const context = Object.create(request) as Request;
  for (const key of ["method", "path", "url", "originalUrl", "baseUrl"] as const) {
    Object.defineProperty(context, key, { value: request[key], writable: false, configurable: false });
  }
  return context;
}

async function recheckAuthorization(request: Request, response: Response, context: Request, credential: string,
  principal: AuthPrincipal, policy: RequestPolicy | null, options: RequestAuthorizationOptions,
  timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (request.aborted || response.destroyed || response.writableEnded || signal?.aborted) return false;
  try {
    return await withDeadline(async (controlSignal, assertActive) => {
      const result = await options.verifyCredential(credential, controlSignal);
      assertActive();
      const current = AuthPrincipalSchema.safeParse(result);
      if (!current.success || !samePrincipal(principal, current.data)) return false;
      if (current.data.kind === "device") {
        if (!policy || !policy.scopes.every(scope => hasScope(current.data, scope))) return false;
        if (await policy.authorize(current.data, context, controlSignal) !== true) return false;
      }
      assertActive();
      return true;
    }, {
      timeoutMs,
      signals: [signal],
      events: [{ source: request, event: "aborted" }, { source: response, event: "close" }],
      onCancel: () => new Error("Authorization cancelled"),
    });
  } catch { return false; }
}

export function authorizeRequest(options: RequestAuthorizationOptions): RequestHandler {
  options = Object.freeze({ ...options });
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new RangeError("Invalid authorization timeout");
  return (request, response, next) => {
    const credential = requestCredential(request);
    if (credential === null) {
      response.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    const cancelled = () => {
      if (performance.now() >= deadline) controller.abort();
      return controller.signal.aborted;
    };
    const context = authorizationContext(request);
    let policy: RequestPolicy | null = null;
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const run = async () => {
      const verified = await options.verifyCredential(credential, controller.signal);
      if (cancelled()) throw new Error("Authorization cancelled");
      const parsed = AuthPrincipalSchema.safeParse(verified);
      if (!parsed.success) return 401;
      const principal = parsed.data;
      if (principal.kind === "device") {
        const selected = options.policy(context);
        if (!selected || selected.scopes.length === 0 || !selected.scopes.every(scope => DeviceScopeSchema.safeParse(scope).success && hasScope(principal, scope))) return 403;
        policy = Object.freeze({ scopes: Object.freeze([...selected.scopes]), authorize: selected.authorize });
        if (await policy.authorize(principal, context, controller.signal) !== true) return 403;
        if (cancelled()) throw new Error("Authorization cancelled");
      }
      return principal;
    };
    // A verifier may ignore cancellation; the deadline still must bound the request.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Authorization cancelled")), { once: true });
      if (request.aborted || response.destroyed) controller.abort();
    });
    void Promise.race([run(), aborted]).then(outcome => {
      if (response.destroyed || response.writableEnded) return;
      if (cancelled()) throw new Error("Authorization cancelled");
      if (typeof outcome === "number") {
        response.status(outcome).json({ ok: false, error: outcome === 401 ? "Unauthorized" : "Forbidden" });
        return;
      }
      Object.defineProperty(request, "authPrincipal", { value: outcome, enumerable: false, writable: false, configurable: false });
      revalidators.set(request, signal => recheckAuthorization(request, response, context, credential, outcome, policy, options, timeoutMs, signal));
      response.once("close", () => revalidators.delete(request));
      next();
    }).catch(() => {
      if (!response.destroyed && !response.writableEnded) response.status(503).json({ ok: false, error: "Authorization unavailable" });
    }).finally(() => {
      clearTimeout(timer);
      request.removeListener("aborted", disconnect);
      response.removeListener("close", disconnect);
    });
  };
}
