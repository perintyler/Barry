/**
 * The one error `Barry` throws when it refuses: why (`reason`), what happened
 * (`message`) and, when there is one, what to do (`hint`). The terminal prints
 * it; an HTTP route answers its status; nothing else has to unwrap a result.
 */
export type BarryErrorReason = "invalid" | "forbidden" | "not_found" | "conflict" | "unavailable";

const STATUS = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503 } as const;

export class BarryError extends Error {
  readonly reason: BarryErrorReason;
  readonly hint: string | undefined;

  constructor(reason: BarryErrorReason, message: string, hint?: string) {
    super(message);
    this.name = "BarryError";
    this.reason = reason;
    this.hint = hint;
  }

  /** The HTTP status a route answers with. */
  get status(): 400 | 403 | 404 | 409 | 503 {
    return STATUS[this.reason];
  }

  /** The body a route answers with: the problem, and its hint when there is one. */
  toJSON(): { error: string; reason: BarryErrorReason; hint?: string } {
    return { error: this.message, reason: this.reason, ...(this.hint ? { hint: this.hint } : {}) };
  }
}

export function isBarryError(error: unknown): error is BarryError {
  return error instanceof BarryError || (
    error instanceof Error
    && error.name === "BarryError"
    && "reason" in error
    && typeof error.reason === "string"
    && Object.hasOwn(STATUS, error.reason)
  );
}
