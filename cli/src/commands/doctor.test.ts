import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { adapterPreflightNotices } from "./doctor.js";
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
    const lines = await adapterPreflightNotices("claude", probes);
    expect(lines.join("\n")).toMatch(/could not run/i);
  });
});
