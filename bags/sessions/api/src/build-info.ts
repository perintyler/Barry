import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installationRoot } from "@barry-rocks/sdk/services";
import { MIGRATIONS } from "@barry-rocks/sessions-bag/store/sessions-db";
/** Captured at boot, so a still-running old process reports its own build. */
export const buildInfo = (() => {
  let release: { version: string; commit: string } | null = null;
  try {
    const value = JSON.parse(readFileSync(join(installationRoot(), "release.json"), "utf8")) as { version?: string; commit?: string };
    if (typeof value.version === "string" && typeof value.commit === "string") release = { version: value.version, commit: value.commit };
  } catch { /* A development checkout has no release metadata. */ }
  return { release, schema: { sessions: MIGRATIONS.length } };
})();
