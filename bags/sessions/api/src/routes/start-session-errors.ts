import { isBarryError } from "@barry-rocks/sdk";
import { ZodError } from "zod";

/**
 * Does this error describe a bad request rather than a server fault?
 *
 * `POST /sessions/start` used to answer every thrown error with 400, so a
 * transient store failure read as a client bug and leaked the raw message
 * (SQL text, paths). The two classes that are genuinely the caller's fault are
 * a schema rejection (`ZodError`) and a `BarryError` the SDK marks `invalid`
 * (an unknown bound, a malformed selection). Everything else — a store that is
 * down, an unexpected throw — is the server's and belongs in a 500 so a
 * supervisor and the caller can tell the two apart.
 *
 * `forbidden`/`not_found` BarryErrors never reach the start try/catch: the
 * route authorizes before calling `startSession`, so they are intentionally
 * not treated as validation here.
 */
export function isStartValidationError(error: unknown): boolean {
  if (error instanceof ZodError) return true;
  if (isBarryError(error) && error.reason === "invalid") return true;
  return false;
}
