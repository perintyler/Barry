import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { getSessionsSqlite, closeSessionsDb, sessionsDbPath } from "./sessions-db.js";
import { listSessions, getLatestActivityBySessions } from "../client/index.js";

let home: string;
let owned: string;
let foreign: string;
beforeEach(() => {
  closeSessionsDb();
  home = mkdtempSync(join(tmpdir(), "barry-physical-session-access-"));
  vi.stubEnv("BARRY_HOME", home);
  vi.stubEnv("BARRY_SESSIONS_DB", "");
  mkdirSync(barryStoresDir(), { recursive: true });
  writeFileSync(join(barryStoresDir(), "active.json"), JSON.stringify({ id: "access-test" }));
  const nodes = new NodeRegistry();
  try { owned = nodes.identityId(11); foreign = nodes.identityId(12); }
  finally { nodes.close(); }
  const seed = (id: string, actor: number, identity: number, activity: string | null) => {
    getSessionsSqlite().prepare("INSERT INTO sessions (id,user_id,identity_id,created_at,last_message_at,message_count,metadata) VALUES (?,?,?,'2026-01-01T00:00:00.000Z',?,1,'{}')").run(id, actor, identity, activity);
  };
  seed("catalog-old", 7, 11, null);
  withStoreContext({ identity: owned }, () => {
    seed("a", 7, 11, "2026-03-01T00:00:00.000Z");
    seed("b", 7, 11, "2026-03-01T00:00:00.000Z");
    seed("wrong-user", 8, 11, "2026-04-01T00:00:00.000Z");
  });
  withStoreContext({ identity: foreign }, () => seed("foreign", 8, 12, "2026-05-01T00:00:00.000Z"));
});
afterEach(() => {
  closeSessionsDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
describe("physical session access", () => {
  it("filters one identity before paging and never opens another partition", async () => {
    const foreignPath = withStoreContext({ identity: foreign }, () => sessionsDbPath());
    closeSessionsDb();
    writeFileSync(foreignPath, "corrupt other identity store");
    const first = await listSessions({ identityId: 11, orderBy: "activity", limit: 2 });
    expect(first.map(row => row.id)).toEqual(["wrong-user", "b"]);
    const last = first[1];
    const second = await listSessions({ identityId: 11, orderBy: "activity", limit: 2, before: { createdAt: last.created_at, id: last.id, lastMessageAt: last.last_message_at } });
    expect(second.map(row => row.id)).toEqual(["a", "catalog-old"]);
  });

  it("keeps global activity pages and enrichment within granted stores even if another store is corrupt", async () => {
    const foreignPath = withStoreContext({ identity: foreign }, () => sessionsDbPath());
    closeSessionsDb();
    writeFileSync(foreignPath, "corrupt ungranted store");
    const access = { actorId: 7, identityIds: [11] };
    const first = await listSessions({ access, orderBy: "activity", limit: 2 });
    expect(first.map(row => row.id)).toEqual(["b", "a"]);
    const last = first[1];
    const second = await listSessions({ access, orderBy: "activity", limit: 2, before: { createdAt: last.created_at, id: last.id, lastMessageAt: last.last_message_at } });
    expect(second.map(row => row.id)).toEqual(["catalog-old"]);
    const activity = await getLatestActivityBySessions(["a", "b", "catalog-old", "wrong-user", "foreign"], access);
    expect([...activity.keys()].sort()).toEqual(["a", "b", "catalog-old"]);
    await expect(listSessions({ orderBy: "activity" })).rejects.toThrow();
  });
});
