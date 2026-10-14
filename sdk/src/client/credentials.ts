import { BarryApiError } from "./errors.js";

export type CredentialResolver = (options: { signal: AbortSignal }) => string | Promise<string>;

export interface ClientCredentials {
  secret?: string;
  /** Called for each request, including reconnects; the client never caches tokens. */
  resolveCredential?: CredentialResolver;
}

export function validateCredentials(options: ClientCredentials): void {
  if (options.secret !== undefined && options.resolveCredential !== undefined) {
    throw new BarryApiError("Choose secret or resolveCredential", { status: null, code: "invalid_request" });
  }
  if (options.resolveCredential !== undefined && typeof options.resolveCredential !== "function") {
    throw new BarryApiError("resolveCredential must be a function", { status: null, code: "invalid_request" });
  }
  if (options.secret !== undefined) validateToken(options.secret);
}

function validateToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || !token || /[^\x21-\x7e]/.test(token)) {
    throw new BarryApiError("Credential must be a nonempty token without whitespace", { status: null, code: "credential_error" });
  }
}

export async function resolveCredential(options: ClientCredentials, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) throw new BarryApiError("Credential resolution cancelled", { status: null, code: "cancelled" });
  if (!options.resolveCredential) return options.secret;
  let abort: (() => void) | undefined;
  try {
    const cancellation = new Promise<never>((_, reject) => {
      abort = () => reject(new BarryApiError("Credential resolution cancelled", { status: null, code: "cancelled" }));
      signal.addEventListener("abort", abort, { once: true });
    });
    // A resolver may ignore cancellation. Stop waiting without sending a late request.
    const token = await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw new Error("Cancelled");
      return options.resolveCredential!({ signal });
    }), cancellation]);
    if (signal.aborted) throw new Error("Cancelled");
    validateToken(token);
    return token;
  } catch {
    throw new BarryApiError("Barry credential could not be resolved", { status: null, code: "credential_error" });
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
