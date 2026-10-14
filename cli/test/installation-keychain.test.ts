import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const execFile = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute });
  return { ...original, execFile };
});
import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { connectLocal } from "@barry-rocks/sdk/internal/client";
import { useInstanceSecret } from "../src/config.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  execute.mockReset();
  vi.unstubAllEnvs();
});

it("uses exact Keychain references for installation, CLI and local HTTP authentication", async () => {
  const home = mkdtempSync(join(tmpdir(), "installation-keychain-"));
  directories.push(home);
  vi.stubEnv("BARRY_HOME", home);
  vi.stubEnv("BARRY_SECRET", "unrelated-shell-key");
  mkdirSync(join(home, "config"));
  mkdirSync(join(home, "app-support"));
  writeFileSync(join(home, "config", "barry.yaml"), "secrets:\n  BARRY_SECRET:\n    in: keychain\n    item: instance-api\n    account: exact-account\n");
  writeFileSync(join(home, "app-support", "env"), "BARRY_SECRET=unrelated-file-key\n");
  execute.mockResolvedValue({ stdout: "owned-keychain-key\n" });
  expect(await installationSecrets(["BARRY_SECRET"])).toEqual({ BARRY_SECRET: "owned-keychain-key" });
  await useInstanceSecret();
  expect(process.env.BARRY_SECRET).toBe("owned-keychain-key");
  const request = vi.fn<typeof fetch>(async () => new Response("{\"sessions\":[],\"nextCursor\":null}", { status: 200 }));
  const client = await connectLocal({ baseUrl: "http://localhost:12345", fetch: request });
  await client.sessions.list();
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer owned-keychain-key" });
  expect(execute).toHaveBeenCalledTimes(3);
  for (const call of execute.mock.calls) expect(call).toEqual([
    "/usr/bin/security", ["find-generic-password", "-s", "instance-api", "-a", "exact-account", "-w"],
  ]);
  execute.mockResolvedValue({ stdout: "" });
  await expect(useInstanceSecret()).rejects.toThrow("absent or empty");
  expect(process.env.BARRY_SECRET).toBeUndefined();
  await expect(connectLocal({ baseUrl: "http://localhost:12345", fetch: request })).rejects.toThrow("absent or empty");
  expect(request).toHaveBeenCalledOnce();
});
