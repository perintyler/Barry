import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultTokenSigningKey } from "./token-signing-key.js";

describe("the vault's JWT secret", () => {
  it("publishes one complete private key across concurrent first starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "vault-concurrent-signing-"));
    const directory = join(root, "bootstrap");
    const path = join(directory, "token-signing-key");
    const source = `import { vaultTokenSigningKey } from ${JSON.stringify(new URL("./token-signing-key.ts", import.meta.url).href)}; console.log(vaultTokenSigningKey(process.argv[1]));`;
    const results = await Promise.all(Array.from({ length: 8 }, () => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, path])));
    const keys = results.map(({ stdout }) => stdout.trim());
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(vaultTokenSigningKey(path)).toBe(keys[0]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory)).toEqual(["token-signing-key"]);
  });
  it("is generated once, private, and the same on every later read", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vault-signing-")), "token-signing-key");
    const first = vaultTokenSigningKey(path);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(vaultTokenSigningKey(path)).toBe(first);
  });

  it("keeps an existing secret, which the cutover carries over from .env", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vault-signing-")), "token-signing-key");
    writeFileSync(path, "carried-over\n");
    expect(vaultTokenSigningKey(path)).toBe("carried-over");
  });

  it("refuses an empty file rather than issuing tokens nobody can verify", () => {
    const path = join(mkdtempSync(join(tmpdir(), "vault-signing-")), "token-signing-key");
    writeFileSync(path, "");
    expect(() => vaultTokenSigningKey(path)).toThrow(/empty/);
  });
});
