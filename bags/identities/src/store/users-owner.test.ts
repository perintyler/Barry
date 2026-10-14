import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeIdentitiesDb, getIdentitiesSqlite } from "./identities-db.js";
import { InstallationOwner } from "./installation-owner.js";
import { Users } from "./users.js";
import { revalidateRequestPrincipal } from "../devices.js";

let dir: string;
let previous: string | undefined;
beforeEach(() => {
  closeIdentitiesDb();
  dir = mkdtempSync(join(tmpdir(), "barry-owner-user-"));
  previous = process.env.BARRY_IDENTITIES_DB;
  process.env.BARRY_IDENTITIES_DB = join(dir, "identities.db");
});
afterEach(() => {
  closeIdentitiesDb();
  if (previous === undefined) delete process.env.BARRY_IDENTITIES_DB;
  else process.env.BARRY_IDENTITIES_DB = previous;
  rmSync(dir, { recursive: true, force: true });
});

it("resolves only the bound user, including parsed settings, without inferring an owner", async () => {
  const db = getIdentitiesSqlite();
  db.prepare("INSERT INTO actors(id, token, type, name, settings) VALUES (1, 'first', 'user', 'First', '{}'), (2, 'owner', 'user', 'Owner', ?)").run(JSON.stringify({ defaultBarry: "owned" }));
  expect(await Users.getInstallationOwner()).toBeUndefined();
  new InstallationOwner(db).bind({ actorId: 2, actorToken: "owner" });
  expect(await Users.getInstallationOwner()).toMatchObject({ id: 2, token: "owner", settings: { defaultBarry: "owned" } });
  db.prepare("INSERT INTO actors(id, token, type, name) VALUES (3, 'later', 'user', 'Later')").run();
  expect((await Users.getInstallationOwner())?.id).toBe(2);
});

it("revalidates installation attribution against the bound owner without treating an actor ID as authentication", async () => {
  const principal = { kind: "installation" as const, actorId: 2, credentialId: "installation" as const };
  expect(await revalidateRequestPrincipal(principal)).toBeNull();
  const db = getIdentitiesSqlite();
  db.prepare("INSERT INTO actors(id, token, type, name) VALUES(1,'first','user','First'),(2,'owner','user','Owner')").run();
  new InstallationOwner(db).bind({ actorId: 2, actorToken: "owner" });
  expect(await revalidateRequestPrincipal({ ...principal, actorId: 1 })).toBeNull();
  const changes = db.prepare("SELECT total_changes() AS n").get();
  const current = await revalidateRequestPrincipal(principal);
  expect(current).toEqual(principal);
  expect(Object.isFrozen(current)).toBe(true);
  expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
});
