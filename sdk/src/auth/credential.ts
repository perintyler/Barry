import { AuthPrincipalSchema, DeviceScopeSchema, hasScope, type AuthPrincipal, type DeviceScope } from "./principal.js";
import { samePrincipal } from "./principal-comparison.js";
import { withDeadline } from "./with-deadline.js";
export { requestCredential } from "./credentials.js";

export interface CredentialRules {
  scopes: readonly DeviceScope[];
  authorize: (principal: AuthPrincipal, signal: AbortSignal) => boolean | Promise<boolean>;
}
export interface CredentialAuthorization {
  readonly principal: AuthPrincipal;
  revalidate(signal?: AbortSignal): Promise<boolean>;
  authorize(rules: CredentialRules, signal?: AbortSignal): Promise<boolean>;
  dispose(): void;
}
export interface CredentialVerificationOptions {
  /** The principal it vouches for, or a promise of it. */
  verifyCredential: (credential: string, signal: AbortSignal) => unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Transports keep this handle private; a principal shape alone cannot create one. */
export async function authenticateCredential(credential: string, options: CredentialVerificationOptions): Promise<CredentialAuthorization | null> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new RangeError("Invalid authorization timeout");
  if (!/^[\x21-\x7e]{1,4096}$/.test(credential)) return null;
  const verify = options.verifyCredential;
  const lifetime = new AbortController();
  let secret: string | undefined = credential;
  const run = async <T>(operation: (signal: AbortSignal, assertActive: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    try {
      return await withDeadline(operation, {
        timeoutMs,
        signals: [lifetime.signal, signal],
        onCancel: () => new Error("Authorization unavailable"),
      });
    } catch { throw new Error("Authorization unavailable"); }
  };
  let principal: AuthPrincipal;
  try {
    const initial = await run(async signal => AuthPrincipalSchema.safeParse(await verify(secret!, signal)), options.signal);
    if (!initial.success) { secret = undefined; lifetime.abort(); return null; }
    principal = initial.data;
  } catch { secret = undefined; lifetime.abort(); throw new Error("Authorization unavailable"); }
  const check = async (rules?: CredentialRules, signal?: AbortSignal): Promise<boolean> => {
    if (secret === undefined || lifetime.signal.aborted) return false;
    // Capture validated rules so a caller cannot change its requirements during an await.
    const scopes = rules ? Object.freeze([...rules.scopes]) : undefined;
    const authorize = rules?.authorize;
    if (scopes && (!scopes.length || !scopes.every(scope => DeviceScopeSchema.safeParse(scope).success))) return false;
    try {
      return await run(async (signal, assertActive) => {
        const current = AuthPrincipalSchema.safeParse(await verify(secret!, signal));
        assertActive();
        if (!current.success || !samePrincipal(principal, current.data)) return false;
        if (scopes && current.data.kind === "device" && !scopes.every(scope => hasScope(current.data, scope))) return false;
        if (authorize && await authorize(current.data, signal) !== true) return false;
        return true;
      }, signal);
    } catch { return false; }
  };
  return Object.freeze({
    principal,
    revalidate: (signal?: AbortSignal) => check(undefined, signal),
    authorize: (rules: CredentialRules, signal?: AbortSignal) => rules && Array.isArray(rules.scopes) && typeof rules.authorize === "function" ? check(rules, signal) : Promise.resolve(false),
    dispose: () => { secret = undefined; lifetime.abort(); },
  });
}
