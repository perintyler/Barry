/** Interpreter names for native shorthand and hooks; action JS/TS entries use the shared launch resolver. */

import { extname } from "path";

/** The interpreter for `scriptPath`, or null when the file should be executed as-is. */
export function interpreterFor(scriptPath: string): string | null {
  switch (extname(scriptPath)) {
    case ".sh":
      return "bash";
    case ".ts":
    case ".mts":
      // Native TS hook shorthand resolves tsx through the session PATH.
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "node";
    default:
      return null;
  }
}
