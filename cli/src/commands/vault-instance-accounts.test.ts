import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Barry, type Identities } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import type { IdentityRecord } from "@barry-rocks/identities-bag";
import { identityFixture } from "../../test/helpers/identity-fixture.js";

// The instance descriptor parser and named-reference resolution are real.
// Account transport/Keychain are explicit stand-ins: this qualifies CLI
// selection and mutation guards, not encrypted storage or OS credential access.
const f = vi.hoisted(() => ({
  identity: null as IdentityRecord | null,
  otherIdentities: [] as IdentityRecord[],
  open: vi.fn(), close: vi.fn(), list: vi.fn(), get: vi.fn(), put: vi.fn(), remove: vi.fn(), search: vi.fn(),
  keychain: vi.fn(), keychainGet: vi.fn(), keychainSet: vi.fn(), provision: vi.fn(), secrets: vi.fn(), register: vi.fn(),
  spawn: vi.fn(), maintenance: vi.fn(), urls: [] as string[],
}));
vi.mock("@barry-rocks/sdk/internal/vault", async original => ({
  ...await original<typeof import("@barry-rocks/sdk/internal/vault")>(),
  openVault: f.open,
  VaultClient: class {
    private readonly url: string;
    constructor(url: string) { this.url = url; f.urls.push(url); }
    async status() { return { serverUrl: this.url, connected: true }; }
    register(email: string) { return f.register(email); }
  },
}));
vi.mock("@barry-rocks/sdk/internal/services", async original => ({
  ...await original<typeof import("@barry-rocks/sdk/internal/services")>(), installationSecrets: f.secrets,
}));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawnSync: f.spawn,
}));
vi.mock("./vault-restore-maintenance.js", () => ({ runVaultMaintenance: f.maintenance }));
vi.mock("@barry-rocks/sdk/internal/env", async original => ({
  ...await original<typeof import("@barry-rocks/sdk/internal/env")>(),
  KeychainProvider: class {
    constructor() { f.keychain(); }
    get(service: string, account: string) { return f.keychainGet(service, account); }
    set(account: string, value: string) { return f.keychainSet(account, value); }
  },
}));
vi.mock("@barry-rocks/identities-bag", async original => {
  const actual = await original<typeof import("@barry-rocks/identities-bag")>();
  return { ...actual, identityRecords: { ...actual.identityRecords,
    list: vi.fn(async () => [f.identity!, ...f.otherIdentities].map(record => ({ record, source: "db", dir: null, isDefault: true }))),
    find: vi.fn(async () => ({ record: f.identity!, source: "db", dir: null, isDefault: true })),
    directory: vi.fn(() => null),
  } };
});
vi.mock("./identity.js", () => ({
  requireIdentity: async () => ({ identity: f.identity!, dir: null, source: "db" }), provisionVaultAccount: f.provision,
}));
vi.mock("../lib/current-user.js", () => ({ getCurrentUser: async () => ({ id: 1 }), getActiveIdentity: () => "fixtureidentity" }));
import { vaultAddCommand, vaultListCommand, vaultGetCommand, vaultRemoveCommand, vaultExportCommand, vaultImportCommand,
  vaultStatusCommand, vaultAssignCommand, vaultProvisionCommand } from "./vault.js";
import { vaultRestoreCommand } from "./vault-restore.js";
import { identitySecretSetCommand, identitySecretImportCommand } from "./identity-secrets.js";

