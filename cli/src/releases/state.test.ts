import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { barryCurrentDir, barryReleasesDir } from "@barry-rocks/sdk/services";
import { copyRelease, pointCurrent } from "./current.js";
import { readReceipts, receiptId, writeReceipt, type Receipt } from "./receipts.js";
import { releaseState, reportReleaseProblems } from "./state.js";
import { fixtureRelease, scratchEnvironment } from "./__tests__/release-home.js";
beforeEach(scratchEnvironment);
afterEach(() => { process.exitCode = 0; });
function fixture() {
  const a = fixtureRelease(), b = fixtureRelease("2.0.0", {}, "b".repeat(40));
  copyRelease(a.root, a.release); pointCurrent(copyRelease(b.root, b.release));
  const receipt: Receipt = { format: 1, id: receiptId(), kind: "upgrade", state: "complete", from: { kind: "release", version: a.release.version, commit: a.release.commit }, to: { kind: "release", version: b.release.version, commit: b.release.commit }, generations: { before: null, after: null }, snapshot: null, services: [], started: new Date().toISOString(), finished: new Date().toISOString() };
  writeReceipt(receipt); return receipt;
}
it("reports the previous installation and last completed change", () => {
  const receipt = fixture(), state = releaseState();
  expect(state.previous).toEqual(receipt.from); expect(state.lastChange).toEqual({ kind: "upgrade", from: receipt.from, to: receipt.to, time: receipt.finished, state: "complete" }); expect(state.problems).toEqual([]);
});
it.each(["started", "switched"] as const)("reports an interrupted %s receipt", state => {
  const receipt = fixture(); writeReceipt({ ...receipt, state });
  expect(releaseState().interrupted?.state).toBe(state); expect(releaseState().problems.join()).toContain("run barry upgrade again");
});
it("reports a dangling selector", () => {
  pointCurrent("/missing/barry-checkout"); expect(releaseState().problems.join()).toContain("which does not exist");
});
it("reports a missing rollback target", () => {
  fixture(); rmSync(join(barryReleasesDir(), "1.0.0"), { recursive: true }); expect(releaseState().previous).toBeUndefined(); expect(releaseState().problems.join()).toContain("no rollback is possible");
});
it("reports malformed release metadata", () => {
  const root = join(barryReleasesDir(), "bad"); mkdirSync(root, { recursive: true }); writeFileSync(join(root, "release.json"), "{}"); expect(releaseState().problems.join()).toContain("release bad");
});
it("prints nothing for doctor without current or receipts", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  reportReleaseProblems(); expect(console.log).not.toHaveBeenCalled(); expect(process.exitCode ?? 0).toBe(0);
});
it("tells an interrupted rollback to finish with --rollback", () => {
  const receipt = fixture(); writeReceipt({ ...receipt, kind: "rollback", state: "switched", from: receipt.to, to: receipt.from });
  expect(releaseState().problems.join()).toContain("run barry upgrade --rollback again");
});
it("sets doctor's exit code when release problems exist", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  fixture(); rmSync(barryCurrentDir()); pointCurrent("/missing/barry-checkout");
  reportReleaseProblems(); expect(process.exitCode).toBe(1); expect(console.log).toHaveBeenCalledWith("Release"); expect(readReceipts()).toHaveLength(1);
});
