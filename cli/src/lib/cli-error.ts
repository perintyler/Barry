/**
 * The error a command body throws instead of calling `process.exit(n)` (CLI-14).
 *
 * A thrown error unwinds through every `finally` and reaches the one handler in
 * `main.ts`, which sets the process exit code. A `process.exit()` in a command
 * body skips that cleanup and forces the test for that command to spawn a child
 * just to observe the code. `CliError` carries the exit code the command meant,
 * defaulting to 1.
 */
export class CliError extends Error {
  constructor(message: string, readonly exitCode: number = 1) {
    super(message);
    this.name = "CliError";
  }
}

/** True for an error a command raised deliberately, with an exit code to honour. */
export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}
