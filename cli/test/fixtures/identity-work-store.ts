/** Disposable browser-fixture store composition; never a production command. */
import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

const command = z.discriminatedUnion("command", [
  z.object({ command: z.literal("initialize"), metadata: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ command: z.literal("set-bash"), allowed: z.boolean() }).strict(),
  z.object({ command: z.enum(["seed-sessions", "read-only", "end-session", "session-state", "rebind-session"]) }).strict(),
  z.object({ command: z.literal("prepare-services"), runtimePort: z.number().int().min(1).max(65535), apiPort: z.number().int().min(1).max(65535), webPort: z.number().int().min(1).max(65535) }).strict(),
]).parse(JSON.parse(process.argv[2] ?? "null"));
// Require a real, immediate scratch child and its dedicated home before any store operation.
const home = realpathSync(process.env.BARRY_HOME ?? "");
const root = dirname(home);
assert.equal(process.env.VITEST, "true", "Fixture setup requires the test-only scratch context");
assert.equal(basename(home), "home");
assert.equal(dirname(root), realpathSync(tmpdir()));
assert.match(basename(root), /^installed-identity-work-[A-Za-z0-9]+$/);
assert.equal(home, join(root, "home"));


// Load store-owning composition modules only after the scratch-home guard.
const { Barry } = await import("@barry-rocks/sdk");
const { barryStoresDir } = await import("@barry-rocks/sdk/services");
const { bootstrapStoreGeneration, withStoreContext } = await import("@barry-rocks/sdk/internal/stores");
const { installationRegistry } = await import("@barry-rocks/sdk/internal/nodes");
const { identities, owner } = await import("@barry-rocks/identities-bag");
const { identitiesSqlite } = await import("@barry-rocks/identities-bag/testing");
const { getSessionsSqlite } = await import("@barry-rocks/sessions-bag/store/sessions-db");
const { loadAllBags, loadRegistry } = await import("@barry-rocks/sdk/internal/bags");
const { buildServiceSpecs } = await import("../../src/services/specs.js");
const { getDbPath } = await import("@barry-rocks/actions-bag/db");

if (command.command === "prepare-services") {
  const { specs, problems } = buildServiceSpecs(await loadAllBags(), loadRegistry());
  const keys = ["workflows.runtime", "sessions.api", "actions.web"];
  assert.equal(problems.some(problem => keys.includes(problem.key)), false, JSON.stringify(problems));
  const selected = Object.fromEntries(keys.map(key => {
    const spec = specs.find(spec => spec.key === key);
    assert.ok(spec, "Missing declared service " + key);
    return [key, { ...spec, port: key === "workflows.runtime" ? command.runtimePort : key === "sessions.api" ? command.apiPort : command.webPort }];
  }));
  writeFileSync(join(home, "app-support", "service-definitions.json"), JSON.stringify(selected));
} else if (command.command === "initialize") {
  bootstrapStoreGeneration(barryStoresDir());
  const db = identitiesSqlite();
  db.prepare("INSERT INTO actors(id,token,type,name) VALUES(1,'fixture-owner','user','Fixture owner')").run();
  const insertIdentity = db.prepare("INSERT INTO identities(id,token,actor_id,name,metadata) VALUES(?,?,?,?,?)");
  const metadata = JSON.stringify(command.metadata);
  insertIdentity.run(42, "fixture-identity", 1, "fixtureidentity", metadata);
  insertIdentity.run(43, "fixture-other", 1, "otheridentity", metadata);
  db.prepare("INSERT INTO actors(id,token,type,name) VALUES(2,'foreign-owner','user','Foreign owner')").run();
  insertIdentity.run(44, "fixture-foreign", 2, "fixtureidentity", metadata);
  owner.installation().bind({ actorId: 1, actorToken: "fixture-owner" });
  Barry.use(identities);
  const registry = installationRegistry(), identity = registry.identityId(42);
  const projection = withStoreContext({ identity }, () => getDbPath());
  process.stdout.write(JSON.stringify({ identity, installation: registry.id, projection }));
} else if (command.command === "seed-sessions") {
  for (const [id, identity, user] of [["owned", 42, 1], ["other", 43, 1], ["foreign", 44, 2]] as const) {
    withStoreContext({ identity: installationRegistry().identityId(identity) }, () => getSessionsSqlite().prepare("INSERT INTO sessions(id,user_id,identity_id,bags,metadata) VALUES(?,?,?,?,'{}')").run(id, user, identity, JSON.stringify(["bash", "workflows", "fixtureinstalled"])));
  }
} else if (command.command === "set-bash") {
  withStoreContext({ identity: installationRegistry().identityId(42) }, () => getSessionsSqlite().prepare("UPDATE sessions SET bags=? WHERE id='owned'").run(JSON.stringify(command.allowed ? ["bash", "workflows", "fixtureinstalled"] : ["workflows", "fixtureinstalled"])));
} else if (command.command === "read-only") {
  withStoreContext({ identity: installationRegistry().identityId(42) }, () => getSessionsSqlite().prepare("UPDATE sessions SET bags=?,bound=? WHERE id='owned'").run(JSON.stringify(["workflows", "fixtureinstalled"]), JSON.stringify({ tools: { allow: ["workflows:get"], deny: ["*:write"] } })));
} else {
  withStoreContext({ identity: installationRegistry().identityId(42) }, () => {
    const db = getSessionsSqlite();
    if (command.command === "end-session") db.prepare("UPDATE sessions SET state='closed',ended_at=? WHERE id='owned'").run(new Date().toISOString());
    else if (command.command === "rebind-session") db.prepare("UPDATE sessions SET identity_id=43 WHERE id='owned'").run();
    else process.stdout.write(JSON.stringify(db.prepare("SELECT state,ended_at FROM sessions WHERE id='owned'").get()));
  });
}
process.exit(0);
