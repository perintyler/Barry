import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ANTIGRAVITY_OFFERED_MODELS, listAntigravityModels } from "./offered-models.js";

let root: string | undefined;
function executable() {
  root = mkdtempSync(join(tmpdir(), "barry-agy-models-"));
  const receipt = join(root, "env.json"); const bin = join(root, "agy");
  writeFileSync(bin, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(receipt)}, JSON.stringify({key:process.env.GEMINI_API_KEY ?? null, barry:process.env.BARRY_SECRET ?? null, update:process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null, home:process.env.HOME, settings:JSON.parse((await import("node:fs")).readFileSync(process.env.HOME+"/.gemini/antigravity-cli/settings.json","utf8"))}));\nconsole.log('model-a  Model A');\n`);
  chmodSync(bin, 0o755); vi.stubEnv("ANTIGRAVITY_BIN", bin); return receipt;
}
afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });
it("uses curated inventory without authenticating through ambient credentials", async () => {
  const receipt = executable(); vi.stubEnv("GEMINI_API_KEY", "ambient-key-canary");
  expect(await listAntigravityModels()).toEqual(ANTIGRAVITY_OFFERED_MODELS.map(model => model.id));
  expect(existsSync(receipt)).toBe(false);
});
it("passes only the selected provider key to the real discovery child", async () => {
  const receipt = executable();
  vi.stubEnv("GEMINI_API_KEY", "ambient-key-canary"); vi.stubEnv("BARRY_SECRET", "ambient-instance-canary");
  expect(await listAntigravityModels({ env: { GEMINI_API_KEY: "selected-key", BARRY_SECRET: "selected-instance-key" } })).toEqual(["model-a"]);
  const observed = JSON.parse(readFileSync(receipt, "utf8"));
  expect(observed).toMatchObject({ key: "selected-key", barry: null, update: "true", settings: { modelProvider: "gemini" } });
  expect(observed.home).toContain("antigravity-homes");
});
