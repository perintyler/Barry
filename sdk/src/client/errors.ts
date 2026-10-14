/**
 * Why a call to Barry's API did not produce a result.
 *
 * `status` is the HTTP status once response headers arrive, and null before
 * then. A deadline or cancellation can interrupt an unfinished response body.
 * `code` is the machine-readable reason: the actions routes' `error` field, or
 * one of this client's own ("unreachable", "timeout", "cancelled", "invalid_request",
 * "malformed_response", "credential_error", "service_unconfigured", "invalid_pagination", "http_<status>").
 */
export class BarryApiError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly detail: unknown;
  readonly requestId: string | undefined;

  constructor(message: string, options: { status: number | null; code: string; detail?: unknown; requestId?: string }) {
    super(message);
    this.name = "BarryApiError";
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail;
    this.requestId = options.requestId;
  }
}
