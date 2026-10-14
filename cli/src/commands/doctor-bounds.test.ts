import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { Barry } from "@barry-rocks/sdk";
import { identities, identityRecords, bounds } from "@barry-rocks/identities-bag";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { listBoundSessions } from "@barry-rocks/sessions-bag/client";
import { createIdentity, provisionOwner } from "../../test/helpers/identities.js";
import { reportBoundProblems } from "./doctor-bounds.js";

beforeAll(() => { Barry.use(identities); provisionOwner(); vi.stubEnv("BARRY_SESSIONS_DB", ""); });
afterAll(() => { closeSessionsDb(); Barry.reset(); vi.unstubAllEnvs(); process.exitCode = 0; });
it("names inline restrictions and converts two partitions, leaving unknown ids closed", async () => {
  const bux = await createIdentity({ name: "bux" });
  const bgoode = await createIdentity({ name: "bgoode", inherits: "bux" });
  const path = join(bgoode.dir!, "identity.yaml");
  writeFileSync(path, `id: ${bgoode.record.id}\nname: bgoode\ninherits: bux\nbound: { files: { deny: [".env"] } }\n`);
  await bounds.upsert({ name: "old-no-bash", bound: { deniedTools: ["Bash"] } });
  const named = (await bounds.stored()).find(row => row.name === "old-no-bash")!;
  mkdirSync(barryStoresDir(), { recursive: true });
  writeFileSync(join(barryStoresDir(), "active.json"), JSON.stringify({ id: "bounds-test" }));
  const nodes = new NodeRegistry();
  let parent: string; let child: string;
  try { parent = nodes.identityId(bux.record.id); child = nodes.identityId(bgoode.record.id); }
  finally { nodes.close(); }
  const seed = (id: string, boundId: number) => getSessionsSqlite().prepare("INSERT INTO sessions(id,bound_id,bounds) VALUES (?,?,'[\"readonly\"]')").run(id, boundId);
  withStoreContext({ identity: parent }, () => seed("parent-session", named.id));
  withStoreContext({ identity: child }, () => { seed("child-session", named.id); seed("unknown-session", 999999); });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await reportBoundProblems(false);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("2 session(s) carry bound_id"));
  expect(log).toHaveBeenCalledWith(expect.stringContaining("writes restrictions inline"));
  expect(parse(readFileSync(path, "utf8"))).toHaveProperty("bound");
  await reportBoundProblems(true);
  expect(parse(readFileSync(path, "utf8"))).toMatchObject({ bounds: [{ bgoode: { description: "bgoode's own restrictions, moved from bound:", files: { deny: [".env"] } } }] });
  expect(parse(readFileSync(path, "utf8"))).not.toHaveProperty("bound");
  expect((await identityRecords.find("bgoode")).record.metadata.bounds).toBeDefined();
  for (const identity of [parent, child]) withStoreContext({ identity }, () => {
    expect(getSessionsSqlite().prepare("SELECT bounds,bound_id FROM sessions WHERE id=?").get(identity === parent ? "parent-session" : "child-session")).toEqual({ bounds: '["readonly","old-no-bash"]', bound_id: null });
  });
  expect((await listBoundSessions()).map(row => row.id)).toEqual(["unknown-session"]);
  expect(process.exitCode).toBe(1);
  const before = readFileSync(path, "utf8");
  await reportBoundProblems(true);
  expect(readFileSync(path, "utf8")).toBe(before);
  warning.mockRestore(); log.mockRestore();
});
