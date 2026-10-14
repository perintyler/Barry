import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineAdapter } from "./index.js";
import { testAdapter } from "./testing.js";
import { HarnessVersionMismatch, majorOf, requireVerifiedMajor } from "./version-guard.js";

let dir: string;
let cacheFile: string;
/** The guard is off in every suite; these turn it back on. */
const env = () => ({ PATH: dir, BARRY_HARNESS_VERSION_CHECK: "on" });

/** An executable named `fake` on `dir` that prints `output`. */
function fakeBinary(output: string): string {
  const path = join(dir, "fake");
  writeFileSync(path, `#!/bin/sh\necho "${output}"\n`);
  chmodSync(path, 0o755);
  return path;
}

const adapter = testAdapter({
  id: "fake",
  requirements: {
    binary: {
      command: "fake",
      versionArgs: ["--version"],
      versionPattern: "(\\d+\\.\\d+\\.\\d+)",
      install: { darwin: "brew install fake", fallback: "see fake.dev" },
      pin: { version: "2.0.24", enforcedBy: "nothing" },
    },
  },
});
const verified = { verifiedOn: "2.0.24" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "version-guard-"));
  cacheFile = join(dir, "cache", "harness-versions.json");
});

describe("the launch version check", () => {
  it.each([
    ["0.160.1", "0.160.2", false],
    ["0.160.1", "0.161.0", true],
    ["0.160.1", "0.159.9", true],
    ["2026.09.23", "2026.09.24", false],
    ["2026.09.23", "2026.10.01", true],
    ["2026.09.23", "2025.09.23", true],
  ])("checks the compatibility family verified=%s observed=%s", (verifiedOn, observed, refused) => {
    fakeBinary(`fake ${observed}`);
    const run = () => requireVerifiedMajor(adapter, { verifiedOn }, { env: env(), cacheFile });
    if (refused) {
      expect(run).toThrow(HarnessVersionMismatch);
      expect(run).toThrow(/different major\.minor version/);
    }
    else expect(run).not.toThrow();
  });

  it("refuses another major version, naming the binary and the install command", () => {
    const binary = fakeBinary("fake v1.18.34");
    const refusal = () => requireVerifiedMajor(adapter, verified, { env: env(), cacheFile, platform: "darwin" });
    expect(refusal).toThrow(HarnessVersionMismatch);
    expect(refusal).toThrow(
      `fake will not start: ${binary} is 1.18.34, but this adapter was verified on 2.0.24, and a different major version is not one it can drive. ` +
        "Install the verified build (brew install fake) and make sure it comes first on PATH, or set BARRY_HARNESS_VERSION_CHECK=off to start it anyway.",
    );
  });

  it("starts a newer minor or patch of the verified major", () => {
    fakeBinary("fake 2.3.1");
    expect(() => requireVerifiedMajor(adapter, verified, { env: env(), cacheFile })).not.toThrow();
  });

  it("does not check a bundled build, which the binary on PATH says nothing about", () => {
    fakeBinary("fake 1.0.0");
    expect(() => requireVerifiedMajor(adapter, { ...verified, build: "bundled" }, { env: env(), cacheFile })).not.toThrow();
  });

  it("starts when it cannot read a version: a missing binary, or output with none", () => {
    expect(() => requireVerifiedMajor(adapter, verified, { env: env(), cacheFile })).not.toThrow();
    fakeBinary("no version here");
    expect(() => requireVerifiedMajor(adapter, verified, { env: env(), cacheFile })).not.toThrow();
  });

  it("is off when BARRY_HARNESS_VERSION_CHECK=off", () => {
    fakeBinary("fake 1.0.0");
    expect(() => requireVerifiedMajor(adapter, verified, { env: { PATH: dir, BARRY_HARNESS_VERSION_CHECK: "off" }, cacheFile })).not.toThrow();
  });

  it("runs an unchanged binary once, and again once it changes", () => {
    const binary = fakeBinary("fake 2.0.24");
    const run = vi.fn(() => "fake 2.0.24\n");
    requireVerifiedMajor(adapter, verified, { env: env(), cacheFile, run });
    requireVerifiedMajor(adapter, verified, { env: env(), cacheFile, run });
    expect(run).toHaveBeenCalledTimes(1);

    utimesSync(binary, new Date(), new Date(Date.now() + 60_000));
    run.mockReturnValue("fake 1.0.0\n");
    expect(() => requireVerifiedMajor(adapter, verified, { env: env(), cacheFile, run })).toThrow(/is 1\.0\.0/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reads majors from semantic and calendar versions", () => {
    expect(majorOf("2.0.24")).toBe(2);
    expect(majorOf("2026.09.23")).toBe(2026);
    expect(majorOf("0.0.0-test")).toBe(0);
    expect(majorOf("unknown")).toBeNull();
  });
});

describe("an adapter defined through defineAdapter", () => {
  it("checks the version before a mode plans its launch", () => {
    fakeBinary("fake 1.18.34");
    const base = testAdapter();
    const plan = vi.fn(base.modes.guest!.plan);
    const defined = defineAdapter({ ...adapter, modes: { ...base.modes, guest: { ...base.modes.guest!, verifiedOn: "2.0.24", plan } } });
    const config = { sessionId: "s", cwd: dir, env: env(), mcpServers: {} };

    expect(() => defined.modes.guest!.plan(config)).toThrow(HarnessVersionMismatch);
    expect(plan).not.toHaveBeenCalled();
  });

  it("a declared executable path wins over PATH", () => {
    fakeBinary("fake 1.18.34");
    const installed = join(dir, "installed");
    writeFileSync(installed, "#!/bin/sh\necho 2.0.24\n", { mode: 0o755 });
    const declared = { ...adapter, requirements: { binary: { ...adapter.requirements.binary, paths: [join(dir, "missing"), installed] } } };
    const run = vi.fn(() => "2.0.24");
    requireVerifiedMajor(declared, verified, { env: env(), cacheFile, run });
    expect(run).toHaveBeenCalledWith(installed, ["--version"]);
  });

  it("a missing declared path falls back to PATH", () => {
    const binary = fakeBinary("fake 1.18.34");
    const declared = { ...adapter, requirements: { binary: { ...adapter.requirements.binary, paths: [join(dir, "missing")] } } };
    const run = vi.fn(() => "2.0.24");
    requireVerifiedMajor(declared, verified, { env: env(), cacheFile, run });
    expect(run).toHaveBeenCalledWith(binary, ["--version"]);
  });
});
