import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { findAction, isScriptAction } from "../actions/action-registry.js";
import { WorkArtifactStore } from "./work-artifacts.js";
import { installedScripts, scriptResourceManifestSchema } from "./script-registry.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "script-registry-")); roots.push(root);
  const directory = join(root, "actions", "script"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "action.yaml"), JSON.stringify({ name: "script", description: "Retained installed script", run: "main.sh", context: "none", env: ["DECLARED=explicit"] }));
  writeFileSync(join(directory, "main.sh"), "printf original"); writeFileSync(join(directory, "asset.txt"), "original asset");
  const action = await findAction([{ name: "fixture", source: { type: "local", path: root }, actionsDirs: [join(root, "actions")], skillsDirs: [], instructionsDirs: [] }], "fixture:script");
  if (!action || !isScriptAction(action)) throw new Error("fixture did not resolve a script");
  const artifacts = new WorkArtifactStore(join(root, "artifacts"));
  const manifest = scriptResourceManifestSchema.parse({ version: 1, scripts: [{ reference: "fixture:script", resource_policy: "closed", allowed_roots: [directory], entry: "main.sh", files: ["main.sh", "asset.txt", "action.yaml"].map(path => ({ path, source: join(directory, path) })), arguments: [{ index: 0, path: "main.sh" }] }] });
  return { root, directory, action, artifacts, manifest };
}
it("resolves the legacy interpreter and creates immutable identities for dependency/resource versions", async () => {
  const f = await fixture(), compile = () => installedScripts([f.action], f.manifest, f.artifacts, "owner")[0]!;
  const original = compile(); expect(compile().type).toBe(original.type);
  expect(original.program).toMatchObject({ argv: [{ source: true }], env: { DECLARED: "explicit" }, source_environment: ["BARRY_ACTION_DIR"], output: "text-tail" });
  const policy = original.sources.find(source => source.media_type === "application/vnd.barry.script-resources+json")!;
  expect(JSON.parse(f.artifacts.verify(policy).toString()).definition).toEqual(f.action);
  writeFileSync(join(f.directory, "asset.txt"), "new asset");
  const changed = compile(); expect(changed.type).not.toBe(original.type); expect(changed.source.digest).toBe(original.source.digest);
  expect(f.artifacts.verify(original.program.bundle!.source).toString()).toContain(Buffer.from("original asset").toString("base64"));
});
it("refuses missing entries, substituted argument paths, duplicate bindings", async () => {
  const f = await fixture();
  for (const change of ["entry", "argument", "duplicate"] as const) {
    const manifest = structuredClone(f.manifest), action = structuredClone(f.action);
    if (change === "entry") manifest.scripts[0]!.entry = "absent.sh";
    if (change === "argument") manifest.scripts[0]!.arguments[0]!.path = "asset.txt";
    if (change === "duplicate") manifest.scripts[0]!.arguments.push(manifest.scripts[0]!.arguments[0]!);
    expect(() => installedScripts([action], manifest, f.artifacts, "owner")).toThrow();
  }
});
it("refuses literal credential declarations before retaining a source bundle", async () => {
  const f = await fixture(); f.action.env = [{ name: "API_TOKEN", source: "value", value: "never-retained-credential" }];
  expect(() => installedScripts([f.action], f.manifest, f.artifacts, "owner")).toThrow(/vault secret names/);
  expect([...f.artifacts.scanStaging(64)]).toEqual([]);
});
it("retains independent command runtimes, action cwd and legacy timeout precedence", async () => {
  const f = await fixture(); mkdirSync(join(f.directory, "work")); f.action.run.workingDirectory = "work";
  f.action.preflight = { command: "printf probe", timeout: 60, hint: "probe hint" };
  f.action.validate = { command: "printf check", timeout: 600, files_exist: ["output.txt"] };
  const script = installedScripts([f.action], f.manifest, f.artifacts, "owner")[0]!;
  expect(script.program.commands?.preflight).toMatchObject({ command: "printf probe", timeout_ms: 60000, hint: "probe hint" });
  expect(script.program.commands?.postcondition).toMatchObject({ command: "printf check", timeout_ms: 600000, files_exist: ["output.txt"] });
  expect(script.program.commands?.preflight?.cwd.path).toBe(dirname(script.program.cwd.path));
  for (const command of Object.values(script.program.commands!)) expect(script.sources).toContainEqual(command.runtime);
});
