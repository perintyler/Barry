import { ModelUnavailableError } from "../adapters/models/kinds.js";

/**
 * Classify the wrapper’s abort as timeout, verified connection failures as unreachable, and other fetch errors without inventing a cause.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 */
export function describeFetchFailure(err: unknown, url: string, timeoutMs: number): string {
  if (err instanceof Error && err.name === "AbortError") {
    return `Request to ${url} timed out after ${timeoutMs}ms — the backend may be loading a model or busy; this is NOT proof it is down.`;
  }
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
    return `Backend unreachable at ${url} (${code}).`;
  }
  const detail = err instanceof Error ? err.message : String(err);
  return `Request to ${url} failed: ${detail}`;
}

export interface JsonRequest {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Turns a non-OK response into a message. Return undefined to fall through
   * to the generic one. Lets an adapter name its own setup problems — a 404
   * from Ollama means "run `ollama pull`", a 401 from a hosted API means the
   * key is wrong — while the transport stays shared.
   */
  describeHttpError?: (status: number, body: string, headers?: Headers) => string | undefined;
  /**
   * Statuses that mean the backend cannot serve at all, so a sweep should stop
   * rather than retry per item. Anything else raises an ordinary Error.
   */
  unavailableStatuses?: number[];
}

/**
 * POST JSON and parse the reply, with one timeout and honest failure
 * attribution.
 *
 * Every vendor speaks HTTP+JSON, and each one had grown its own
 * AbortController/timer/try-catch. The duplication is not just lines: it is
 * three chances to get the diagnostic wrong in different ways.
 */
export async function postJson<T>(opts: JsonRequest): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    }, { once: true });
  });

  let headersReceived = false;
  try {
    const res = await Promise.race([fetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    }), timeout]);
    headersReceived = true;

    if (!res.ok) {
      let text = "";
      try {
        text = await Promise.race([res.text(), timeout]);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw error;
        }
      }
      const described = opts.describeHttpError?.(res.status, text, res.headers);
      const message = described ?? `HTTP ${res.status} from ${opts.url}: ${text.slice(0, 200)}`;
      if (described !== undefined || (opts.unavailableStatuses ?? []).includes(res.status)) {
        throw new ModelUnavailableError(message);
      }
      throw new Error(message);
    }

    return await Promise.race([res.json() as Promise<T>, timeout]);
  } catch (err) {
    if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new ModelUnavailableError(describeFetchFailure(err, opts.url, opts.timeoutMs), err);
    }
    // Preserve response parsing and adapter-classified HTTP errors. Only a
    // failure before headers is a transport failure owned by this wrapper.
    if (headersReceived) throw err;
    throw new ModelUnavailableError(describeFetchFailure(err, opts.url, opts.timeoutMs), err);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}
