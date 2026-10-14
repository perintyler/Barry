import { z } from "zod";
import type BetterSqlite3 from "better-sqlite3";

const InstancesSchema = z.array(z.strictObject({
  id: z.number().int().positive(), session_id: z.string().min(1),
  pid: z.number().int().nullable(), pid_started_at: z.number().finite().nullable(),
  hostname: z.string().nullable(), started_at: z.string().min(1),
}));
type Intent = { session_id: string; id: number; action: "close" | "delete"; target_path: string; instances: string; ended_at: string };

export function installProcessCleanup(source: BetterSqlite3.Database, control: () => BetterSqlite3.Database): void {
  if (source === control()) return;
  source.table("barry_process_instances", {
    columns: ["target_path", "instance"], parameters: ["session_id", "action"],
    rows: function* (sessionId, action) {
      if (typeof sessionId !== "string" || !["close", "delete"].includes(String(action))) throw new Error("Invalid process cleanup capture");
      const target = control();
      const statement = target.prepare(`SELECT id,session_id,pid,pid_started_at,hostname,started_at FROM processes WHERE session_id=? ${action === "close" ? "AND ended_at IS NULL" : ""} ORDER BY id`);
      for (const instance of statement.iterate(sessionId)) yield [target.name, JSON.stringify(instance)];
    },
  });
  // Connection-local triggers cover native and Kysely writes without requiring
  // a custom table function in offline migration/inspection tools.
  source.exec(`
    CREATE TEMP TRIGGER barry_capture_process_close BEFORE UPDATE OF active,ended_at,state ON main.sessions
    WHEN (NEW.active=0 AND OLD.active IS NOT 0) OR (NEW.ended_at IS NOT NULL AND OLD.ended_at IS NULL)
      OR (NEW.state != 'open' AND OLD.state IS NOT NEW.state)
    BEGIN
      INSERT INTO process_cleanup_intents(session_id,user_id,identity_id,action,target_path,instances,ended_at)
      SELECT OLD.id,OLD.user_id,OLD.identity_id,'close',target_path,json_array(json(instance)),
             COALESCE(NEW.ended_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      FROM barry_process_instances(OLD.id,'close');
    END;
    CREATE TEMP TRIGGER barry_capture_process_delete BEFORE DELETE ON main.sessions
    BEGIN
      INSERT INTO process_cleanup_intents(session_id,user_id,identity_id,action,target_path,instances,ended_at)
      SELECT OLD.id,OLD.user_id,OLD.identity_id,'delete',target_path,json_array(json(instance)),
             strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM barry_process_instances(OLD.id,'delete');
    END;
  `);
}

export function drainProcessCleanup(source: BetterSqlite3.Database, control: BetterSqlite3.Database, limit = 64, afterId = 0, onlyId?: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Process cleanup limit must be between 1 and 1000");
  if (!Number.isSafeInteger(afterId) || afterId < 0) throw new RangeError("Process cleanup cursor must be a nonnegative integer");
  if (onlyId !== undefined && (!Number.isSafeInteger(onlyId) || onlyId < 1)) throw new RangeError("Invalid process cleanup intent ID");
  // An outer Session transaction may still roll back. Apply only committed intents.
  if (source.inTransaction || control.inTransaction) return 0;
  const headers = source.prepare("SELECT id,json_array_length(instances) AS count,length(CAST(instances AS BLOB)) AS bytes FROM process_cleanup_intents WHERE id>? AND (? IS NULL OR id=?) ORDER BY id LIMIT ?")
    .all(afterId, onlyId ?? null, onlyId ?? null, limit) as { id: number; count: number; bytes: number }[];
  let applied = 0;
  for (const header of headers) {
    if (header.count > 1) { normalizeProcessCleanupIntent(source, header.id); continue; }
    if (header.bytes > 1024 * 1024) throw new Error("Process cleanup instance exceeds the replay limit");
    const intent = source.prepare("SELECT id,session_id,action,target_path,instances,ended_at FROM process_cleanup_intents WHERE id=?").get(header.id) as Intent | undefined;
    if (!intent) continue;
    if (intent.target_path !== control.name) throw new Error("Process cleanup target differs from the recorded control store");
    const instances = InstancesSchema.parse(JSON.parse(intent.instances));
    if (instances.some(instance => instance.session_id !== intent.session_id)) throw new Error("Process cleanup instance differs from its recorded Session");
    if (!["close", "delete"].includes(intent.action) || !Number.isFinite(Date.parse(intent.ended_at))) throw new Error("Invalid process cleanup operation");
    const predicate = "id=? AND session_id=? AND pid IS ? AND pid_started_at IS ? AND hostname IS ? AND started_at=?";
    control.transaction(() => {
      const statement = control.prepare(intent.action === "delete" ? `DELETE FROM processes WHERE ${predicate}`
        : `UPDATE processes SET ended_at=?,liveness_reason=COALESCE(liveness_reason,'session-ended') WHERE ${predicate} AND ended_at IS NULL`);
      for (const instance of instances) {
        const binding = [instance.id, instance.session_id, instance.pid, instance.pid_started_at, instance.hostname, instance.started_at];
        statement.run(...(intent.action === "close" ? [intent.ended_at, ...binding] : binding));
      }
    }).immediate();
    // Reapplying after an interrupted acknowledgement is safe: every mutation
    // matches the captured instance, never the Session's current process.
    source.prepare("DELETE FROM process_cleanup_intents WHERE id=?").run(intent.id);
    applied++;
  }
  return applied;
}

export function normalizeProcessCleanupIntent(source: BetterSqlite3.Database, id: number): number {
  if (!Number.isSafeInteger(id) || id < 1) throw new RangeError("Invalid process cleanup intent ID");
  if (source.inTransaction) return 0;
  return source.transaction(() => {
    const count = source.prepare(`INSERT INTO process_cleanup_intents(session_id,user_id,identity_id,action,target_path,instances,ended_at,created_at)
      SELECT original.session_id,original.user_id,original.identity_id,original.action,original.target_path,
        CASE item.type WHEN 'object' THEN json_array(json(item.value)) WHEN 'array' THEN json_array(json(item.value))
          WHEN 'true' THEN '[true]' WHEN 'false' THEN '[false]' ELSE json_array(item.value) END,
        original.ended_at,original.created_at
      FROM process_cleanup_intents AS original,json_each(original.instances) AS item
      WHERE original.id=? AND json_type(original.instances)='array' AND json_array_length(original.instances)>1`).run(id).changes;
    if (count > 0) source.prepare("DELETE FROM process_cleanup_intents WHERE id=?").run(id);
    return count;
  }).immediate();
}
