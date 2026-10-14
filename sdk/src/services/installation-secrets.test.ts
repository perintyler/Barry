import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installationSecrets } from "./installation-secrets.js";

const temporaryDirectories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("reads only explicitly requested installation references without ambient fallback", async () => {
  const directory = temporaryDirectory("installation-secrets-");
  const configPath = join(directory, "barry.yaml");
  const envPath = join(directory, "env");
  writeFileSync(configPath, "secrets:\n  API_KEY:\n    in: .env\n");
  writeFileSync(envPath, "BARRY_SECRET=owned-instance\nAPI_KEY=owned-api\nUNDECLARED=hidden\n");
  expect(await installationSecrets(["BARRY_SECRET", "API_KEY"], { configPath, envPath }))
    .toEqual({ BARRY_SECRET: "owned-instance", API_KEY: "owned-api" });
  await expect(installationSecrets(["UNDECLARED"], { configPath, envPath })).rejects.toThrow("not declared");
  writeFileSync(envPath, "BARRY_SECRET=owned-instance\n");
  const previous = process.env.API_KEY;
  process.env.API_KEY = "ambient";
  try {
    await expect(installationSecrets(["API_KEY"], { configPath, envPath })).rejects.toThrow("absent or empty");
  } finally {
    if (previous === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous;
  }
});

it("allows an unauthored optional feature while keeping authored bindings strict", async () => {
  const directory = temporaryDirectory("optional-installation-secret-");
  const configPath = join(directory, "barry.yaml");
  const envPath = join(directory, "env");
  const options = { configPath, envPath, optionalNames: ["FEATURE_KEY"] };
  expect(await installationSecrets(["FEATURE_KEY"], options)).toEqual({});
  writeFileSync(configPath, "secrets:\n  FEATURE_KEY: {in: .env}\n");
  writeFileSync(envPath, "");
  await expect(installationSecrets(["FEATURE_KEY"], options)).rejects.toThrow("absent or empty");
  writeFileSync(envPath, "FEATURE_KEY=selected-feature\nUNSELECTED_KEY=other\n");
  expect(await installationSecrets(["FEATURE_KEY"], options)).toEqual({ FEATURE_KEY: "selected-feature" });
});

it("reads an installation .env value kept under another name", async () => {
  const directory = temporaryDirectory("installation-secret-key-");
  const configPath = join(directory, "barry.yaml");
  const envPath = join(directory, "env");
  writeFileSync(configPath, "secrets:\n  TUNNEL_TOKEN: {in: .env, key: CLOUDFLARE_TUNNEL_TOKEN}\n");
  writeFileSync(envPath, "CLOUDFLARE_TUNNEL_TOKEN=the-token\n");
  expect(await installationSecrets(["TUNNEL_TOKEN"], { configPath, envPath })).toEqual({ TUNNEL_TOKEN: "the-token" });
});

