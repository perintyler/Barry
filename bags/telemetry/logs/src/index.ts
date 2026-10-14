// Logging writers depend on the shared format; collection belongs to the parent bag.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-001
export { RETENTION_DAYS, logsDbPath, openLogsDb, prune, type Db } from "./store.js";
