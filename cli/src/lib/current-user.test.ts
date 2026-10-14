import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { owner } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore, identitiesSqlite } from "@barry-rocks/identities-bag/testing";
import { getCurrentUser } from "./current-user.js";

const Users = owner.users;
const installationOwner = owner.installation;

let dir: string;
let previous: string | undefined;
beforeEach(() => {
  closeIdentitiesStore();
  dir = mkdtempSync(join(tmpdir(), "barry-cli-owner-"));
  previous = process.env.BARRY_IDENTITIES_DB;
  process.env.BARRY_IDENTITIES_DB = join(dir, "identities.db");
});
afterEach(() => {
  closeIdentitiesStore();
  if (previous === undefined) delete process.env.BARRY_IDENTITIES_DB;
  else process.env.BARRY_IDENTITIES_DB = previous;
  rmSync(dir, { recursive: true, force: true });
});

it("refuses an unbound installation without creating a default user or selecting its sole user", async () => {
  await expect(getCurrentUser()).rejects.toThrow("Run barry setup");
  expect(await Users.list()).toEqual([]);
  const user = await Users.create({ name: "Existing", email: "existing@example.test" });
  await expect(getCurrentUser()).rejects.toThrow("Installation owner unresolved");
  expect((await Users.list()).map(row => row.id)).toEqual([user.id]);
  expect(installationOwner().current()).toBeNull();
});

it("reads the bound second user without changing actors or ownership", async () => {
  await Users.create({ name: "First", email: "first@example.test" });
  const owner = await Users.create({ name: "Owner", email: "owner@example.test" });
  const bound = installationOwner().bind({ actorId: owner.id, actorToken: owner.token });
  const db = identitiesSqlite();
  const changes = db.prepare("SELECT total_changes() AS n").get();
  expect((await getCurrentUser()).id).toBe(owner.id);
  expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  expect(installationOwner().current()).toEqual(bound);
});
