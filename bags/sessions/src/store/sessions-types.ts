/**
 * Kysely types for the sessions store (SQLite).
 *
 * Three representation rules:
 *
 * - JSON columns are TEXT holding JSON. Callers parse; the store does not.
 * - booleans are INTEGER 0/1. SQLite has no boolean type.
 * - timestamps are TEXT in ISO-8601. Stored UTC with an explicit Z so string
 *   comparison is also chronological comparison, which is what the paging
 *   cursor relies on.
 *
 * `sessions-schema-drift.test.ts` asserts these match the live SQLite schema
 * bidirectionally.
 */
import type { Generated } from "kysely";

export interface SessionsStoreSessionsTable {
  id: string;
  user_id: number | null;
  agent_token: string | null;
  identity_id: number | null;
  workflow_credential_id: string | null;
  active: Generated<number>;
  state: Generated<string>;
  status: Generated<string>;
  system_prompt: string | null;
  summary: string | null;
  bags: Generated<string>;
  bounds: Generated<string>;
  bound: string | null;
  metadata: Generated<string>;
  created_at: Generated<string>;
  started_at: string | null;
  completed_at: string | null;
  ended_at: string | null;
  last_message_at: string | null;
  message_count: Generated<number>;
}

export interface SessionsStoreMessagesTable {
  id: string;
  session_id: string | null;
  provider_session_id: string | null;
  type: string;
  sequence: Generated<number>;
  role: string | null;
  content: string | null;
  name: string | null;
  input: string | null;
  result: string | null;
  metadata: Generated<string>;
  content_text: string | null;
  created_at: Generated<string>;
  model_id: number | null;
  /** Which of the five capture routes this row arrived on (migration 006). */
  channel: string | null;
  /** How to recognise this row again within its session (migration 006). */
  dedupe_key: string | null;
}

export interface SessionsStoreProviderSessionsTable {
  id: Generated<number>;
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  created_at: Generated<string>;
  /** Null while the provider session is live; set when it ends, not on every update. */
  ended_at: string | null;
}

/**
 * The models catalog (migration 003).
 *
 * Lives here rather than in config.db because `messages.model_id` is its only
 * consumer, and that column is in this store — see 003_models_registry.ts.
 */
export interface SessionsStoreProvidersTable {
  /**
   * `Generated<number>` so SELECTs see a plain `number` while INSERTs may omit
   * it: `resolveModelId` creates a discovered row without an id and lets
   * SQLite assign max(id)+1 for the INTEGER PRIMARY KEY.
   *
   * The importer, by contrast, supplies ids EXPLICITLY, and must keep doing
   * so. Production ids are sparse (providers 1..6, 10, 13, 51) and
   * `messages.model_id` holds 107,108 references to them, so letting SQLite
   * assign them on import would repoint every message at the wrong model —
   * attribution that still resolves and is simply wrong. Generated permits
   * the explicit id; it does not excuse omitting it there.
   */
  id: Generated<number>;
  key: string;
  label: string;
  /** INTEGER 0/1, not boolean — SQLite has no boolean type. */
  enabled: Generated<number>;
  /** TEXT holding JSON; the jsonColumnPlugin serializes objects bound here. */
  metadata: unknown;
  created_at: Generated<string>;
}

export interface SessionsStoreModelsTable {
  /** See SessionsStoreProvidersTable.id — the importer supplies these explicitly. */
  id: Generated<number>;
  provider_id: number;
  /** AgentId-scoped model id; unique per provider, not globally. */
  model_id: string;
  label: string;
  metadata: unknown;
  created_at: Generated<string>;
}

export interface SessionsStoreProcessesTable {
  id: Generated<number>;
  session_id: string;
  pid: number | null;
  pid_started_at: number | null;
  hostname: string | null;
  process_name: string | null;
  command: string | null;
  app_name: string | null;
  parent_pid: number | null;
  source: string | null;
  started_at: Generated<string>;
  ended_at: string | null;
  last_checked_at: string | null;
  liveness: "alive" | "dead" | "unknown" | null;
  liveness_reason: string | null;
}

export interface SessionsStoreProcessCleanupIntentsTable {
  id: Generated<number>;
  session_id: string;
  user_id: number | null;
  identity_id: number | null;
  action: "close" | "delete";
  target_path: string;
  instances: string;
  ended_at: string;
  created_at: Generated<string>;
}

export interface SessionsStoreDatabase {
  sessions: SessionsStoreSessionsTable;
  messages: SessionsStoreMessagesTable;
  provider_sessions: SessionsStoreProviderSessionsTable;
  providers: SessionsStoreProvidersTable;
  models: SessionsStoreModelsTable;
  processes: SessionsStoreProcessesTable;
  process_cleanup_intents: SessionsStoreProcessCleanupIntentsTable;
}

/**
 * Mirrors the interfaces above for the drift test. TS types are erased at
 * runtime, so the test needs a runtime value to compare against the live
 * schema — the same reason ./types.ts carries TABLE_COLUMNS.
 */
export const SESSIONS_STORE_COLUMNS: Record<keyof SessionsStoreDatabase, readonly string[]> = {
  sessions: [
    "id", "user_id", "agent_token", "identity_id", "workflow_credential_id", "active", "state", "status",
    "system_prompt", "summary", "bags", "bounds", "bound", "metadata",
    "created_at", "started_at", "completed_at", "ended_at", "last_message_at",
    "message_count",
  ],
  messages: [
    "id", "session_id", "provider_session_id", "type", "sequence", "role",
    "content", "name", "input", "result", "metadata", "content_text",
    "created_at", "model_id", "dedupe_key", "channel",
  ],
  provider_sessions: [
    "id", "session_id", "provider", "provider_session_id", "created_at", "ended_at",
  ],
  providers: [
    "id", "key", "label", "enabled", "metadata", "created_at",
  ],
  models: [
    "id", "provider_id", "model_id", "label", "metadata", "created_at",
  ],
  process_cleanup_intents: ["id", "session_id", "user_id", "identity_id", "action", "target_path", "instances", "ended_at", "created_at"],
  processes: [
    "id", "session_id", "pid", "pid_started_at", "hostname", "process_name",
    "command", "app_name", "parent_pid", "source", "started_at", "ended_at",
    "last_checked_at", "liveness", "liveness_reason",
  ],
} as const;
