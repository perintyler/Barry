/** Real filesystem/YAML/schema declaration checks only. Fixture callbacks never
 * execute; these cases make no native worker or harness eligibility claim. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { testAdapter, type InstalledAdapter, type SessionMode } from "@barry-rocks/sdk/adapters/harnesses";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { installedAdapter } from "./test-helpers/installed-adapter.js";
import { installedWorkflowDeclaration, retainedWorkflowDeclaration } from "./workflow-runtime-registration-contract.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const yaml = "name: declaration-fixture\ndescription: Only retained credential declarations\ncredentials:\n  FIXTURE_KEY: {source: vault, item: fixture-key, field: password}\n";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-registration-contract-")));roots.push(root);
  const original = join(root, "installed"), retained = join(root, "relocated/packages/p0");
  for (const directory of [original, retained]) {
    mkdirSync(join(directory, "dist"), { recursive: true });writeFileSync(join(directory, "dist/index.js"), "// declaration metadata fixture only\n");writeFileSync(join(directory, "bag.yaml"), yaml);
  }
  const neverExecute = async (): Promise<never> => { throw new Error("Metadata fixture must never execute a harness"); };
  const hosted: SessionMode = {
    guarantees: { capture: "total", delivery: "wake", steer: true, interrupt: true, gating: "per-call", keepsVendorUi: false, identity: "inherent" },
    verifiedOn: "0.0.0-test", evidence: { check: "none (metadata fixture)", proves: "nothing about execution" }, egressSandbox: false,
    structuredOutput: "prompted", approvalContinuation: "durable", start: neverExecute, openContinuation: neverExecute,
  };
  const adapter = testAdapter({ id: "declaration-fixture", bag: ".", aliases: ["former-fixture"], defaultMode: "hosted", modes: { hosted, guest: null, instrumented: null } });
  const module = pathToFileURL(join(retained, "dist/index.js")).href;
  return { root, original, retained, adapter, module, write: (source: string) => writeFileSync(join(retained, "bag.yaml"), source), read: () => retainedWorkflowDeclaration(adapter, module) };
}

it("matches the real installed YAML normalization after relocation without retaining machine paths or optional undefined fields", () => {
  const f = fixture(), manifest = parseManifest(f.original);expect(manifest).not.toBeNull();
  const record: InstalledAdapter = { ...installedAdapter(f.adapter.id), ...f.adapter,
    aliases: f.adapter.aliases ? [...f.adapter.aliases] : undefined, tools: [...(f.adapter.tools ?? [])],
    offeredModels: f.adapter.offeredModels ? [...f.adapter.offeredModels] : undefined,
    path: f.original, bag: { path: f.original, manifest: manifest! } };
  const installed = installedWorkflowDeclaration(record);
  rmSync(f.original, { recursive: true });
  expect(f.read()).toEqual(installed);
  const encoded = JSON.stringify(f.read());expect(encoded).not.toContain(f.root);expect(encoded).not.toContain("undefined");
  expect(encoded).toContain("fixture-key");expect(encoded).toContain("former-fixture");
});

it.each(["extends", "bags", "constants", "tools", "mcpServers", "services", "apps", "schedules", "scripts", "jobs", "vendors", "dependencies"])("refuses raw %s before the general manifest normalizer can consult installation state", key => {
  const f = fixture();f.write(yaml + `${key}: {}\n`);
  expect(() => f.read()).toThrow("WorkflowRuntimeBagProfileUnsupported");
});
it.each([
  "bounds:\n  selected:\n    bash: {constant: missing-ambient-provider.secret}\n",
  "bounds:\n  selected: &reference {constant: missing-ambient-provider.secret}\n  alias: *reference\n",
  "bounds: &cycle {nested: *cycle}\n",
])("refuses nested constants and cyclic YAML aliases within the retained profile: %s", fragment => {
  const f = fixture();f.write(yaml + fragment);
  // Exact profile refusal distinguishes this from an attempted ambient
  // constant-provider resolution or a generic later schema rejection.
  expect(() => f.read()).toThrow("WorkflowRuntimeBagProfileUnsupported");
});
it.each(["absolute", "parent", "symlink"] as const)("refuses a retained bag %s escape", kind => {
  const f = fixture(), outside = join(f.root, "outside");mkdirSync(outside);writeFileSync(join(outside, "bag.yaml"), yaml);
  if (kind === "absolute") f.adapter.bag = outside;
  if (kind === "parent") f.adapter.bag = "../../../outside";
  if (kind === "symlink") { symlinkSync(outside, join(f.retained, "bag-alias"), "dir");f.adapter.bag = "bag-alias"; }
  expect(() => f.read()).toThrow("WorkflowRuntimeBagUnavailable");
});
it.each(["live", "unsupported", "missing-open"] as const)("refuses a %s continuation contract without calling fixture callbacks", kind => {
  const f = fixture();
  if (kind === "missing-open") delete f.adapter.modes.hosted!.openContinuation;
  else f.adapter.modes.hosted!.approvalContinuation = kind;
  expect(() => f.read()).toThrow("WorkflowRuntimeAdapterContractUnavailable");
});
