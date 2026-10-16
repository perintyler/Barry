import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configuredVaultEndpoint, instanceVaultConnection } from "./instance-account.js";
import { openVault } from "./account.js";
import { KeychainProvider } from "../env/providers/keychain.js";

let home: string, filename: string, envFile: string;
const endpoint = "unix:///tmp/explicit-vault-account-test.sock";
function account(prefix: string, server_url = endpoint) {
  return { server_url, bootstrap: Object.fromEntries(["client_id", "client_secret", "master_password", "email"].map(field => [field, { in: ".env", key: `${prefix}_${field.toUpperCase()}` }])) };
}
function configure(accounts: Record<string, unknown>) {
  writeFileSync(filename, JSON.stringify({ version: 1, accounts }), { mode: 0o600 });
}
function credentials(a = "first") {
  writeFileSync(envFile, ["A", "B"].flatMap(prefix => ["CLIENT_ID", "CLIENT_SECRET", "MASTER_PASSWORD", "EMAIL"].map(field => `${prefix}_${field}=${prefix === "A" ? a : "other"}-${field}`)).join("\n"), { mode: 0o600 });
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vault-instance-account-"));
  mkdirSync(join(home, "config"), { mode: 0o700 }); mkdirSync(join(home, "app-support"), { mode: 0o700 });
  filename = join(home, "config/vault-accounts.yaml"); envFile = join(home, "app-support/env");
  vi.stubEnv("BARRY_HOME", home); vi.stubEnv("BARRY_ALLOW_REAL_VAULT", "");
  configure({ a: account("A"), b: account("B") }); credentials();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it("binds each named account to its four declared private file slots, with a single snapshot per opening", async () => {
  const a = instanceVaultConnection("a")!, b = instanceVaultConnection("b")!;
  expect(await a.readSecret("barry", "vault-a-client-id")).toBe("first-CLIENT_ID");
  credentials("rotated");
  expect(await a.readSecret("barry", "vault-a-client-secret")).toBe("first-CLIENT_SECRET");
  expect(await b.readSecret("barry", "vault-b-client-secret")).toBe("other-CLIENT_SECRET");
  expect(await instanceVaultConnection("a")!.readSecret("barry", "vault-a-client-secret")).toBe("rotated-CLIENT_SECRET");
  await expect(a.readSecret("barry", "vault-b-client-id")).rejects.toThrow("private connection");
  await expect(a.readSecret("other-service", "vault-a-client-id")).rejects.toThrow("private connection");
});

it("validates only the selected account while rejecting recursive or OS-Keychain bootstrap", async () => {
  for (const source of ["vault", "keychain"]) {
    configure({ a: { ...account("A"), bootstrap: { ...account("A").bootstrap, email: { in: source, item: "do-not-read" } } }, b: account("B") });
    expect(() => configuredVaultEndpoint("a")).toThrow("private connection");
    expect(configuredVaultEndpoint("b")).toBe(endpoint);
    expect(await instanceVaultConnection("b")!.readSecret("barry", "vault-b-email")).toBe("other-EMAIL");
  }
});

it("guards the production endpoint before reading a configured credential file", async () => {
  configure({ a: account("A", "unix:///usr/local/var/barry-vault/run/vault.sock") }); rmSync(envFile);
  const keychain = vi.spyOn(KeychainProvider.prototype, "get");
  await expect(openVault("a")).rejects.toThrow("refuses to open a real vault");
  expect(keychain).not.toHaveBeenCalled();
});

it("rejects an untrusted endpoint before reading any bootstrap material", () => {
  configure({ a: account("A", "https://untrusted.example/vault"), b: account("B") }); rmSync(envFile);
  expect(() => instanceVaultConnection("a")).toThrow("private connection");
  expect(configuredVaultEndpoint("b")).toBe(endpoint);
});

it("never falls back to Keychain or ambient credentials after an explicit account failure", async () => {
  vi.stubEnv("A_CLIENT_ID", "ambient-canary"); vi.stubEnv("A_CLIENT_SECRET", "ambient-canary");
  writeFileSync(envFile, "A_CLIENT_ID=private-canary\n", { mode: 0o600 });
  const keychain = vi.spyOn(KeychainProvider.prototype, "get");
  const error = await openVault("a").catch(error => error);
  expect(error.message).toBe("Configured vault account needs a valid private connection and bootstrap file.");
  expect(error.message).not.toMatch(/canary/); expect(keychain).not.toHaveBeenCalled();
});

it("keeps the guarded legacy path only when no connection is authored for that exact name", async () => {
  expect(configuredVaultEndpoint("missing")).toBeUndefined();
  const keychain = vi.spyOn(KeychainProvider.prototype, "get");
  await expect(openVault("missing")).rejects.toThrow("refuses to open a real vault");
  rmSync(filename); expect(configuredVaultEndpoint("a")).toBeUndefined();
  await expect(openVault("a")).rejects.toThrow("refuses to open a real vault");
  expect(keychain).not.toHaveBeenCalled();
});

it.each(["configuration", "credentials"])("refuses permissive or symlinked %s files", async kind => {
  const path = kind === "configuration" ? filename : envFile;
  chmodSync(path, 0o644);
  await expect(openVault("a")).rejects.toThrow("private connection");
  chmodSync(path, 0o600);
  const target = path + ".target"; writeFileSync(target, "private-canary", { mode: 0o600 }); rmSync(path); symlinkSync(target, path);
  await expect(openVault("a")).rejects.toThrow("private connection");
});

it("refuses a group-writable configuration or credential parent", async () => {
  for (const parent of [join(home, "config"), join(home, "app-support")]) {
    chmodSync(parent, 0o770); await expect(openVault("a")).rejects.toThrow("private connection"); chmodSync(parent, 0o700);
  }
});

it("cannot replace a configured bootstrap with an injected credential reader", async () => {
  const readSecret = vi.fn(async () => "replacement-canary");
  await expect(openVault("a", { readSecret })).rejects.toThrow("cannot be replaced");
  expect(readSecret).not.toHaveBeenCalled();
});

it("requires an explicit temporary instance before automatic bootstrap in tests", async () => {
  vi.stubEnv("BARRY_HOME", "");
  const keychain = vi.spyOn(KeychainProvider.prototype, "get");
  await expect(openVault("a")).rejects.toThrow("without a temporary instance");
  expect(keychain).not.toHaveBeenCalled();
});

it.each(["configuration", "credentials"])("rejects a %s FIFO without blocking the resolver process", kind => {
  const path = kind === "configuration" ? filename : envFile;
  rmSync(path); execFileSync("/usr/bin/mkfifo", ["-m", "600", path]);
  const source = `import {openVault} from ${JSON.stringify(new URL("./account.ts", import.meta.url).href)};
    try { await openVault('a'); process.exit(4); }
    catch (error) { if (error.message !== 'Configured vault account needs a valid private connection and bootstrap file.') throw error; process.stdout.write('refused'); }`;
  expect(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { timeout: 3000, encoding: "utf8" })).toBe("refused");
});
