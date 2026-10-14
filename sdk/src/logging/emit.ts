/** Node structured logging shares parsing and redaction with the Workers emitter. See docs/decisions/0001-shared-log-format.md. */

import pino from "pino";
import { redact } from "./format.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, context?: LogContext): void;
  info(msg: string, context?: LogContext): void;
  warn(msg: string, context?: LogContext): void;
  error(msg: string, context?: LogContext): void;
  child(context: LogContext): Logger;
  flush(): Promise<void>;
}

const STDOUT_ENABLED = process.env.ENABLE_LOCAL_LOGS !== undefined
  ? process.env.ENABLE_LOCAL_LOGS === "1" || process.env.ENABLE_LOCAL_LOGS === "true"
  : true;

/**
 * Redact values whose keys look like secrets before they reach a log sink.
 *
 * Re-exported from `format.ts`, where the single definition lives. The name is
 * kept for the consumers that import it directly.
 */
export { redact as redactContext } from "./format.js";

function createLoggerImpl(
  service: string,
  baseContext: LogContext = {},
  options?: CreateLoggerOptions,
): Logger {
  const transport = options?.transport ?? (STDOUT_ENABLED ? "stdout" : "silent");

  const pinoLogger = pino({
    name: service,
    level: transport === "silent" ? "silent" : (process.env.LOG_LEVEL || "info"),
    base: { service, ...baseContext },
    timestamp: pino.stdTimeFunctions.isoTime,
  }, transport === "stderr" ? pino.destination(2) : undefined);

  return wrapPino(pinoLogger, service, baseContext);
}

/**
 * Wrap a pino instance in the SDK's Logger interface.
 *
 * `child()` calls `pinoLogger.child()` rather than constructing a fresh `pino()`
 * per child: a new instance per child opens its own destination and is costly,
 * and the point of a child is to inherit the parent's sink and level.
 */
function wrapPino(pinoLogger: pino.Logger, service: string, baseContext: LogContext): Logger {
  const log = (level: LogLevel, msg: string, context: LogContext = {}): void => {
    const mergedContext = { ...baseContext, ...context };

    pinoLogger[level](redact(mergedContext), msg);
  };

  return {
    debug: (msg, context) => log("debug", msg, context),
    info: (msg, context) => log("info", msg, context),
    warn: (msg, context) => log("warn", msg, context),
    error: (msg, context) => log("error", msg, context),
    child: (context) =>
      wrapPino(pinoLogger.child(redact(context)), service, { ...baseContext, ...context }),
    flush: async () => {},
  };
}

export interface CreateLoggerOptions {
  /**
   * Where to send pino output:
   * - "stdout" (default): writes JSON logs to stdout
   * - "stderr": writes JSON logs to stderr (use for MCP servers where stdout is reserved)
   * - "silent": no output
   */
  transport?: "stdout" | "stderr" | "silent";
}

/**
 * Create a logger for a service
 *
 * @param service - The service name (e.g., "web", "slack")
 * @param options - Optional configuration
 * @returns A Logger instance
 *
 * @example
 * ```typescript
 * import { createLogger } from "./index.js";
 *
 * const log = createLogger("my-service");
 * log.info("Server started", { port: 3000 });
 * log.error("Request failed", { error: err.message, requestId: "abc" });
 *
 * // For MCP servers (stdout reserved for protocol):
 * const log = createLogger("mcp-barry", { transport: "stderr" });
 *
 * // Flush on shutdown
 * process.on("SIGTERM", async () => {
 *   await log.flush();
 *   process.exit(0);
 * });
 * ```
 */
export function createLogger(service: string, options?: CreateLoggerOptions): Logger {
  return createLoggerImpl(service, {}, options);
}

/**
 * Flush all pending logs before process exit.
 *
 * A no-op since the Axiom transport was removed: pino writes to stdout
 * synchronously, so there is nothing buffered to drain. Kept because
 * `setupGracefulShutdown` awaits it and services call that — and because a
 * future async sink would need exactly this hook back.
 */
export async function flushAll(): Promise<void> {}

/**
 * Setup graceful shutdown for a server with proper log flushing
 *
 * @param server - The HTTP server to close on shutdown
 * @param log - Logger instance for shutdown logging
 * @param options - Optional configuration
 */
export function setupGracefulShutdown(
  server: { close: (callback?: (err?: Error) => void) => void },
  log: Logger,
  options: { forceExitTimeout?: number; onShutdown?: () => Promise<void> } = {}
): void {
  const { forceExitTimeout = 10000, onShutdown } = options;

  async function shutdown(signal: string): Promise<void> {
    log.info("server.shutdown", { signal });
    server.close(async () => {
      await Promise.all([flushAll(), onShutdown?.()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), forceExitTimeout);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
