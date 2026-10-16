import { CliError } from "../lib/cli-error.js";

/** Bound even injected transports that do not implement AbortSignal. */
export async function apiRequest(request: typeof fetch, url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(url, { ...init, signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DOMException("API request timed out", "TimeoutError")), timeoutMs);
      }),
    ]);
  } catch (error) {
    throw new ApiRequestError(url, error, timeoutMs);
  } finally { if (timer) clearTimeout(timer); }
}

export function apiFailure(url: string, error: unknown, timeoutMs = 5000): string {
  if (error instanceof ApiRequestError) return error.message;
  const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
  const location = new URL(url).origin;
  return timeout
    ? `Barry's API did not answer within ${timeoutMs / 1000} s at ${location} — run: barry status / barry up`
    : `Could not reach Barry's API at ${location}: ${error instanceof Error ? error.message : String(error)} — run: barry status / barry up`;
}

export class ApiRequestError extends CliError {
  constructor(url: string, error: unknown, timeoutMs: number) {
    super(apiFailure(url, error, timeoutMs), 1);
  }
}
