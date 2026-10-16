import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const home = mkdtempSync(join(tmpdir(), "barry-adapter-evidence-"));
const adapters = loadAdapters({ file: join(home, "adapters.json") });
it.each(["claude", "codex", "cursor", "antigravity", "opencode", "pi"])("%s mode evidence names existing checks on its verified build", async name => {
  const record = await adapters.add(join(root, "adapters/sessions", name));
  const adapter = await adapters.load(record.id);
  for (const mode of Object.values(adapter.modes)) {
    if (!mode) continue;
    for (const entry of mode.evidence.check.split(";")) {
      const path = entry.trim().split(/\s+/)[0];
      expect(existsSync(join(root, path)), `missing evidence: ${entry}`).toBe(true);
    }
    expect(mode.versions?.testedVersions).toContain(mode.verifiedOn);
    expect(mode.versions?.recommendedVersion).toBeTruthy();
  }
  for (const path of adapter.requirements.binary.paths ?? []) expect(isAbsolute(path)).toBe(true);
});

it("retains prerelease and build identities rather than verifying them as a release", () => {
  for (const adapter of adapters.installed()) {
    const pattern = new RegExp(adapter.requirements.binary.versionPattern);
    if (adapter.id === "cursor") continue;
    const version = "2.3.4-rc.1+probe";
    expect(pattern.exec(`${adapter.requirements.binary.command} ${version}`)?.[1]).toBe(version);
  }
});
