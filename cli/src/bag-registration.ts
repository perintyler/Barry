import type { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { barryConfigDir } from "@barry-rocks/sdk/services";
import { loadRegistry, RegistrySnapshotError, loadBagSync } from "@barry-rocks/sdk/internal/bags";
import { resolveBagAccess } from "@barry-rocks/sdk/bags";

function loadCliConfig(): Set<string> | null {
  // A file the person edits, so it lives with their other Barry settings.
  const configPath = join(barryConfigDir(), "cli.yaml");
  if (!existsSync(configPath)) return null;

  try {
    const raw = parse(readFileSync(configPath, "utf-8"));
    // `packs:` and `blocks:` are the two pre-rename spellings (packs -> blocks
    // -> bags). Existing cli.yaml files still use them, and silently ignoring
    // one exposes no bag commands at all — which looks like the bags are
    // broken rather than the config being stale. This actually happened: the
    // blocks->bags rename left `blocks:` unhandled, so every bag CLI group
    // vanished from `barry --help` until the file was migrated by hand.
    const cfg = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
    const list = cfg
      ? [cfg.bags, cfg.blocks, cfg.packs].find((v) => Array.isArray(v))
      : undefined;
    if (Array.isArray(list)) {
      return new Set(list.filter((p: unknown): p is string => typeof p === "string"));
    }
  } catch {
    // Malformed config — treat as empty
  }
  return null;
}

export function registerBagGroups(program: Command, options: { quietWhenMissing?: boolean } = {}): Set<string> {
  const knownNames = new Set(program.commands.map((c) => c.name()));
  for (const cmd of program.commands) {
    for (const alias of cmd.aliases()) knownNames.add(alias);
  }
  /** Only the groups THIS call registered, not the pre-existing static ones. */
  const registered = new Set<string>();

  let registry: ReturnType<typeof loadRegistry>;
  try {
    registry = loadRegistry();
  } catch (err) {
    // Core commands (`barry up` among them, which rebuilds the snapshot) must
    // keep working on an instance whose registry is missing.
    if (!(err instanceof RegistrySnapshotError)) throw err;
    // A fresh instance has no registry until `barry up` seeds it; that is its
    // normal state, not something to repeat on every command.
    if (!options.quietWhenMissing) process.stderr.write(`barry: bag commands unavailable: ${err.message}\n`);
    return registered;
  }
  const enabledBags = loadCliConfig();
  if (!enabledBags || enabledBags.size === 0) return registered;

  for (const [name, source] of Object.entries(registry)) {
    if (resolveBagAccess(source) === "disabled") continue;
    if (source.type !== "local") continue;
    if (!enabledBags.has(name)) continue;

    // Load manifest only (no tool imports)
    // Sync-only: this runs before program.parse(), so remote bags (which
    // need a live MCP connection) cannot be loaded here and are skipped.
    const bag = loadBagSync(name);
    if (!bag) continue;

    // A bag earns a CLI group by having something to run. Scripts count:
    // gating on toolsEntry alone would make a scripts-only bag unreachable.
    const hasScripts = Object.keys(bag.manifest?.scripts ?? {}).length > 0;
    if (!bag.manifest || (!bag.manifest.toolsEntry && !hasScripts)) continue;

    const cliConfig = bag.manifest.cli;
    const groupName = cliConfig?.alias ?? name;

    // Don't shadow existing static commands
    if (knownNames.has(groupName)) continue;

    const group = program
      .command(groupName)
      .description(`${bag.description} (bag)`)
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments(true);

    // Lazy dispatch — Phase 2 happens here.
    // helpOption(false) prevents Commander from intercepting --help so we
    // can route it to per-tool help in the bag dispatcher.
    group.action(async (...actionArgs: unknown[]) => {
      // Commander passes (options, command) as the last two args; everything
      // before that is parsed arguments.
      const cmd = actionArgs[actionArgs.length - 1] as Command;
      await (await import("./bag-cli.js")).dispatchBagCommand(bag, cliConfig, cmd);
    });

    knownNames.add(groupName);
    registered.add(groupName);
  }

  return registered;
}

