import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateStore } from "@barry-rocks/sdk/stores";
import migrations from "../generated/identities-migrations.js";
import { InstallationOwner } from "./installation-owner.js";

let db: Database.Database;
let owner: InstallationOwner;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateStore(db, migrations, "identities.db");
  owner = new InstallationOwner(db, () => 1000);
});
afterEach(() => db.close());
function actor(id: number, token = `user-${id}`, type = "user") {
  db.prepare("INSERT INTO actors(id, token, type, name) VALUES (?, ?, ?, ?)").run(id, token, type, `User ${id}`);
}
describe("installation owner binding", () => {
  it("provisions a fresh user and owner together and preserves the binding on repeated setup", () => {
    actor(9, "agent-9", "agent");
    const first = owner.provision({ username: "local-user" });
    expect(first).toEqual({ actorId: 10, name: "local-user", boundAt: 1000 });
    expect(db.prepare("SELECT username, email, token FROM actors WHERE id=10").get()).toMatchObject({ username: "local-user", email: null, token: expect.stringMatching(/^usr_/) });
    expect(owner.provision({ username: "changed-os-user" })).toEqual(first);
    expect(db.prepare("SELECT count(*) AS n FROM actors WHERE type='user'").get()).toEqual({ n: 1 });
    expect(JSON.stringify(first)).not.toContain("usr_");
  });
  it("binds a sole user copied after migration without replacing its durable key", () => {
    actor(7, "copied-key");
    expect(owner.provision({ username: "different-local-user" }).actorId).toBe(7);
    expect(db.prepare("SELECT actor_token FROM installation_owner").get()).toEqual({ actor_token: "copied-key" });
    expect(db.prepare("SELECT count(*) AS n FROM actors").get()).toEqual({ n: 1 });
  });
  it("requires explicit selection for multiple users and refuses unavailable, agent or replacement owners", () => {
    actor(1); actor(2); actor(3, "agent-3", "agent");
    expect(() => owner.provision({ username: "local" })).toThrow("--owner");
    for (const actorId of [99, 3]) expect(() => owner.provision({ actorId, username: "local" })).toThrow("unavailable");
    expect(owner.current()).toBeNull();
    expect(owner.provision({ actorId: 2, username: "local" }).actorId).toBe(2);
    expect(() => owner.provision({ actorId: 1, username: "local" })).toThrow("already bound");
  });
  it("rolls back fresh-user creation when owner binding fails, then allows setup to resume", () => {
    expect(() => new InstallationOwner(db, () => -1).provision({ username: "local" })).toThrow("CHECK");
    expect(db.prepare("SELECT count(*) AS n FROM actors").get()).toEqual({ n: 0 });
    expect(owner.current()).toBeNull();
    expect(owner.provision({ username: "local" }).actorId).toBe(1);
  });
  it("concurrent setup processes create exactly one user and agree on the durable owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "barry-owner-setup-"));
    const path = join(dir, "identities.db");
    const disk = new Database(path);
    disk.pragma("foreign_keys = ON");
    disk.pragma("journal_mode = WAL");
    migrateStore(disk, migrations, "identities.db");
    disk.close();
    const script = `
      import Database from 'better-sqlite3';
      import { InstallationOwner } from ${JSON.stringify(new URL("./installation-owner.ts", import.meta.url).href)};
      const db = new Database(process.argv[1]);
      db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
      process.stdout.write(JSON.stringify(new InstallationOwner(db).provision({username:'local'})));
      db.close();
    `;
    const provision = () => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.on("close", code => {
        clearTimeout(timer);
        if (code !== 0) { reject(new Error(`Setup fixture failed: ${stderr}`)); return; }
        try { resolve(JSON.parse(stdout).actorId); } catch { reject(new Error("Invalid setup fixture response")); }
      });
    });
    try {
      const results = await Promise.allSettled([provision(), provision(), provision()]);
      expect(results).toEqual(Array.from({ length: 3 }, () => ({ status: "fulfilled", value: 1 })));
      const check = new Database(path);
      try {
        expect(check.prepare("SELECT count(*) AS n FROM actors WHERE type='user'").get()).toEqual({ n: 1 });
        expect(new InstallationOwner(check).current()?.actorId).toBe(1);
      } finally { check.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 15_000);
  it("does not select an arbitrary actor or infer a new owner from later users", () => {
    expect(owner.current()).toBeNull();
    actor(1);
    expect(owner.current()).toBeNull();
    actor(2);
    expect(owner.current()).toBeNull();
  });
  it("pins an explicit durable user and remains stable as users and names change", () => {
    actor(1); actor(2);
    expect(owner.bind({ actorId: 2, actorToken: "user-2" })).toEqual({ actorId: 2, name: "User 2", boundAt: 1000 });
    actor(3);
    db.prepare("UPDATE actors SET name='Renamed' WHERE id=2").run();
    expect(owner.current()).toEqual({ actorId: 2, name: "Renamed", boundAt: 1000 });
    expect(Object.isFrozen(owner.current())).toBe(true);
    expect(new InstallationOwner(db, () => 2000).bind({ actorId: 2, actorToken: "user-2" }).boundAt).toBe(1000);
  });
  it("refuses replacement, stale selections, nonexistent users and agents", () => {
    actor(1); actor(2); actor(3, "agent-3", "agent");
    for (const selection of [{ actorId: 1, actorToken: "stale" }, { actorId: 99, actorToken: "missing" }, { actorId: 3, actorToken: "agent-3" }]) expect(() => owner.bind(selection)).toThrow("unavailable or changed");
    expect(owner.current()).toBeNull();
    owner.bind({ actorId: 1, actorToken: "user-1" });
    expect(() => owner.bind({ actorId: 2, actorToken: "user-2" })).toThrow("already bound");
    expect(owner.current()?.actorId).toBe(1);
  });
  it("protects actor deletion, token/type changes and inconsistent direct bindings with foreign keys", () => {
    actor(1); actor(2);
    owner.bind({ actorId: 1, actorToken: "user-1" });
    for (const sql of ["DELETE FROM actors WHERE id=1", "UPDATE actors SET token='replacement' WHERE id=1", "UPDATE actors SET type='agent' WHERE id=1"]) expect(() => db.exec(sql)).toThrow("FOREIGN KEY");
    db.exec("DELETE FROM installation_owner");
    expect(() => db.prepare("INSERT INTO installation_owner VALUES(1, 1, 'user-2', 'user', 1000)").run()).toThrow("FOREIGN KEY");
    expect(owner.current()).toBeNull();
  });
  it("rolls back a failed binding and validates actor keys", () => {
    actor(1);
    for (const actorId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => owner.bind({ actorId, actorToken: "user-1" })).toThrow("Invalid");
    expect(() => new InstallationOwner(db, () => -1).bind({ actorId: 1, actorToken: "user-1" })).toThrow("CHECK");
    expect(owner.current()).toBeNull();
  });
  it("migrates the sole existing user without confusing agent rows with owners", () => {
    db.close();
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrateStore(db, migrations.slice(0, 3), "identities.db");
    actor(7); actor(8, "agent-8", "agent");
    migrateStore(db, migrations, "identities.db");
    owner = new InstallationOwner(db);
    expect(owner.current()).toMatchObject({ actorId: 7, name: "User 7" });
    actor(9);
    expect(owner.current()?.actorId).toBe(7);
  });
  it("leaves an existing multiple-user installation unbound during migration", () => {
    db.close();
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrateStore(db, migrations.slice(0, 3), "identities.db");
    actor(1); actor(2);
    migrateStore(db, migrations, "identities.db");
    expect(new InstallationOwner(db).current()).toBeNull();
  });
});
