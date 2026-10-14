import { LEVEL, redact } from "./format.js";
import type { Logger, LogLevel, LogContext } from "./emit.js";

/** Self-contained child bundles write shared structured fields directly to stderr. */
export function createBootstrapLogger(service: string, baseContext: LogContext = {}): Logger {
  const write = (level: LogLevel, msg: string, context: LogContext = {}) => {
    process.stderr.write(JSON.stringify({
      ...redact({ ...baseContext, ...context }),
      level: LEVEL[level], time: Date.now(), name: service, service, msg,
    }) + "\n");
  };
  return {
    debug: (msg, context) => write("debug", msg, context),
    info: (msg, context) => write("info", msg, context),
    warn: (msg, context) => write("warn", msg, context),
    error: (msg, context) => write("error", msg, context),
    child: context => createBootstrapLogger(service, { ...baseContext, ...context }),
    flush: async () => {},
  };
}
