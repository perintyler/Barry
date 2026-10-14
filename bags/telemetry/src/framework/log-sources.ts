// Discover supervised output logs by service identity so renamed services remain visible.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-054
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { barryLogsDir } from "@barry-rocks/sdk/services";

export function serviceLogSources(logDir = barryLogsDir()): Array<{ service: string; file: string }> {
  const sources: Array<{ service: string; file: string }> = [];
  let bags: string[];
  try {
    bags = readdirSync(logDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return sources; // No logs yet: nothing has run.
  }
  for (const bag of bags) {
    let files: string[];
    try {
      files = readdirSync(join(logDir, bag)).sort();
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".out.log")) continue;
      sources.push({ service: `${bag}.${name.slice(0, -".out.log".length)}`, file: join(logDir, bag, name) });
    }
  }
  return sources;
}
