import { connectLocal } from "@barry-rocks/sdk/internal/client";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";

export const TRACKER_RETENTION_DAYS = 90;
type SessionClosure = { id: string; status: string; pinned: boolean; endedAt?: string | null };

/** Unknown, live, pinned or recently ended sessions never qualify. */
export async function pruneChanges(
  getSession: (id: string) => Promise<SessionClosure | null>,
  now = Date.now(),
): Promise<{ removed: number; checked: number; kept: number }> {
  if (!Number.isFinite(now)) throw new Error("Invalid retention time");
  const db = getDb();
  const cutoff = new Date(now - TRACKER_RETENTION_DAYS * 86_400_000).toISOString();
  const cursor = (db.prepare("SELECT cursor FROM tracker_retention WHERE singleton=1").get() as { cursor: string }).cursor;
  const candidates = db.prepare("SELECT DISTINCT session_id FROM changes WHERE session_id > ? AND julianday(created_at) <= julianday(?) ORDER BY session_id LIMIT 100").all(cursor, cutoff) as { session_id: string }[];
  const eligible: string[] = [];
  for (const { session_id } of candidates) {
    try {
      const session = await getSession(session_id);
      const ended = session?.endedAt ? Date.parse(session.endedAt) : NaN;
      if (session?.id === session_id && session.pinned === false && ["completed", "failed", "cancelled"].includes(session.status) && Number.isFinite(ended) && ended <= Date.parse(cutoff)) eligible.push(session_id);
    } catch { /* Missing or unreadable closure evidence retains history. */ }
  }
  const removed = db.transaction(() => {
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='changes_are_append_only_delete'").get() as { sql: string } | undefined;
    if (!trigger?.sql) throw new Error("Missing tracker append-only delete guard");
    let count = 0;
    if (eligible.length) {
      db.exec("DROP TRIGGER changes_are_append_only_delete");
      const remove = db.prepare("DELETE FROM changes WHERE id IN (SELECT id FROM changes WHERE session_id=? AND julianday(created_at) <= julianday(?) ORDER BY id LIMIT 1000)");
      for (const id of eligible) count += remove.run(id, cutoff).changes;
      db.exec(trigger.sql);
    }
    db.prepare("UPDATE tracker_retention SET cursor=? WHERE singleton=1").run(candidates.length === 100 ? candidates.at(-1)!.session_id : "");
    return count;
  }).immediate();
  // New databases support incremental compaction. Legacy databases reuse freed
  // pages; converting them requires an explicit, potentially expensive VACUUM.
  if (removed) db.pragma("incremental_vacuum(256)");
  return { removed, checked: candidates.length, kept: candidates.length - eligible.length };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const client = await connectLocal();
  process.stdout.write(JSON.stringify(await pruneChanges(id => client.sessions.get(id))) + "\n");
}
