// Build contributions once at boot from the installed registry, isolating malformed entries.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-047

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PanelRegistry, type PanelContribution } from "./contributed-panels.js";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";

// Read declarations from installed bag manifests, without discovering arbitrary directories.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-048
export function panelContributionsPath(): string {
  return (
    process.env.BARRY_PANEL_CONTRIBUTIONS ??
    join(barryAppSupportDir(), "bag-panels.json")
  );
}

interface ContributionsFile {
  version: 1;
  panels: PanelContribution[];
}

// Validate and register every contribution; one bad bag must not suppress the others.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-049
export function loadPanelContributions(path = panelContributionsPath()): PanelRegistry {
  const registry = new PanelRegistry();
  if (!existsSync(path)) return registry;

  let parsed: ContributionsFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ContributionsFile;
  } catch (err) {
    process.stderr.write(`panel contributions at ${path} are unreadable: ${String(err)}\n`);
    return registry;
  }

  for (const panel of parsed?.panels ?? []) {
    try {
      registry.register(panel);
    } catch (err) {
      process.stderr.write(`skipped a contributed panel: ${String(err)}\n`);
    }
  }
  return registry;
}
