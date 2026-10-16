import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkRequirements, formatChecks, preflightLine, type HostProbes } from "./checks.js";
import type { Requirements } from "../adapters/harnesses/index.js";

const requirements: Requirements = {
  binary: {
    command: "codex",
    versionArgs: ["--version"],
    versionPattern: "(\\d+\\.\\d+\\.\\d+)",
    install: { darwin: "brew install codex", fallback: "npm i -g @openai/codex" },
    pin: { version: "0.115.0", enforcedBy: "package manager" },
  },
};

function probes(host: { onPath?: boolean; version?: string | null; loggedIn?: boolean }): HostProbes {
  return {
    which: (command) => (host.onPath === false ? null : `/usr/local/bin/${command}`),
    run: (command, args) => {
      if (args[0] === "--version") return host.version === null ? null : { stdout: `${basename(command)} ${host.version ?? "0.115.0"}\n`, code: 0 };
      return { stdout: "", code: host.loggedIn === false ? 1 : 0 };
    },
    platform: "darwin",
  };
}

const HOSTS = {
  healthy: {},
  "binary missing": { onPath: false },
  "version unreadable": { version: "unknown build" },
  "binary will not run": { version: null },
  "pin mismatch": { version: "0.116.2" },
};

describe("checkRequirements", () => {
  // Recorded while every host above still matched the report doctor printed
  // before requirements moved here.
  it("reports every host as recorded", async () => {
    const recorded: Record<string, unknown> = {};
    for (const [name, host] of Object.entries(HOSTS)) {
      const checks = checkRequirements(requirements, probes(host));
      recorded[name] = { report: formatChecks("codex", checks), preflight: preflightLine("codex", checks) };
    }
    await expect(JSON.stringify(recorded, null, 2) + "\n").toMatchFileSnapshot("./__golden__/checks-report.json");
  });

  it("always reports all three, so a skipped check is visible", () => {
    const checks = checkRequirements(requirements, probes({ onPath: false }));
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["binary", "failed"],
      ["version", "unknown"],
      ["compatibility", "unknown"],
    ]);
  });
});

it.each([true, false])("checks a declared binary path when available: %s", available => {
  const which = vi.fn((command: string) => command === "/installed/codex" ? available ? command : null : "/path/codex");
  const run = vi.fn(() => ({ stdout: "0.115.0", code: 0 }));
  const checks = checkRequirements({ binary: { ...requirements.binary, paths: ["/installed/codex"] } }, { which, run, platform: "darwin" });
  const expected = available ? "/installed/codex" : "/path/codex";
  expect(checks[0]).toMatchObject({ status: "ok", observed: expected });
  expect(run).toHaveBeenCalledWith(expected, ["--version"]);
  expect(which.mock.calls.map(([command]) => command)).toEqual(available ? ["/installed/codex"] : ["/installed/codex", "codex"]);
});

it("reports recommendations as advisory while retaining explicit incompatibilities", () => {
  const mode = { verifiedOn: "0.115.0", versions: { recommendedVersion: "0.115.0", testedVersions: ["0.115.0"], supportedVersions: [{ min: "0.115.0", max: "0.116.0" }], incompatibleVersions: [{ range: { min: "0.116.2", max: "0.116.2" }, reason: "known tool regression" }] } };
  expect(checkRequirements(requirements, probes({ version: "0.116.0" }), mode).at(-1)).toMatchObject({ status: "ok", observed: expect.stringContaining("guarantees unverified") });
  expect(checkRequirements(requirements, probes({ version: "0.117.0" }), mode).at(-1)).toMatchObject({ status: "warning" });
  expect(checkRequirements(requirements, probes({ version: "0.116.2" }), mode).at(-1)).toMatchObject({ status: "failed", observed: expect.stringContaining("known tool regression") });
});
