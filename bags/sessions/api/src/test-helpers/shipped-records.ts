/**
 * The six explicitly selected adapter packages, recorded in an isolated store.
 * For what a record carries that a fixture would only restate — labels, the
 * curated list a vendorless harness offers.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";

const ADAPTERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../adapters");

export async function shippedRecords(): Promise<InstalledAdapter[]> {
  const adapters = loadAdapters({ file: join(mkdtempSync(join(tmpdir(), "barry-shipped-records-")), "adapters.json") });
  for (const dir of ["antigravity", "claude", "codex", "cursor", "opencode", "pi"]) {
    await adapters.add(join(ADAPTERS_DIR, "sessions", dir));
  }
  return adapters.installed();
}
