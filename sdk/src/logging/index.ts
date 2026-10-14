/**
 * Logging for anything Barry runs: the Node emitter, and the line format it
 * writes and the logs bag reads back.
 *
 * Part of the kit, not of the logs bag: every bag and service writes log
 * lines, and a bag that only wants to write one should not depend on the bag
 * that collects and stores them. The logs bag keeps the store; Workers code
 * uses `@barry-rocks/sdk/logging/edge`.
 */
export { LEVEL, type LevelName, type LogRow, parseLine, redact, CTX_OMIT } from "./format.js";
export {
  createLogger,
  redactContext,
  flushAll,
  setupGracefulShutdown,
  type Logger,
  type LogContext,
  type LogLevel,
  type CreateLoggerOptions,
} from "./emit.js";