let directory: string, endpoint: string;
let originalExitCode: typeof process.exitCode;
const update = vi.fn<Identities["update"]>(async (_ref, changes) => {
  if (changes.vault !== undefined) f.identity!.metadata.vault = changes.vault ?? undefined;
  return { ...identityFixture(f.identity!.name), warnings: [] };
});
function configure(names: string[] = ["account-a"]) {
  const bootstrap = { client_id: { in: ".env", key: "FIXTURE_CLIENT_ID" }, client_secret: { in: ".env", key: "FIXTURE_CLIENT_SECRET" },
    master_password: { in: ".env", key: "FIXTURE_MASTER_PASSWORD" }, email: { in: ".env", key: "FIXTURE_EMAIL" } };
  writeFileSync(join(directory, "config/vault-accounts.yaml"), JSON.stringify({ version: 1,
    accounts: Object.fromEntries(names.map(name => [name, { server_url: endpoint, bootstrap }])),
  }), { mode: 0o600 });
}
beforeEach(() => {
  originalExitCode = process.exitCode;
  directory = mkdtempSync(join(tmpdir(), "vault-instance-cli-")); mkdirSync(join(directory, "config"), { mode: 0o700 });
  vi.stubEnv("BARRY_HOME", directory); endpoint = `unix://${join(directory, "vault.sock")}`;
  f.identity = { id: 1, token: "fixture-identity", actor_id: 1, name: "fixtureidentity", metadata: { vault: "account-a" }, created_at: "2026-01-01T00:00:00Z", last_used_at: null };
  f.otherIdentities.length = 0;
  vi.clearAllMocks(); f.urls.length = 0; f.close.mockResolvedValue(undefined); f.list.mockResolvedValue([]);
  f.get.mockResolvedValue({ id: "item-one", name: "SCRIPT_KEY", username: null, password: "selected", uri: null, notes: null });
  f.search.mockResolvedValue([]); f.put.mockResolvedValue(undefined); f.remove.mockResolvedValue(undefined);
  f.open.mockImplementation(async () => ({ email: "selected@example.com", serverUrl: endpoint, close: f.close, listItems: f.list,
    getItem: f.get, searchItems: f.search, putItem: f.put, deleteItem: f.remove }));
  f.provision.mockImplementation(async (name: string) => name);
  f.secrets.mockResolvedValue({ VAULT_REGISTRATION_SECRET: "fixture-registration-secret" });
  f.register.mockResolvedValue({ clientId: "fixture-client", clientSecret: "fixture-secret", masterPassword: "fixture-password" });
  f.spawn.mockReturnValue({ status: 1, stderr: "fixture age decryption stopped", stdout: "" });
  f.keychainGet.mockImplementation(async (_service: string, account: string) => account.endsWith("-email") ? "legacy@example.com" : "legacy-client-id");
  f.keychainSet.mockResolvedValue(undefined); update.mockClear(); Barry.use(fakeIdentities({ update }));
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  configure();
});
afterEach(() => { process.exitCode = originalExitCode; Barry.reset(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

it.each(["list", "get", "add", "remove", "export", "import"])("keeps the configured vault name through the %s command", async command => {
  const file = join(directory, "items.json"); if (command === "import") writeFileSync(file, '{"items":[]}');
  if (command === "list") await vaultListCommand("fixtureidentity");
  if (command === "get") await vaultGetCommand("fixtureidentity", "SCRIPT_KEY");
  if (command === "add") await vaultAddCommand("fixtureidentity", "SCRIPT_KEY", "fixture-value");
  if (command === "remove") { f.search.mockResolvedValue([{ id: "item-one", name: "SCRIPT_KEY" }]); await vaultRemoveCommand("fixtureidentity", "SCRIPT_KEY", { force: true }); }
  if (command === "export") await vaultExportCommand("fixtureidentity", file);
  if (command === "import") await vaultImportCommand("fixtureidentity", file);
  expect(f.open).toHaveBeenCalledExactlyOnceWith("account-a"); expect(f.keychain).not.toHaveBeenCalled();
});
it("preserves direct --vault selection without borrowing the active identity's configured account", async () => {
  configure(["account-a", "account-b"]); await vaultListCommand(undefined, { vault: "account-b" });
  expect(f.open).toHaveBeenCalledExactlyOnceWith("account-b");
});
it("probes the configured endpoint and authenticates by name for status", async () => {
  await vaultStatusCommand("fixtureidentity");
  expect(f.urls).toEqual([endpoint]); expect(f.open).toHaveBeenCalledExactlyOnceWith("account-a"); expect(f.close).toHaveBeenCalledOnce();
  expect(f.keychain).not.toHaveBeenCalled();
});
it("reports configured authentication failure without retrying a legacy account or endpoint", async () => {
  f.open.mockRejectedValueOnce(new Error("Configured authentication unavailable"));
  await vaultStatusCommand("fixtureidentity");
  expect(f.urls).toEqual([endpoint]); expect(f.open).toHaveBeenCalledExactlyOnceWith("account-a"); expect(f.keychain).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith("  Authenticated: no (Configured authentication unavailable)");
});
it("verifies and closes a configured account before assigning only its name", async () => {
  f.identity!.metadata.vault = undefined;
  await vaultAssignCommand("account-a", { identity: "fixtureidentity", email: "SELECTED@example.com" });
  expect(f.open).toHaveBeenCalledExactlyOnceWith("account-a"); expect(f.close).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledWith("fixtureidentity", { vault: "account-a" }, expect.anything());
  expect(f.identity!.metadata.vault).toBe("account-a"); expect(f.keychain).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("the name alone does not establish isolation"));
});
it("requires explicit force before overwriting an existing item through configured aliases of the same account", async () => {
  configure(["account-a", "account-b"]);
  f.otherIdentities.push({ ...f.identity!, id: 2, token: "alias-owner", name: "aliasowner", metadata: { vault: "account-b" } });
  f.search.mockResolvedValue([{ id: "item-one", name: "SCRIPT_KEY" }]);
  await expect(vaultAddCommand("fixtureidentity", "SCRIPT_KEY", "replacement")).rejects.toThrow("sharing cannot be established from its name");
  expect(f.put).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
  await vaultAddCommand("fixtureidentity", "SCRIPT_KEY", "replacement", { force: true });
  expect(f.put).toHaveBeenCalledExactlyOnceWith("SCRIPT_KEY", { password: "replacement" });
  expect(f.secrets).not.toHaveBeenCalled(); expect(f.keychain).not.toHaveBeenCalled();
});
it("requires explicit force before deleting through configured aliases even when legacy reference inference finds no co-user", async () => {
  configure(["account-a", "account-b"]);
  f.otherIdentities.push({ ...f.identity!, id: 2, token: "alias-owner", name: "aliasowner", metadata: { vault: "account-b" } });
  f.search.mockResolvedValue([{ id: "item-one", name: "SCRIPT_KEY" }]);
  await expect(vaultRemoveCommand("fixtureidentity", "SCRIPT_KEY")).rejects.toThrow("references cannot be established from its name");
  expect(f.remove).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  await vaultRemoveCommand("fixtureidentity", "SCRIPT_KEY", { force: true });
  expect(f.remove).toHaveBeenCalledExactlyOnceWith("SCRIPT_KEY");
  expect(f.secrets).not.toHaveBeenCalled(); expect(f.keychain).not.toHaveBeenCalled();
});
it("keeps configured import overwrite explicit and preserves nonoverwriting imports", async () => {
  configure(["account-a", "account-b"]);
  const file = join(directory, "alias-items.json");
  writeFileSync(file, JSON.stringify({ items: [{ name: "SCRIPT_KEY", password: "replacement" }, { name: "NEW_KEY", password: "new-value" }] }));
  f.list.mockResolvedValue([{ id: "item-one", name: "SCRIPT_KEY" }]);
  await vaultImportCommand("fixtureidentity", file);
  expect(f.put).toHaveBeenCalledExactlyOnceWith("NEW_KEY", expect.objectContaining({ password: "new-value" }));
  f.put.mockClear();
  await vaultImportCommand("fixtureidentity", file, { overwrite: true });
  expect(f.put).toHaveBeenCalledWith("SCRIPT_KEY", expect.objectContaining({ password: "replacement" }));
  expect(f.put).toHaveBeenCalledWith("NEW_KEY", expect.objectContaining({ password: "new-value" }));
});
it.each(["set", "import"])("retains the configured vault name through identity secret %s and requires force for an alias overwrite", async command => {
  configure(["account-a", "account-b"]);
  f.otherIdentities.push({ ...f.identity!, id: 2, token: "alias-owner", name: "aliasowner", metadata: { vault: "account-b" } });
  f.search.mockResolvedValue([{ id: "item-one", name: "SCRIPT_KEY" }]);
  const file = join(directory, "identity-secrets.env"); writeFileSync(file, "SCRIPT_KEY=replacement\n");
  const write = (force = false) => command === "set"
    ? identitySecretSetCommand("SCRIPT_KEY", "replacement", { name: "fixtureidentity", source: "vault", force })
    : identitySecretImportCommand(file, { name: "fixtureidentity", source: "vault", force });
  await expect(write()).rejects.toThrow("sharing cannot be established from its name");
  expect(f.put).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
  f.get.mockResolvedValue({ id: "item-one", name: "SCRIPT_KEY", password: "replacement" });
  await write(true);
  expect(f.put).toHaveBeenCalledExactlyOnceWith("SCRIPT_KEY", { password: "replacement" });
  expect(f.open.mock.calls).toEqual([["account-a"], ["account-a"]]); expect(f.close).toHaveBeenCalledTimes(2);
  expect(update).toHaveBeenCalledWith("fixtureidentity", { secrets: { SCRIPT_KEY: { in: "vault", item: "SCRIPT_KEY", field: "password" } } }, expect.anything());
  expect(f.secrets).not.toHaveBeenCalled(); expect(f.keychain).not.toHaveBeenCalled();
});
it("creates a new configured identity secret without force and verifies it before recording its reference", async () => {
  f.get.mockResolvedValue({ id: "new-item", name: "SCRIPT_KEY", password: "new-value" });
  await identitySecretSetCommand("SCRIPT_KEY", "new-value", { name: "fixtureidentity", source: "vault" });
  expect(f.put).toHaveBeenCalledExactlyOnceWith("SCRIPT_KEY", { password: "new-value" });
  expect(f.close).toHaveBeenCalledOnce(); expect(update).toHaveBeenCalledOnce();
});
it("does not assign or rewrite bootstrap when configured authentication or email verification fails", async () => {
  f.open.mockRejectedValueOnce(new Error("Configured account cannot authenticate"));
  await expect(vaultAssignCommand("account-a", { identity: "fixtureidentity" })).rejects.toThrow("cannot authenticate");
  await expect(vaultAssignCommand("account-a", { identity: "fixtureidentity", email: "other@example.com" })).rejects.toThrow("--email differs");
  expect(update).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce(); expect(f.keychain).not.toHaveBeenCalled();
});
it.each(["current", "prospective"])("refuses configured %s account provisioning even with --force before registration or Keychain writes", async selected => {
  if (selected === "prospective") { f.identity!.metadata.vault = undefined; configure(["fixtureidentity"]); }
  await expect(vaultProvisionCommand("fixtureidentity", "new@example.com", { force: true })).rejects.toThrow("cannot be provisioned into the legacy Keychain");
  expect(f.provision).not.toHaveBeenCalled(); expect(f.keychain).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
});
it("keeps legacy assignment and provisioning available for unconfigured names", async () => {
  rmSync(join(directory, "config/vault-accounts.yaml")); f.identity!.metadata.vault = undefined;
  await vaultAssignCommand("legacy", { identity: "fixtureidentity" });
  expect(f.keychainGet).toHaveBeenCalledWith("", "vault-legacy-client-id"); expect(f.open).not.toHaveBeenCalled();
  f.identity!.metadata.vault = undefined;
  await vaultProvisionCommand("fixtureidentity", "legacy@example.com");
  expect(f.provision).toHaveBeenCalledWith("fixtureidentity", "legacy@example.com");
});
it("rejects direct configured provisioning before reading registration secrets, registering, or writing Keychain", async () => {
  const { provisionVaultAccount } = await vi.importActual<typeof import("./identity.js")>("./identity.js");
  await expect(provisionVaultAccount(" account-a ", "new@example.com")).rejects.toThrow("cannot be provisioned into the legacy Keychain");
  expect(f.secrets).not.toHaveBeenCalled(); expect(f.register).not.toHaveBeenCalled();
  expect(f.urls).toEqual([]); expect(f.keychain).not.toHaveBeenCalled(); expect(f.keychainSet).not.toHaveBeenCalled();
});
it("preserves direct legacy provisioning and verified Keychain storage for an unconfigured name", async () => {
  const { provisionVaultAccount } = await vi.importActual<typeof import("./identity.js")>("./identity.js");
  const stored = new Map<string, string>();
  f.keychainSet.mockImplementation(async (name: string, value: string) => { stored.set(name, value); });
  f.keychainGet.mockImplementation(async (_service: string, name: string) => stored.get(name));
  await expect(provisionVaultAccount(" legacy ", " LEGACY@example.com ")).resolves.toBe("legacy");
  expect(f.secrets).toHaveBeenCalledExactlyOnceWith(["VAULT_REGISTRATION_SECRET"]);
  expect(f.register).toHaveBeenCalledExactlyOnceWith("legacy@example.com");
  expect(stored).toEqual(new Map([
    ["vault-legacy-client-id", "fixture-client"], ["vault-legacy-client-secret", "fixture-secret"],
    ["vault-legacy-master-password", "fixture-password"], ["vault-legacy-email", "legacy@example.com"],
  ]));
});
it("does not fall back to the legacy endpoint or Keychain when a selected descriptor is malformed", async () => {
  writeFileSync(join(directory, "config/vault-accounts.yaml"), '{"version":1,"accounts":{"account-a":{"server_url":"file:///invalid"}}}', { mode: 0o600 });
  await expect(vaultStatusCommand("fixtureidentity")).rejects.toThrow();
  await expect(vaultAssignCommand("account-a", { identity: "fixtureidentity" })).rejects.toThrow();
  expect(f.urls).toEqual([]); expect(f.open).not.toHaveBeenCalled(); expect(f.keychain).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
});
it("refuses configured restore before decrypting the backup, reading Keychain, or contacting a legacy daemon", async () => {
  const source = join(directory, "backup.age"), key = join(directory, "offline-age-key");
  writeFileSync(source, "age-encryption.org/v1\n"); writeFileSync(key, "fixture-key");
  await vaultRestoreCommand(source, { name: "fixtureidentity", ageKeyPath: key, force: true });
  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("instance-configured vault account is not supported"));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Preserve its private vault-accounts.yaml connection"));
  expect(f.spawn).not.toHaveBeenCalled(); expect(f.keychain).not.toHaveBeenCalled();
  expect(f.maintenance).not.toHaveBeenCalled(); expect(f.urls).toEqual([]);
});
it("retains legacy restore decryption for unconfigured names", async () => {
  f.identity!.metadata.vault = "legacy";
  const source = join(directory, "backup.age"), key = join(directory, "offline-age-key");
  writeFileSync(source, "age-encryption.org/v1\n"); writeFileSync(key, "fixture-key");
  await vaultRestoreCommand(source, { name: "fixtureidentity", ageKeyPath: key, dryRun: true });
  expect(f.spawn).toHaveBeenCalledWith("age", expect.arrayContaining(["-d", "-i", key]), expect.anything());
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("fixture age decryption stopped"));
  expect(f.maintenance).not.toHaveBeenCalled();
});
