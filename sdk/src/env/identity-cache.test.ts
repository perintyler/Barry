import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bindSecretReferences } from "../identities/secrets.js";
import { identityEnvironmentForId, invalidateIdentityEnvironment, setIdentityStore } from "./identity.js";

const directories: string[] = [];
afterEach(() => {
  invalidateIdentityEnvironment();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function installSecrets(values: string) {
  const directory = mkdtempSync(join(tmpdir(), "identity-cache-"));
  directories.push(directory);
  writeFileSync(join(directory, ".env"), values);
  const identity = { bags: [], secrets: bindSecretReferences({ FIRST_KEY: { in: ".env" }, SECOND_KEY: { in: ".env" } }, directory) };
  setIdentityStore({ get: async () => identity, resolveConfig: record => record, touchLastUsed: async () => {} });
  return directory;
}

it("keeps cached secret selections isolated, including empty and undeclared selections", async () => {
  installSecrets("FIRST_KEY=first\nSECOND_KEY=second\n");
  const options = { cacheTtlMs: 60_000, touch: false };
  expect((await identityEnvironmentForId(1, options)).vars).toEqual({ FIRST_KEY: "first", SECOND_KEY: "second" });
  expect((await identityEnvironmentForId(1, { ...options, names: ["FIRST_KEY"] })).vars).toEqual({ FIRST_KEY: "first" });
  expect((await identityEnvironmentForId(1, { ...options, names: ["SECOND_KEY"] })).vars).toEqual({ SECOND_KEY: "second" });
  expect((await identityEnvironmentForId(1, { ...options, names: [] })).vars).toEqual({});
  await expect(identityEnvironmentForId(1, { ...options, names: ["UNDECLARED"] })).rejects.toThrow("not declared");
});

it("invalidates credentials when the installed identity store changes", async () => {
  const options = { names: ["FIRST_KEY"], cacheTtlMs: 60_000, touch: false };
  installSecrets("FIRST_KEY=old-instance\n");
  expect((await identityEnvironmentForId(1, options)).vars).toEqual({ FIRST_KEY: "old-instance" });
  installSecrets("FIRST_KEY=new-instance\n");
  expect((await identityEnvironmentForId(1, options)).vars).toEqual({ FIRST_KEY: "new-instance" });
});

it("does not cache credentials supplied through a caller-owned vault session", async () => {
  const identity = { bags: [], secrets: bindSecretReferences({ FIRST_KEY: { in: "vault", item: "first", field: "password" } }) };
  setIdentityStore({ get: async () => identity, resolveConfig: record => record, touchLastUsed: async () => {} });
  const session = (password: string) => ({ getItem: async () => ({ password }) }) as never;
  const options = { names: ["FIRST_KEY"], cacheTtlMs: 60_000, touch: false };
  expect((await identityEnvironmentForId(1, { ...options, vault: session("first-session") })).vars).toEqual({ FIRST_KEY: "first-session" });
  expect((await identityEnvironmentForId(1, { ...options, vault: session("second-session") })).vars).toEqual({ FIRST_KEY: "second-session" });
});

it("serves a late cache hit immediately while refreshing and fences invalidation", async () => {
  const { vi }=await import("vitest");
  const now=vi.spyOn(Date,"now").mockReturnValue(1000);
  try {
    const directory=installSecrets("FIRST_KEY=old\n");
    const options={names:["FIRST_KEY"],cacheTtlMs:1000,touch:false};
    expect((await identityEnvironmentForId(1,options)).vars.FIRST_KEY).toBe("old");
    writeFileSync(join(directory,".env"),"FIRST_KEY=new\n");
    now.mockReturnValue(1801);
    expect((await identityEnvironmentForId(1,options)).vars.FIRST_KEY).toBe("old");
    await vi.waitFor(async()=>expect((await identityEnvironmentForId(1,options)).vars.FIRST_KEY).toBe("new"));
    invalidateIdentityEnvironment(1);writeFileSync(join(directory,".env"),"FIRST_KEY=rotated\n");
    expect((await identityEnvironmentForId(1,options)).vars.FIRST_KEY).toBe("rotated");
  } finally {now.mockRestore();}
});
