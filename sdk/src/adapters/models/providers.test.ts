import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadModelVendors, shippedModelVendors } from "./providers.js";

const scratch: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "barry-model-providers-")); scratch.push(root);
  return { root, file: join(root, "selected.json") };
}
function provider(root: string, name: string, vendor = name) {
  const path = join(root, name); mkdirSync(path);
  const manifest = { name, version: "1.0.0", type: "module", exports: { ".": { import: "./index.js" } }, barry: { modelProvider: { contractVersion: 1, factoryExport: "FACTORIES" } } };
  writeFileSync(join(path, "package.json"), JSON.stringify(manifest));
  const receipt = join(path, "imported.txt");
  writeFileSync(join(path, "index.js"), `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(receipt)}, 'imported');
export const FACTORIES = { completion: { ${JSON.stringify(vendor)}: (model, endpoint) => ({ref: ${JSON.stringify(vendor + "/")} + model, structuredOutput:'prompted', complete: async request => ({text:request.prompt + ':' + endpoint.baseUrl, servedModel:model})}) } };`);
  return { path, receipt, manifest };
}
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("creates no state or code imports for an empty installation", async () => {
  const { file } = fixture(); let imports = 0;
  const store = loadModelVendors({ file, importModule: async () => { imports++; throw Error("should not import"); } });
  expect(store.installed()).toEqual([]);
  expect(await store.load()).toEqual({ completion: {}, decision: {}, embedding: {}, listModels: {}, check: {} });
  expect(imports).toBe(0);
});
it("lists selections without loading code, and loads only explicitly chosen providers", async () => {
  const { root, file } = fixture(); const a = provider(root, "alpha"); const b = provider(root, "beta");
  const install = loadModelVendors({ file }); await install.add(a.path); await install.add(b.path);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const imports: string[] = [];
  const store = loadModelVendors({ file, importModule: async entry => { imports.push(entry); return import(entry); } });
  expect(store.installed().map(record => record.packageName)).toEqual(["alpha", "beta"]);
  expect(imports).toEqual([]);
  // An unselected broken provider must not prevent the selected one from running.
  rmSync(b.path, { recursive: true, force: true });
  const factories = await store.load(["alpha"]);
  expect(imports).toEqual([join(a.path, "index.js")]);
  const model = factories.completion!.alpha!("chosen", { baseUrl: "https://explicit.invalid" });
  expect(await model.complete({ prompt: "hello" })).toEqual({ text: "hello:https://explicit.invalid", servedModel: "chosen" });
  expect((await store.load()).completion).toHaveProperty("alpha");
  expect(store.refused.get("beta")?.[0]).toContain("beta is unavailable");
});
it("refuses colliding factory ownership without changing the recorded selection", async () => {
  const { root, file } = fixture(); const a = provider(root, "alpha", "shared"); const b = provider(root, "beta", "shared");
  const store = loadModelVendors({ file }); await store.add(a.path); const before = readFileSync(file, "utf8");
  await expect(store.add(b.path)).rejects.toThrow("duplicate completion factory for vendor shared");
  expect(readFileSync(file, "utf8")).toBe(before);
});
it("rejects unsupported contracts before importing code", async () => {
  const { root, file } = fixture(); const a = provider(root, "alpha");
  a.manifest.barry.modelProvider.contractVersion = 2;
  writeFileSync(join(a.path, "package.json"), JSON.stringify(a.manifest));
  let imports = 0;
  await expect(loadModelVendors({ file, importModule: async () => { imports++; return {}; } }).add(a.path)).rejects.toThrow("contractVersion 1");
  expect(imports).toBe(0);
});
it("refuses package export escape and source-only exports", async () => {
  const { root, file } = fixture(); const a = provider(root, "alpha"); const store = loadModelVendors({ file });
  a.manifest.exports["."].import = "./../outside.js";
  writeFileSync(join(a.path, "package.json"), JSON.stringify(a.manifest));
  await expect(store.add(a.path)).rejects.toThrow("escapes its package");
  a.manifest.exports["."].import = "./source.ts";
  writeFileSync(join(a.path, "package.json"), JSON.stringify(a.manifest));
  await expect(store.add(a.path)).rejects.toThrow("compiled ESM");
});
it("fails malformed registry data rather than treating it as no selections", async () => {
  const { file } = fixture(); writeFileSync(file, '{broken');
  expect(() => loadModelVendors({ file }).installed()).toThrow();
});
it("removes the selection while preserving package files", async () => {
  const { root, file } = fixture(); const a = provider(root, "alpha"); const store = loadModelVendors({ file }); await store.add(a.path);
  expect(store.remove("alpha")).toBe(true); expect(store.remove("alpha")).toBe(false);
  expect(store.installed()).toEqual([]); expect(readFileSync(a.receipt, "utf8")).toBe("imported");
});
it("gives an install command for an absent selection and refuses duplicate choices", async () => {
  const { file } = fixture(); const store = loadModelVendors({ file });
  await expect(store.load(["@example/absent"])).rejects.toThrow("npm install @example/absent");
  await expect(store.load(["same", "same"])).rejects.toThrow("selected twice");
});
it("refuses live concurrent mutation without dropping the existing selections", async () => {
  const { root, file } = fixture(); const a = provider(root, "alpha"); const store = loadModelVendors({ file }); await store.add(a.path);
  const before = readFileSync(file, "utf8"); writeFileSync(join(root, "model-providers.lock"), String(process.pid));
  expect(() => store.remove("alpha")).toThrow("in use");
  expect(readFileSync(file, "utf8")).toBe(before);
});
it("rejects changed contract exports and hides provider import exception contents", async () => {
  const { root, file } = fixture(); const a = provider(root, "alpha"); const store = loadModelVendors({ file }); await store.add(a.path);
  const broken = loadModelVendors({ file, importModule: async () => { throw Error("private-credential-canary"); } });
  await broken.load();
  expect(broken.refused.get("alpha")).toEqual(["alpha could not load; reinstall with npm install alpha"]);
  a.manifest.barry.modelProvider.factoryExport = "CHANGED";
  writeFileSync(join(a.path, "package.json"), JSON.stringify(a.manifest));
  await store.load();
  expect(store.refused.get("alpha")?.[0]).toContain("changed its provider contract");
});


