/**
 * Use the SDK structured emitter by default and retain an injectable logger factory for tests.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 */
import { createLogger } from "../logging/index.js";

/** Arbitrary structured context attached to a log line. */
export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(msg: string, context?: LogContext): void;
  info(msg: string, context?: LogContext): void;
  warn(msg: string, context?: LogContext): void;
  error(msg: string, context?: LogContext): void;
  child(context: LogContext): Logger;
  flush(): Promise<void>;
}

export interface CreateLoggerOptions {
  /**
   * Where to write. The MCP server MUST pass "stderr": stdout is reserved for
   * the MCP protocol there, so request logs written to it are both invisible
   * in the service's error log and mixed into a stream a client is parsing.
   */
  transport?: "stdout" | "stderr" | "silent";
}

export type CreateLogger = (service: string, options?: CreateLoggerOptions) => Logger;

let createLoggerImpl: CreateLogger | null = null;

/** Replace the logger factory, as a test does to record what is logged. */
export function setLoggerFactory(factory: CreateLogger): void {
  createLoggerImpl = factory;
}

/** The installed factory, or the kit's emitter. */
export function getLoggerFactory(): CreateLogger {
  return createLoggerImpl ?? createLogger;
}
