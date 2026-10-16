/** Workers emit the shared structured log format through their native console sink, without Node transports. See docs/decisions/0001-shared-log-format.md. */

import { LEVEL, redact, type LevelName } from "./format.js";
import type { Logger, LogLevel, LogContext } from "./emit.js";

export type { Logger, LogLevel, LogContext };

export interface WorkerLoggerEnv {
  [binding: string]: unknown;
}

interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface WorkerLoggerOptions {
  /** Worker env bindings. */
  env?: WorkerLoggerEnv;
  /** Worker context — a remote sink would flush through waitUntil. */
  ctx?: CloudflareExecutionContext;
}

/**
 * Create a logger for a Cloudflare Worker.
 *
 * @example
 * ```ts
 * import { createWorkerLogger } from "./emit-edge.js";
 *
 * export default {
 *   async fetch(request: Request, env: Env, ctx: CloudflareExecutionContext) {
 *     const log = createWorkerLogger("artifacts", { env, ctx });
 *     log.info("request.start", { path: new URL(request.url).pathname });
 *     await log.flush();
 *     return response;
 *   }
 * };
 * ```
 */
export function createWorkerLogger(
  service: string,
  options: WorkerLoggerOptions = {},
  baseContext: LogContext = {},
): Logger {
  function log(level: LogLevel, msg: string, context: LogContext = {}): void {
    const merged = { ...baseContext, ...context };
    const safe = redact(merged);

    // Numeric levels and millisecond `time` match the shared log parser.
    // Rationale: docs/decisions/0022-sdk-auth-and-logging-invariants.md.
    const entry = {
      level: LEVEL[level as LevelName],
      time: Date.now(),
      name: service,
      service,
      msg,
      ...safe,
    };

    const out = JSON.stringify(entry);
    if (level === "error") console.error(out);
    else if (level === "warn") console.warn(out);
    else console.log(out);
  }

  const logger: Logger = {
    debug: (msg, context) => log("debug", msg, context),
    info: (msg, context) => log("info", msg, context),
    warn: (msg, context) => log("warn", msg, context),
    error: (msg, context) => log("error", msg, context),
    child: (context) => createWorkerLogger(service, options, { ...baseContext, ...context }),
    // console.* is synchronous in Workers, so there is nothing to drain.
    flush: async () => {},
  };

  return logger;
}
