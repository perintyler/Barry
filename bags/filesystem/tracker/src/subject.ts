import { Barry, BarryError, isBarryError, type Caller, type Change, type Tracker } from "@barry-rocks/sdk";
import { getChangesForSession, getLastChanges, type Change as ChangeRow } from "./index.js";

/** A recorded change as `Barry` answers it. SQLite writes UTC without a zone. */
function changeOf(row: ChangeRow, sessionId: string | null): Change {
  return {
    sessionId,
    path: row.file_path,
    at: new Date(row.created_at.replace(" ", "T") + (row.created_at.endsWith("Z") ? "" : "Z")).toISOString(),
    tool: row.tool,
  };
}

/**
 * The sessions among these the caller may know of. The tracker is one store
 * for the whole node, so a file's last change can be another identity's: the
 * owner sees every session, a session only its own identity's.
 */
async function known(sessionIds: ReadonlySet<string>, caller: Exclude<Caller, { kind: "device" }>): Promise<ReadonlySet<string>> {
  if (caller.kind === "owner") return sessionIds;
  const identity = Barry.as(caller).identity(caller.identity);
  const seen = await Promise.all([...sessionIds].map(async (id) => {
    if (id === caller.sessionId) return id;
    try {
      await identity.session(id).get();
      return id;
    } catch (error) {
      if (isBarryError(error) && (error.reason === "not_found" || error.reason === "forbidden")) return null;
      throw error;
    }
  }));
  return new Set(seen.filter((id) => id !== null));
}

export const tracker: Tracker = {
  name: "tracker",
  async lastChanges(paths, caller) {
    if (caller.kind === "device") throw new BarryError("forbidden", "A device may not read the last change to a file");
    const rows = getLastChanges([...paths]);
    const shown = await known(new Set(rows.map((row) => row.session_id)), caller);
    // A change by a session the caller may not see is kept without its session,
    // so the file still reads as someone else's rather than as nobody's.
    return rows.map((row) => changeOf(row, shown.has(row.session_id) ? row.session_id : null));
  },
  async changes(identity, sessionId, caller) {
    await Barry.as(caller).identity(identity).session(sessionId).get();
    return getChangesForSession(sessionId).map((row) => changeOf(row, row.session_id));
  },
};
