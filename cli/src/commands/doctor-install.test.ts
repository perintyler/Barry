import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { checkShippedBounds, installationChecks } from "./doctor-install.js";
import { barryAppSupportDir, barryCurrentDir } from "@barry-rocks/sdk/services";
import { existsSync } from "node:fs";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "barry-doctor-install-"));
  roots.push(root); vi.stubEnv("BARRY_HOME", root); return root;
}
it("reports absent installation artifacts without provisioning stores or an owner", async () => {
  scratch();
  const checks = await installationChecks();
  for (const name of ["current", "shim", "node", "services", "bounds", "owner", "nodes"]) expect(checks.find(check => check.name === name)?.status).toBe("fail");
  expect(existsSync(barryAppSupportDir())).toBe(false);
  expect(checks.find(check => check.name === "session-adapter")).toMatchObject({ status: "fail", detail: expect.stringContaining("no session adapter selected") });
});
it("reports a broken selector, a nonexecutable shim and missing pin independently", async () => {
  const root = scratch();
  mkdirSync(barryAppSupportDir(), { recursive: true });
  symlinkSync(join(root, "missing"), barryCurrentDir());
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/barry"), "#!/bin/sh\n", { mode: 0o600 });
  const checks = await installationChecks();
  expect(checks.find(check => check.name === "current")).toMatchObject({ status: "fail", detail: "current must be a symlink to an existing installation" });
  expect(checks.find(check => check.name === "shim")?.status).toBe("fail");
  expect(checks.find(check => check.name === "node")?.detail).toBe("shim does not pin Node");
});

it("reads the shim’s actual pin and reports an obsolete runtime even when another Node runs doctor", async () => {
  const root = scratch();
  mkdirSync(join(root, "bin"));
  const node = join(root, "old node");
  writeFileSync(node, "#!/bin/sh\nprintf 'v26.5.0\\n'\n", { mode: 0o755 });
  writeFileSync(join(root, "bin/barry"), `#!/bin/sh\nexport BARRY_NODE='${node}'\n`, { mode: 0o755 });
  const checks = await installationChecks();
  expect(checks.find(check => check.name === "node")).toMatchObject({ status: "fail", detail: "Node 26.9 or newer is required for process.execve service handoff" });
});

it("accepts a release wrapper whose pinned runtime is selected implicitly", async () => {
  const root = scratch();
  const release = join(root, "source");
  mkdirSync(join(release, "runtime/bin"), { recursive: true });
  writeFileSync(join(release, "runtime/bin/node"), "#!/bin/sh\nprintf 'v26.11.1\\n'\n", { mode: 0o755 });
  writeFileSync(join(release, "release.json"), JSON.stringify({ version: "1.2.3", commit: "a".repeat(40), platform: "darwin-arm64", node: { version: "26.11.1", sha256: "1".repeat(64) }, stores: {}, built: "2026-10-08T00:00:00.000Z" }));
  mkdirSync(barryAppSupportDir(), { recursive: true });
  symlinkSync(release, barryCurrentDir());
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/barry"), "#!/bin/sh\nexec current/bin/barry \"$@\"\n", { mode: 0o755 });
  const checks = await installationChecks();
  expect(checks.find(check => check.name === "node")).toMatchObject({ status: "pass" });
});

it("rejects an existing selector target that is not a Barry installation", async () => {
  const root = scratch();
  const target = join(root, "arbitrary");
  mkdirSync(target); mkdirSync(barryAppSupportDir(), { recursive: true });
  symlinkSync(target, barryCurrentDir());
  const checks = await installationChecks();
  expect(checks.find(check => check.name === "current")).toMatchObject({ status: "fail", detail: "current target has no identity.yaml" });
});

it("verifies all 5 shipped global bounds in root identity.yaml without querying SQLite", async () => {
  const root = scratch();
  const validPath = join(root, "identity.yaml");
  writeFileSync(
    validPath,
    [
      "name: base",
      "bounds:",
      "  - readonly:",
      "      tools: { deny: ['*:write', '*:Bash', '*:Write', '*:Edit'] }",
      "      network: { deny: [write] }",
      "  - no-secrets:",
      "      files: { deny: ['*.env'] }",
      "  - no-network:",
      "      network: { deny: [all] }",
      "  - no-network-write:",
      "      network: { deny: [write] }",
      "  - sandboxed-offline:",
      "      network: { enforce: sandbox, allow: [], deny: [all] }",
      "",
    ].join("\n"),
  );
  await expect(checkShippedBounds(validPath)).resolves.toBe("shipped global bounds and job bounds are valid");

  const missingPath = join(root, "incomplete-identity.yaml");
  writeFileSync(
    missingPath,
    [
      "name: base",
      "bounds:",
      "  - readonly:",
      "      tools: { deny: ['*:write'] }",
      "",
    ].join("\n"),
  );
  await expect(checkShippedBounds(missingPath)).rejects.toThrow("missing shipped global bound 'no-secrets'");
});

