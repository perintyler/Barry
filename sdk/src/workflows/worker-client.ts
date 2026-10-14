import { z } from "zod";

/** Every worker credential starts with this, so an owner can refuse it on every route but /api/worker. */
export const WORKER_CREDENTIAL_PREFIX = "barry_wk_";

/** The owner refused this worker's credential: revoked, rotated past its grace, or never issued. */
export class WorkerCredentialRejected extends Error {
  constructor(readonly status: number) {
    super(`the workflow owner rejected this worker's credential (HTTP ${status}); rejoin with a new token from \`barry workers invite\``);
    this.name = "WorkerCredentialRejected";
  }
}

const errorBody = z.object({ code: z.string().optional(), message: z.string().optional(), error: z.string().optional(), retryable: z.boolean().optional() }).passthrough();

/**
 * One request to a workflow owner's worker endpoint.
 *
 * The owner identifies the worker from the credential, never from the body,
 * so the body is only the protocol request. A rejected credential is a
 * distinct error the activity worker stops on rather than retrying.
 */
export function ownerCall(url: string, credential: string, options: { timeoutMs?: number; fetch?: typeof fetch } = {}): (request: unknown) => Promise<unknown> {
  const endpoint = `${url.replace(/\/$/, "")}/api/worker`;
  const send = options.fetch ?? fetch;
  return async request => {
    const response = await send(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ request }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    if (response.status === 401 || response.status === 403) throw new WorkerCredentialRejected(response.status);
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 500);
      try { const body = errorBody.parse(JSON.parse(text)); detail = body.message ?? body.error ?? detail; } catch { /* not JSON */ }
      throw new Error(`workflow owner ${endpoint} answered HTTP ${response.status}: ${detail}`);
    }
    return JSON.parse(text) as unknown;
  };
}
