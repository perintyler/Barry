/**
 * The identities operations against real stores: a scratch SQLite store and
 * scratch identity directories, read back after every write. What these
 * guard is that every door gets the same rules, so each case goes through
 * the operation the CLI and the routes both call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const scratch = mkdtempSync(join(tmpdir(), "identity-operations-"));
// Pinned before the stores load: each resolves its path from these.
process.env.BARRY_HOME = join(scratch, "home");
process.env.BARRY_IDENTITIES_DB = join(scratch, "identities.db");
process.env.BARRY_CONFIG_DB = join(scratch, "config.db");
process.env.BARRY_BAGS_SNAPSHOT = join(scratch, "bags.snapshot.json");

// The bag registry is the CLI's; here only "linear" and "github" are registered.
const { UnregisteredBagError } = await vi.importActual<typeof import("../store/identity-bags.js")>("../store/identity-bags.js");
vi.mock("../store/identity-bags.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/identity-bags.js")>();
  const registered = new Set(["linear", "github"]);
  return {
    ...actual,
    resolveAndSyncBags: vi.fn(async (bags: string[], options: { strict?: boolean } = {}) => {
      const unknown = bags.filter((bag) => !registered.has(bag));
      if (options.strict && unknown.length > 0) throw new actual.UnregisteredBagError(unknown);
      return {
        bags,
        composedBags: bags,
        addedSubBags: [],
        syncedTraits: [],
        timedOut: false,
        warnings: unknown.map((bag) => ({ kind: "unregistered", bag, message: `bag "${bag}" is not registered` })),
      };
    }),
    resolveAndSyncBagsIfChanged: vi.fn(async () => undefined),
  };
});
vi.mock("./effects.js", () => ({ announceIdentity: vi.fn(), refreshLiveSessions: vi.fn() }));

const { identities } = await import("./identities.js");
const { identityRecords } = await import("./identity-records.js");
const { announceIdentity, refreshLiveSessions } = await import("./effects.js");
const { Barry, requestCaller } = await import("@barry-rocks/sdk");
const { fakeSessions } = await import("@barry-rocks/sdk/testing");
const { installationOwner } = await import("../installation-owner.js");
const { Identities } = await import("../store/identities.js");
const { Users } = await import("../store/users.js");
const { Traits } = await import("../config/traits.js");
const { closeIdentitiesDb } = await import("../store/identities-db.js");
const { getIdentitiesDir } = await import("../paths.js");
const { registerIdentityDirectory, readIdentitiesRegistry } = await import("../store/identity-files.js");

let actorId: number;
const deviceFor = (credentialId: string, identityIds: number[]) =>
  requestCaller({ kind: "device", credentialId, actorId, identityIds, scopes: ["identities:read"] });
let counter = 0;

beforeAll(async () => {
  Barry.use(identities, fakeSessions({ removeAll: vi.fn(async () => 0) }));
  actorId = installationOwner().provision({ username: "owner" }).actorId;
  await Traits.upsertTrait({ name: "reviewer", description: null, namespaces: ["github"], access: "read" });
});
afterAll(() => {
  Barry.reset();
  closeIdentitiesDb();
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => vi.mocked(announceIdentity).mockClear());

function yamlOf(dir: string): Record<string, unknown> {
  return parse(readFileSync(join(dir, "identity.yaml"), "utf8")) as Record<string, unknown>;
}

async function created(update: Parameters<typeof Barry.createIdentity>[0] extends infer C ? Omit<C & object, "name"> : never = {}) {
  const name = `ops-${++counter}`;
  return Barry.createIdentity({ name, ...update });
}

describe("identities.update", () => {
  it("writes identity.yaml and refreshes the row, and clears a key given null", async () => {
    const identity = await created({ adapters: { "claude-code": { model: "sonnet" } } });
    await Barry.identity(identity.name).update({ adapters: null, displayName: "Ops" });
    const yaml = yamlOf(identity.directory!);
    expect(yaml.adapters).toBeUndefined();
    expect(yaml.displayName).toBe("Ops");
    const row = await Identities.getByName(actorId, identity.name);
    expect(row?.metadata.display_name).toBe("Ops");
    expect(row?.metadata.adapters).toEqual((await Barry.identity("barry").get()).adapters);
  });

  it("refuses a field it has no key for, instead of dropping it", async () => {
    const identity = await created();
    await expect(Barry.identity(identity.name).update({ default_model: "x" } as never)).rejects.toMatchObject({ reason: "invalid" });
    expect(yamlOf(identity.directory!)).not.toHaveProperty("default_model");
  });

  it("validates an inline bound, as the HTTP door always did and the terminal did not", async () => {
    const identity = await created();
    await expect(Barry.identity(identity.name).update({ bound: { network: { allowDomains: ["example.com"] } } } as never))
      .rejects.toMatchObject({ reason: "invalid" });
    expect(yamlOf(identity.directory!)).not.toHaveProperty("bound");
  });

  it("refuses an unknown trait and a newly added unregistered bag, and tolerates one already there", async () => {
    const identity = await created({ bags: ["linear"] });
    await expect(Barry.identity(identity.name).update({ traits: ["nope"] })).rejects.toMatchObject({ reason: "invalid" });
    await expect(Barry.identity(identity.name).update({ bags: ["linear", "nope"] })).rejects.toMatchObject({ reason: "invalid", message: "Unknown bags: nope" });
    expect(UnregisteredBagError).toBeDefined();

    writeFileSync(join(identity.directory!, "identity.yaml"), `name: ${identity.name}\ninherits: barry\nbags:\n  - linear\n  - retired\n`);
    const kept = await Barry.identity(identity.name).update({ bags: ["linear", "retired", "github"], traits: ["reviewer"] });
    expect(kept.warnings.map((w) => w.bag)).toEqual(["retired"]);
  });

  it("writes a harness under its current key and drops the one it replaced", async () => {
    const identity = await created();
    writeFileSync(join(identity.directory!, "identity.yaml"), `name: ${identity.name}\ninherits: barry\ndefault_coding_agent: codex\n`);
    const updated = await Barry.identity(identity.name).update({ adapters: { "claude-code": { default: true } } });
    expect(updated.adapters).toEqual({ "claude-code": { default: true } });
    expect(yamlOf(identity.directory!)).not.toHaveProperty("adapters");
    expect(yamlOf(identity.directory!)).not.toHaveProperty("default_coding_agent");
  });

  it("tells live sessions when grants change, and announces every change", async () => {
    const identity = await created();
    vi.mocked(refreshLiveSessions).mockClear();
    await Barry.identity(identity.name).update({ adapters: { "claude-code": { model: "opus" } } });
    expect(refreshLiveSessions).not.toHaveBeenCalled();
    await Barry.identity(identity.name).update({ traits: ["reviewer"] });
    expect(refreshLiveSessions).toHaveBeenCalledTimes(1);
    expect(announceIdentity).toHaveBeenCalledWith(expect.anything(), "updated");
  });

  it("refuses a device, which may only read the identities it was granted", async () => {
    const identity = await created();
    const device = Barry.as(deviceFor("d1", [identity.id]));
    await expect(device.identity(identity.id).update({ displayName: "x" })).rejects.toMatchObject({ reason: "forbidden" });
    expect((await device.identity(identity.id).get()).name).toBe(identity.name);
    const other = await created();
    await expect(device.identity(other.id).get()).rejects.toMatchObject({ reason: "forbidden" });
    await expect(device.identities()).rejects.toMatchObject({ reason: "forbidden" });
  });

  it("lets a session read only its own identity", async () => {
    const identity = await created();
    const other = await created();
    const session = Barry.as({ kind: "session", identity: identity.name, sessionId: "s1" });
    expect((await session.identity(identity.name).get()).id).toBe(identity.id);
    await expect(session.identity(other.name).get()).rejects.toMatchObject({ reason: "forbidden" });
    await expect(session.identity(identity.name).update({ displayName: "x" })).rejects.toMatchObject({ reason: "forbidden" });
  });

  it("refuses an identity with no directory", async () => {
    const row = await Identities.create({ actor_id: actorId, name: `row-only-${++counter}`, metadata: {} });
    await expect(Barry.identity(row.id).update({ displayName: "x" })).rejects.toMatchObject({ reason: "conflict" });
  });
});

describe("identities.create", () => {
  it("makes a directory and its row, with the configuration written as an edit would write it", async () => {
    const identity = await created({ traits: ["reviewer"], displayName: "Reviewer" });
    expect(identity.source).toBe("file");
    expect(yamlOf(identity.directory!)).toMatchObject({ name: identity.name, inherits: "base", traits: expect.arrayContaining(["reviewer"]), displayName: "Reviewer" });
    expect(await Identities.getByName(actorId, identity.name)).toBeDefined();
    expect(announceIdentity).toHaveBeenCalledWith(expect.anything(), "created");
  });

  it("refuses a taken name, the base identity's name, and a malformed one", async () => {
    const identity = await created();
    await expect(Barry.createIdentity({ name: identity.name })).rejects.toMatchObject({ reason: "conflict" });
    await expect(Barry.createIdentity({ name: "barry" })).rejects.toMatchObject({ reason: "invalid" });
    await expect(Barry.createIdentity({ name: "base" })).rejects.toMatchObject({ reason: "invalid" });
    await expect(Barry.createIdentity({ name: "../escape" })).rejects.toMatchObject({ reason: "invalid" });
  });
});

describe("identity adapter validation", () => {
  it.each(["3", "007"])("refuses the numeric name %s", async name => {
    await expect(Barry.createIdentity({ name })).rejects.toMatchObject({ reason: "invalid", message: expect.stringContaining("digits only") });
  });
  it("accepts a name containing letters and digits", async () => {
    expect((await Barry.createIdentity({ name: "b3" })).name).toBe("b3");
  });
  it("refuses ambiguous adapter updates", async () => {
    const identity = await created();
    await expect(Barry.identity(identity.name).update({ adapters: { codex: {}, "claude-code": {} } })).rejects.toMatchObject({ reason: "invalid", message: expect.stringContaining("--default") });
  });
});

describe("identities.remove", () => {
  it("moves a directory Barry made aside, removes the row and sessions, and moves the default on", async () => {
    const first = await created();
    const second = await created();
    await Barry.identity(second.name).makeDefault();
    const removeAll = vi.fn(async () => 3);
    Barry.use(fakeSessions({ removeAll }));

    const removed = await Barry.identity(second.name).remove();
    expect(removed).toMatchObject({ sessionsDeleted: 3, directory: "moved" });
    expect(removeAll).toHaveBeenCalledWith(second.name, { kind: "owner" });
    expect(existsSync(second.directory!)).toBe(false);
    expect(existsSync(join(removed.movedTo!, "identity.yaml"))).toBe(true);
    expect(await Identities.getByName(actorId, second.name)).toBeUndefined();
    const user = await Users.get(actorId);
    expect(user?.settings.defaultBarry).not.toBe(second.name);
    expect((await Barry.identity(first.name).get()).name).toBe(first.name);
  });

  it("unregisters a directory recorded elsewhere and leaves it on disk", async () => {
    const name = `repo-${++counter}`;
    const dir = join(scratch, "repos", name);
    await Barry.createIdentity({ name, directory: dir });
    expect(readIdentitiesRegistry()[name]).toBeDefined();

    expect(await Barry.identity(name).remove()).toMatchObject({ directory: "unregistered" });
    expect(existsSync(join(dir, "identity.yaml"))).toBe(true);
    expect(readIdentitiesRegistry()[name]).toBeUndefined();
    await expect(Barry.identity(name).get()).rejects.toMatchObject({ reason: "not_found" });
  });

  it("is the owner's alone", async () => {
    const identity = await created();
    await expect(identities.remove(identity.id, deviceFor("d2", [identity.id]))).rejects.toMatchObject({ reason: "forbidden" });
    expect(existsSync(identity.directory!)).toBe(true);
  });
});

describe("identityRecords.byReference", () => {
  it("finds the owner's row by name or row id, and nothing for an identity without one", async () => {
    const identity = await created();
    const row = await Identities.getByName(actorId, identity.name);
    expect((await identityRecords.byReference(identity.name))?.id).toBe(row!.id);
    expect((await identityRecords.byReference(String(row!.id)))?.name).toBe(identity.name);
    expect(await identityRecords.byReference("no-such-identity")).toBeUndefined();

    const name = `unsynced-${++counter}`;
    const dir = join(getIdentitiesDir(), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "identity.yaml"), `name: ${name}\n`);
    expect(await identityRecords.byReference(name)).toBeUndefined();
    expect(await Identities.getByName(actorId, name)).toBeUndefined();
  });

  it("does not hand out another user's row", async () => {
    const other = await Users.create({ name: "Other", email: "other@example.test" });
    const row = await Identities.create({ actor_id: other.id, name: `theirs-${++counter}`, metadata: {} });
    expect(await identityRecords.byReference(String(row.id))).toBeUndefined();
  });
});

describe("Barry.identities", () => {
  it("lists directories, and rows no directory shadows", async () => {
    const identity = await created();
    mkdirSync(getIdentitiesDir(), { recursive: true });
    registerIdentityDirectory("unused", join(scratch, "nowhere"));
    const names = (await Barry.identities()).map((listed) => listed.name);
    expect(names).toContain(identity.name);
    expect(names.filter((name) => name === identity.name)).toHaveLength(1);
  });
});
