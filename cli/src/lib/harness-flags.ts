import { Option, type Command } from "commander";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";

/**
 * The installed records, read without loading adapter code, or none when the
 * file is missing or unreadable: `--help` and `--version` must not fail on it,
 * and a command that needs adapters reports the error itself. Not
 * `adapterStore()`, which registers bags.
 */
export async function installedHarnesses(): Promise<InstalledAdapter[]> {
  try {
    const [{ loadAdapters }, { barryAdaptersPath }] = await Promise.all([
      import("@barry-rocks/sdk/internal/adapters"), import("@barry-rocks/sdk/services"),
    ]);
    return loadAdapters({ file: barryAdaptersPath() }).installed();
  } catch { return []; }
}

/**
 * Explicit adapter selection plus shorthand flags for each installed id and alias.
 * A name the command already declares keeps its own option, read from `command.options` rather than from a list.
 */
export function addHarnessFlags(command: Command, records: readonly InstalledAdapter[]): void {
  command.option("--adapter <name>", "Use an installed session adapter by id or alias");
  for (const record of records) {
    for (const id of [record.id, ...(record.aliases ?? [])]) {
      if (command.options.some(option => option.long === `--${id}` || option.short === `--${id}`)) continue;
      const option = new Option(`--${id}`, `Use ${record.label}${record.experimental ? " (experimental)" : ""}`);
      option.negate = false;
      // A skipped static option must never be mistaken for a harness flag.
      command.addOption(option.preset(record));
    }
  }
}

/** The record the flags name; flags naming two different harnesses are refused. */
export function flaggedHarness(options: Record<string, unknown>, records: readonly InstalledAdapter[]): InstalledAdapter | undefined {
  const named = options.adapter;
  const explicit = named === undefined ? undefined : records.find(record => record.id === named || record.aliases?.includes(String(named)));
  if (named !== undefined && !explicit) throw new Error(`${named} is not an installed adapter. See barry adapter list.`);
  const selected = records.filter(record => record === explicit || [record.id, ...(record.aliases ?? [])].some(id => {
    const option = new Option(`--${id}`);
    option.negate = false;
    return options[option.attributeName()] === record;
  }));
  if (selected.length > 1) throw new Error(`Conflicting harness flags: ${selected.map(record => record.id).join(", ")}`);
  return selected[0];
}
