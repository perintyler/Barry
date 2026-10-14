import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliError } from "./../lib/cli-error.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Barry, type Identities } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import type { IdentityRecord } from "@barry-rocks/identities-bag";
import { identityFixture } from "../../test/helpers/identity-fixture.js";

/**
 * Covers the decisions these commands make, not the vault protocol.
 *
 * The guards are the point: `remove` refusing to orphan an env reference,
 * `provision` refusing to strand the secrets under an existing account, and
 * `import` skipping rather than clobbering. Each is the kind of check that is
 * indistinguishable from a no-op when it is subtly wrong -- `remove`'s guard
 * read `ref.name` while set-env writes `ref.item`, and in that state it matched
 * nothing and passed every input. So each guard here is asserted in BOTH
 * directions: it fires on the case it exists for, and it stays quiet otherwise.
 */

const vaultApi = vi.hoisted(() => ({
  listItems: vi.fn(),
  getItem: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  searchItems: vi.fn(),
}));
// Session-handle signatures: one argument, no session leading the rest.
vaultApi.getItem.mockImplementation(async (name: string) => ({ id: "i-1", name, username: null, password: null, uri: null, notes: null }));

let identity: IdentityRecord;

vi.mock("@barry-rocks/identities-bag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/identities-bag")>();
  return {
    ...actual,
    // `list` as well as the lookup: the sharing check enumerates every identity
    // the owner has, so a mock missing it throws rather than reporting no co-users.
    identityRecords: {
      ...actual.identityRecords,
      list: vi.fn(async () => [{ record: identity, source: "db", dir: null, isDefault: true }]),
    },
  };
});

// Only the part that would reach a real vault is replaced. getVaultConfig is
// the REAL one: it used to be mocked as a passthrough, which handed the command
// an inline block with no `credentials` that the real resolver never produces,
// and three tests failed for a reason production could not reach. A mock of a
// resolver encodes a belief about it; the real one cannot drift from itself.
vi.mock("@barry-rocks/sdk/internal/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/env")>(),

  maskSecret: (s: string) => `${s.slice(0, 2)}***`,
}));

// The session handle the commands hold, over the same hoisted API stand-in.
// openVault is mocked rather than the daemon reached: these tests are about
// what the COMMANDS do, and the Keychain read a real open costs is beside the
// point here.
vi.mock("@barry-rocks/sdk/internal/vault", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/vault")>(),

  openVault: async () => ({
    // The handle's semantics: putItem upserts by name; deleteItem resolves the
    // id first. The hoisted stand-ins stay one-call, so the assertions below
    // read like the daemon calls they stand for.
    getItem: (name: string) => vaultApi.getItem(name),
    putItem: async (name: string, fields?: { password?: string }) => {
      await vaultApi.getItem(name);
      return vaultApi.updateItem(name, fields);
    },
    deleteItem: async (name: string) => {
      const item = await vaultApi.getItem(name);
      return vaultApi.deleteItem(item.id);
    },
    listItems: () => vaultApi.listItems(),
    searchItems: (q: string) => vaultApi.searchItems(q),
    close: async () => {},
    email: "b@example.com",
    serverUrl: "https://vault.test",
  }),
}));

vi.mock("../lib/current-user.js", () => ({
  getCurrentUser: async () => ({ id: "user-1" }),
  getActiveIdentity: () => "bgoode",
}));

const identityModule = vi.hoisted(() => ({
  requireIdentity: vi.fn(async () => ({ user: { id: 1 }, identity, dir: null, source: "db" })),
  provisionVaultAccount: vi.fn(async (name: string) => name),
}));
vi.mock("./identity.js", () => identityModule);

// The identities subject, as the commands change an identity through `Barry`:
// a change lands on the one identity here, so a re-read sees it.
const update = vi.fn<Identities["update"]>(async (_ref, changes) => {
  if (changes.vault !== undefined) identity.metadata.vault = changes.vault ?? undefined;
  return { ...identityFixture(identity.name), warnings: [] };
});

let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let tmp: string;

class ExitError extends Error {}

