import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { barryReleasesDir } from "@barry-rocks/sdk/services";
import { currentInstallation, installationExists } from "./current.js";
import { installationLabel, readReceipts, type Installation, type Receipt } from "./receipts.js";
import { readRelease } from "./release.js";

interface ReleaseState {
  previous?: Installation;
  lastChange?: { kind: Receipt["kind"]; from: Installation; to: Installation; time: string; state: Receipt["state"] };
  interrupted?: Receipt;
  problems: string[];
}
export function releaseState(): ReleaseState {
  const state: ReleaseState = { problems: [] };
  if (process.env.BARRY_RELEASE_SKEW) state.problems.push(process.env.BARRY_RELEASE_SKEW);
  try {
    const current = currentInstallation();
    if (current.kind === "missing") state.problems.push(`current points at ${current.target}, which does not exist`);
  } catch (error) { state.problems.push(`current: ${String(error)}`); }
  try {
    const receipts = readReceipts(), latest = receipts[0], complete = receipts.find(receipt => receipt.state === "complete");
    if (complete && installationExists(complete.from)) state.previous = complete.from;
    if (latest) {
      state.lastChange = { kind: latest.kind, from: latest.from, to: latest.to, time: latest.finished ?? latest.started, state: latest.state };
      if (["started", "switched"].includes(latest.state)) {
        state.interrupted = latest;
        state.problems.push(`${latest.kind} to ${installationLabel(latest.to)} interrupted at ${latest.started}: run barry upgrade${latest.kind === "rollback" ? " --rollback" : ""} again`);
      }
      if (!installationExists(latest.from)) state.problems.push(`${installationLabel(latest.from)} is missing; no rollback is possible`);
    }
  } catch (error) { state.problems.push(`release receipts: ${String(error)}`); }
  if (existsSync(barryReleasesDir())) for (const entry of readdirSync(barryReleasesDir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(barryReleasesDir(), entry.name, "release.json"))) continue;
    try { readRelease(join(barryReleasesDir(), entry.name)); }
    catch (error) { state.problems.push(`release ${entry.name}: ${String(error)}`); }
  }
  return state;
}
export function reportReleaseProblems(): void {
  const { problems } = releaseState();
  // An instance with nothing to report, such as one with no current, keeps doctor's output unchanged.
  if (!problems.length) return;
  console.log("Release");
  for (const problem of problems) console.log(`  ${problem}`);
  process.exitCode = 1;
}
