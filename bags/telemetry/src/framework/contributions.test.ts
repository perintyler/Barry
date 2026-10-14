import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPanelContributions } from "./contributions.js";

const dir = mkdtempSync(join(tmpdir(), "panels-"));
let n = 0;
function file(contents: string): string {
  const p = join(dir, `c${n++}.json`);
  writeFileSync(p, contents);
  return p;
}

afterEach(() => vi.restoreAllMocks());
const quiet = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);

const good = {
  bag: "weather", resource: "web", id: "forecast", title: "Forecast",
  dataPath: "/api/panel", page: "/", columns: ["Day"],
};

describe("loading contributions", () => {
  // An absent contribution file must not stop the dashboard needed to diagnose the absence.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-030
  it("treats a missing file as nothing contributed", () => {
    expect(loadPanelContributions(join(dir, "nope.json")).all()).toEqual([]);
  });

  it("treats an unreadable file as nothing contributed, loudly", () => {
    const stderr = quiet();
    expect(loadPanelContributions(file("{ not json")).all()).toEqual([]);
    expect(stderr.mock.calls.join("")).toMatch(/unreadable/);
  });

  it("registers what is declared", () => {
    const loaded = loadPanelContributions(file(JSON.stringify({ version: 1, panels: [good] })));
    expect(loaded.all().map((p) => p.key)).toEqual(["weather.forecast"]);
  });

  // One malformed contribution fails only its owner, preserving other bags’ panels.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-031
  it("skips a bad declaration without dropping the good ones", () => {
    const stderr = quiet();
    const loaded = loadPanelContributions(
      file(JSON.stringify({
        version: 1,
        panels: [{ ...good, bag: "bad", id: "NOT SAFE" }, good, { ...good, id: "elsewhere" }],
      })),
    );
    expect(loaded.all().map((p) => p.key)).toEqual(["weather.forecast", "weather.elsewhere"]);
    expect(stderr.mock.calls.join("")).toMatch(/skipped a contributed panel/);
  });
});
