/**
 * The engine vocabulary.
 *
 * What an adapter asks for and what it gets back live in the SDK, where both
 * the adapter and this bag can reach them — neither may depend on the other.
 * What is recorded about a running engine is this bag's alone.
 */
import type { EngineSpec } from "@barry-rocks/sdk/adapters/harnesses";

export type { EngineHandle, EngineSpec, StartEngine } from "@barry-rocks/sdk/adapters/harnesses";

export type EngineTransport = EngineSpec["transport"];

/**
 * A running engine, as recorded.
 *
 * `address` is the whole address rather than a port, because half the engines
 * do not have one — a `port` column would be null for codex and would not say
 * what to do with opencode's.
 */
export interface EngineRecord {
  sessionId: string;
  kind: string;
  address: string;
  pid: number | null;
  pidStartedAt: number | null;
  /** The build observed once the engine answered, for. */
  version: string | null;
  /**
   * WHICH secret, never the secret. A password in a database row is a password
   * in every backup and debug dump of that row.
   */
  passwordRef: string | null;
  startedAt: string;
  stoppedAt: string | null;
}
