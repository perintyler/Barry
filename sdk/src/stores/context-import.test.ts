import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

it("public store authoring imports do not install host globals", () => {
  const entry = new URL("./index.ts", import.meta.url).href;
  const context = new URL("./context.ts", import.meta.url).href;
  const loader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const keys = [Symbol.for('barry.store-context'), Symbol.for('barry.store-binding-resolver.v1')];
    const before = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const stores = await import(${JSON.stringify(entry)});
    assert.deepEqual(keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key)), before);
    assert.equal('withStoreContext' in stores, false);
    const host = await import(${JSON.stringify(context)});
    assert.deepEqual(keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key)), before);
    host.installStoreContext();
    assert.equal(typeof globalThis[keys[1]], 'function');
    assert.equal(host.withStoreContext({identity:'alice'}, () => host.currentStoreContext().identity), 'alice');
    assert.equal(host.currentStoreContext(), undefined);
    host.installStoreContext();
    assert.equal(typeof globalThis[keys[1]], 'function');
  `], { encoding: "utf8", timeout: 30_000, env: process.env });
  expect(result.error).toBeUndefined();
  expect(result.stderr, result.stdout).not.toMatch(/AssertionError/);
  expect(result.status, result.stderr).toBe(0);
});
