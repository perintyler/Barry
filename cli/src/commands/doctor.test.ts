import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { adapterPreflightNotices, cachedHostProbes } from "./doctor.js";
import { resetAdapterStore } from "../adapters/installed.js";

// The fixture explicitly selects its adapter in an isolated installation.
const saved = process.env.BARRY_HOME;
const home = mkdtempSync(join(tmpdir(), "barry-doctor-home-"));
beforeAll(async () => {
  process.env.BARRY_HOME = home;
  resetAdapterStore();
  const { loadAdapters } = await import("@barry-rocks/sdk/internal/adapters");
  const { barryAdaptersPath } = await import("@barry-rocks/sdk/services");
  const { fileURLToPath } = await import("node:url");
  await loadAdapters({ file: barryAdaptersPath() }).add(fileURLToPath(new URL("../../../adapters/sessions/claude/", import.meta.url)));
});
afterAll(() => {
  if (saved === undefined) delete process.env.BARRY_HOME;
  else process.env.BARRY_HOME = saved;
  resetAdapterStore();
  rmSync(home, { recursive: true, force: true });
});

describe("preflight when its own diagnostic breaks", () => {
  it("reports the breakage instead of the silence a healthy adapter produces", async () => {
    // Returning [] here made "the probe exploded" and "nothing to report"
    // identical to the caller, which prints one line per entry.
    const probes = {
      which: () => { throw new Error("probe exploded"); },
      run: () => { throw new Error("probe exploded"); },
      platform: "darwin" as const,
    };
    const { loadAdapters } = await import("@barry-rocks/sdk/internal/adapters");
    const { barryAdaptersPath } = await import("@barry-rocks/sdk/services");
    await loadAdapters({ file: barryAdaptersPath() }).add((await import("node:url")).fileURLToPath(new URL("../../../adapters/sessions/codex/", import.meta.url)));
    const lines = await adapterPreflightNotices("codex", probes);
    expect(lines.join("\n")).toMatch(/could not run/i);
  });
});

it("caches successful version probes across launches, invalidates changed binaries, and keeps auth live", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-probe-cache-"));
  try {
    const binary = join(root, "claude"); writeFileSync(binary, "version-one");
    let versions = 0, auth = 0;
    const probes = {
      platform: "darwin" as const,
      which: () => binary,
      run: (_command: string, args: readonly string[]) => {
        if (args[0] === "--version") return { stdout: `version-${++versions}`, code: 0 };
        return { stdout: `auth-${++auth}`, code: 0 };
      },
    };
    for (let invocation = 0; invocation < 2; invocation++) {
      const cached = cachedHostProbes(probes, join(root, "cache"));
      expect(cached.which("claude")).toBe(binary);
      expect(cached.run("claude", ["--version"]).stdout).toBe("version-1");
      cached.run("claude", ["auth", "status"]);
    }
    expect(versions).toBe(1); expect(auth).toBe(2);
    appendFileSync(binary, "changed");
    expect(cachedHostProbes(probes, join(root, "cache")).run(binary, ["--version"]).stdout).toBe("version-2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("assesses the selected CLI mode independently of its bundled default", async () => {
  const probes = { platform: "darwin" as const, which: () => null, run: () => ({ stdout: "", code: 1 }) };
  expect((await adapterPreflightNotices("claude", probes)).join(" ")).toContain("2.1.282: ok");
  expect((await adapterPreflightNotices("claude", probes, "guest")).join(" ")).toContain("claude not found on PATH");
});
