import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";

it("persists owner-scoped operation metadata without drafts and rejects changed retry bodies", async () => {
  const storage = new Map<string, string>();
  const context = createContext({ crypto: webcrypto, TextEncoder, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  runInContext(readFileSync(new URL("../web/operations.js", import.meta.url), "utf8").replace(/^export /gm, ""), context);
  const run = (source: string) => runInContext(source, context);
  await run('rememberOperation("owner", "start", "job", "job", {type:"echo", version:"1", input:{secret:"private payload", a:1}})');
  expect([...storage.values()].join()).not.toContain("private payload");
  expect(run('pendingOperations("other").length')).toBe(0);
  await run('rememberOperation("owner", "start", "job", "job", {version:"1", type:"echo", input:{a:1, secret:"private payload"}})');
  expect(run('pendingOperations("owner").length')).toBe(1);
  await expect(run('rememberOperation("owner", "start", "job", "job", {type:"echo", version:"1", input:null})')).rejects.toThrow("original input");
  run('forgetOperation("owner", pendingOperations("owner")[0])');
  expect(run('pendingOperations("owner").length')).toBe(0);
});
