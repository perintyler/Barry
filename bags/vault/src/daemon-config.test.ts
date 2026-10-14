import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonConfiguration } from "./daemon-config.js";
let root: string;
let directory: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vault-daemon-config-"));
  directory = join(root, "private");
  mkdirSync(directory, { mode: 0o700 });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function configure(yaml: string, env = "") {
  writeFileSync(join(directory, "barry.yaml"), yaml, { mode: 0o600 });
  writeFileSync(join(directory, ".env"), env, { mode: 0o600 });
}
it("selects declared private values and non-secret MCP configuration without ambient fallback", async () => {
  vi.stubEnv("VAULT_BACKUP_SECRET", "unrelated-shell-value");
  configure("secrets:\n  VAULT_BACKUP_SECRET: { in: .env }\nmcp: { email: owner@example.com, client_id: vault.owner }\n", "VAULT_BACKUP_SECRET=owned-value\nUNRELATED_SECRET=private-unselected\n");
  await expect(readDaemonConfiguration(join(root, "vault.db"))).resolves.toEqual({ secrets: { VAULT_BACKUP_SECRET: "owned-value" }, mcp: { email: "owner@example.com", client_id: "vault.owner" } });
});
it("leaves unconfigured credential gates closed despite ambient values", async () => {
  vi.stubEnv("VAULT_REGISTRATION_SECRET", "unrelated-shell-value");
  await expect(readDaemonConfiguration(join(root, "vault.db"))).resolves.toEqual({ secrets: {} });
});
it("fails a declared absent credential without exposing unrelated values", async () => {
  vi.stubEnv("VAULT_BACKUP_SECRET", "unrelated-shell-value");
  configure("secrets:\n  VAULT_BACKUP_SECRET: { in: .env }\n", "UNRELATED_SECRET=private-canary\n");
  await expect(readDaemonConfiguration(join(root, "vault.db"))).rejects.toThrow(/VAULT_BACKUP_SECRET/);
});
it("rejects inline credentials and self-dependent vault references", async () => {
  configure("secrets:\n  VAULT_BACKUP_SECRET: private-inline-canary\n");
  await expect(readDaemonConfiguration(join(root, "vault.db"))).rejects.toThrow("Invalid vault daemon configuration");
  configure("secrets:\n  VAULT_BACKUP_SECRET: { in: vault, item: backup, field: password }\n");
  await expect(readDaemonConfiguration(join(root, "vault.db"))).rejects.toThrow(/cannot depend on vault secrets/);
});
it("rejects readable credential files and private directories", async () => {
  configure("secrets:\n  VAULT_BACKUP_SECRET: { in: .env }\n", "VAULT_BACKUP_SECRET=owned-value\n");
  chmodSync(join(directory, ".env"), 0o644);
  await expect(readDaemonConfiguration(join(root, "vault.db"))).rejects.toThrow(/credential file must be private/);
  chmodSync(join(directory, ".env"), 0o600);
  chmodSync(directory, 0o750);
  await expect(readDaemonConfiguration(join(root, "vault.db"))).rejects.toThrow(/configuration must be private/);
});