it("walks declarations across kinds, skipping libraries and node_modules", () => {
  const { root } = fixture();
  const completion = join(root, "adapters", "completions");
  const decisions = join(root, "adapters", "decisions");
  mkdirSync(completion, { recursive: true });
  mkdirSync(decisions, { recursive: true });
  const a = provider(completion, "alpha");
  provider(completion, "node_modules");
  const library = join(decisions, "systemone");
  mkdirSync(library);
  writeFileSync(join(library, "package.json"), JSON.stringify({ name: "systemone" }));
  expect(shippedModelVendors(root)).toEqual([{ packageName: "alpha", version: "1.0.0", path: a.path, contractVersion: 1, factoryExport: "FACTORIES" }]);
});

it("repairs a selection despite other stale records and retains those records", async () => {
  const { root, file } = fixture();
  const a = provider(root, "alpha"); const b = provider(root, "beta");
  const store = loadModelVendors({ file });
  await store.add(a.path); await store.add(b.path);
  rmSync(join(b.path, "index.js"));
  await store.add(a.path);
  expect(store.installed()).toHaveLength(2);
  await store.load();
  expect(store.refused.has("beta")).toBe(true);
});

it("reports factory collisions while retaining the earlier healthy package", async () => {
  const { root, file } = fixture();
  const a = provider(root, "alpha"); const b = provider(root, "beta");
  const store = loadModelVendors({ file });
  await store.add(a.path); await store.add(b.path);
  writeFileSync(join(b.path, "index.js"), "export const FACTORIES = { completion: { alpha: () => ({}) } };");
  const reader = loadModelVendors({ file, importModule: async entry => entry === join(b.path, "index.js")
    ? { FACTORIES: { completion: { alpha: () => ({}) } } } : import(entry) });
  expect((await reader.load()).completion).toHaveProperty("alpha");
  expect(reader.refused.get("beta")?.[0]).toContain("duplicate completion");
});


it("does not let setup replace a user selection under the mutation lock", async () => {
  const { root, file } = fixture();
  mkdirSync(join(root, "shipped"));
  const shipped = provider(join(root, "shipped"), "alpha"); const replacement = provider(root, "alpha");
  const store = loadModelVendors({ file });
  await store.add(replacement.path);
  const before = readFileSync(file, "utf8");
  expect((await store.add(shipped.path, { shipped: true })).shipped).toBeUndefined();
  expect(readFileSync(file, "utf8")).toBe(before);
});

it("adopts a user selection that is exactly the shipped package", async () => {
  const { root, file } = fixture();
  const a = provider(root, "alpha");
  const store = loadModelVendors({ file });
  await store.add(a.path);
  expect(await store.add(a.path, { shipped: true })).toMatchObject({ packageName: "alpha", path: a.path, shipped: true });
  expect(store.installed()).toEqual([expect.objectContaining({ packageName: "alpha", path: a.path, shipped: true })]);
});
