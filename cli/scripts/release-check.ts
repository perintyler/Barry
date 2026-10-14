import { probeRelease } from "../src/releases/probe.js";
import { checkReleaseDirectory } from "../src/releases/check.js";
import { releaseRoot } from "../src/releases/release.js";
const report = await probeRelease();
report.problems.push(...checkReleaseDirectory(releaseRoot(), report));
console.log(JSON.stringify(report));
if (report.problems.length) process.exitCode = 1;