beforeEach(() => {
  // A COMPLETE vault config, because that is the only shape the real
  // getVaultConfig ever hands back: it passes a full inline block through, or
  // synthesizes one from a vault name. The credentials-less version this
  // fixture used to carry cannot occur in production, and mocking it into
  // existence made three tests fail against code that was correct.
  identity = {
    id: 1,
    token: "fixture-identity-bgoode",
    actor_id: 1,
    name: "bgoode",
    metadata: {
      vault: "bgoode",
    },
    created_at: "2026-01-01T00:00:00.000Z",
    last_used_at: null,
  };
  tmp = mkdtempSync(join(tmpdir(), "barry-vault-cmd-"));
  vi.clearAllMocks();
  Barry.use(fakeIdentities({ update }));
  exitSpy = vi.spyOn(process, "exit").mockImplementation((): never => {
    throw new ExitError("exit");
  });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  Barry.reset();
  exitSpy.mockRestore();
  errSpy.mockRestore();
  logSpy.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

const stderr = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
const stdout = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");

describe("barry vault remove", () => {
  it("refuses to delete an item an env mapping still points at", async () => {
    identity.metadata.secrets = { OPENAI_API_KEY: { reference: { in: "vault", item: "openai", field: "password" } } };
    vaultApi.searchItems.mockResolvedValue([{ id: "i-1", name: "openai" }]);

    const { vaultRemoveCommand } = await import("./vault.js");
    await expect(vaultRemoveCommand("bgoode", "openai")).rejects.toThrow(CliError);

    expect(vaultApi.deleteItem).not.toHaveBeenCalled();
    expect(stderr()).toContain("OPENAI_API_KEY");
  });

  it("deletes when no mapping references it", async () => {
    identity.metadata.secrets = { OTHER: { reference: { in: "vault", item: "something-else", field: "password" } } };
    vaultApi.searchItems.mockResolvedValue([{ id: "i-1", name: "openai" }]);

    const { vaultRemoveCommand } = await import("./vault.js");
    await vaultRemoveCommand("bgoode", "openai");

    expect(vaultApi.deleteItem).toHaveBeenCalledWith("i-1");
  });

  it("--force deletes despite the reference", async () => {
    identity.metadata.secrets = { OPENAI_API_KEY: { reference: { in: "vault", item: "openai", field: "password" } } };
    vaultApi.searchItems.mockResolvedValue([{ id: "i-1", name: "openai" }]);

    const { vaultRemoveCommand } = await import("./vault.js");
    await vaultRemoveCommand("bgoode", "openai", { force: true });

    expect(vaultApi.deleteItem).toHaveBeenCalledWith("i-1");
  });

  it("a keychain mapping of the same name does not block the delete", async () => {
    // The guard must key on source too: a keychain entry named `openai` is a
    // different secret in a different store, and blocking on it would make the
    // vault item undeletable for a reason that does not exist.
    identity.metadata.secrets = { OPENAI_API_KEY: { reference: { in: "keychain", item: "openai" } } };
    vaultApi.searchItems.mockResolvedValue([{ id: "i-1", name: "openai" }]);

    const { vaultRemoveCommand } = await import("./vault.js");
    await vaultRemoveCommand("bgoode", "openai");

    expect(vaultApi.deleteItem).toHaveBeenCalled();
  });
});

describe("barry vault provision", () => {
  it("gives a vault to a barry that has none", async () => {
    identity.metadata = {};

    const { vaultProvisionCommand } = await import("./vault.js");
    await vaultProvisionCommand("bgoode", "new@example.com");

    expect(identityModule.provisionVaultAccount).toHaveBeenCalledWith("bgoode", "new@example.com");
    expect(update).toHaveBeenCalledWith("bgoode", { vault: "bgoode" }, expect.anything());
  });

  it("refuses when one already exists, naming the export path out", async () => {
    const { vaultProvisionCommand } = await import("./vault.js");
    await expect(vaultProvisionCommand("bgoode", "new@example.com")).rejects.toThrow(/vault export/);

    expect(identityModule.provisionVaultAccount).not.toHaveBeenCalled();
  });

  it("--force replaces an existing account", async () => {
    const { vaultProvisionCommand } = await import("./vault.js");
    await vaultProvisionCommand("bgoode", "new@example.com", { force: true });

    expect(identityModule.provisionVaultAccount).toHaveBeenCalled();
    expect(stdout()).toContain("no longer reachable");
  });
});

describe("barry vault export / import", () => {
  it("writes every item 0600, and import round-trips them", async () => {
    vaultApi.listItems.mockResolvedValue([{ id: "i-1", name: "openai" }, { id: "i-2", name: "stripe" }]);
    vaultApi.getItem.mockImplementation(async (name: string) => ({
      name,
      password: `${name}-secret`,
      username: undefined,
      uri: undefined,
      notes: undefined,
    }));

    const out = join(tmp, "secrets.json");
    const { vaultExportCommand, vaultImportCommand } = await import("./vault.js");
    await vaultExportCommand("bgoode", out);

    // 0600: this file is cleartext credentials.
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(written.items.map((i: { name: string }) => i.name)).toEqual(["openai", "stripe"]);
    expect(written.items[0].password).toBe("openai-secret");

    // Import into an empty vault creates both — via the handle's upsert.
    vaultApi.listItems.mockResolvedValue([]);
    await vaultImportCommand("bgoode", out);
    expect(vaultApi.updateItem).toHaveBeenCalledWith("openai", expect.objectContaining({ password: "openai-secret" }));
    expect(vaultApi.updateItem).toHaveBeenCalledWith("stripe", expect.objectContaining({ password: "stripe-secret" }));
  });

  it("skips items that already exist rather than clobbering them", async () => {
    const file = join(tmp, "in.json");
    writeFileSync(file, JSON.stringify({ items: [{ name: "openai", password: "from-file" }] }));
    vaultApi.listItems.mockResolvedValue([{ id: "i-1", name: "openai" }]);

    const { vaultImportCommand } = await import("./vault.js");
    await vaultImportCommand("bgoode", file);

    expect(vaultApi.updateItem).not.toHaveBeenCalled();
    expect(vaultApi.createItem).not.toHaveBeenCalled();
    expect(stdout()).toContain("1 skipped");
  });

  it("--overwrite replaces them", async () => {
    const file = join(tmp, "in.json");
    writeFileSync(file, JSON.stringify({ items: [{ name: "openai", password: "from-file" }] }));
    vaultApi.listItems.mockResolvedValue([{ id: "i-1", name: "openai" }]);

    const { vaultImportCommand } = await import("./vault.js");
    await vaultImportCommand("bgoode", file, { overwrite: true });

    expect(vaultApi.updateItem).toHaveBeenCalledWith("openai", expect.objectContaining({ password: "from-file" }));
  });

  it("rejects a file that is not a vault export", async () => {
    const file = join(tmp, "junk.json");
    writeFileSync(file, JSON.stringify({ nope: true }));

    const { vaultImportCommand } = await import("./vault.js");
    await expect(vaultImportCommand("bgoode", file)).rejects.toThrow(CliError);
    expect(vaultApi.createItem).not.toHaveBeenCalled();
  });
});
