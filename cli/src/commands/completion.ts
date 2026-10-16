import { toolDefinitions, applyToolVisibility } from "@barry-rocks/sdk/internal/tools";
import { cliName } from "../target.js";
import { shellWord } from "@barry-rocks/sdk/internal/services";

/**
 * Shell tab completion for barry CLI.
 *
 * `barry completion` outputs a shell script that enables tab completion.
 * `barry __complete <args...>` is the hidden callback used by the completion script.
 *
 * Usage:
 *   eval "$(barry completion)"          # add to .zshrc or .bashrc
 *   barry completion > ~/.barry/completion.sh && source ~/.barry/completion.sh
 */

import type { Command } from "commander";
import { loadRegistry, loadBagSync } from "@barry-rocks/sdk/internal/bags";

import type { Bag } from "@barry-rocks/sdk/bags";
import { buildCliSpec } from "@barry-rocks/sdk/tools";

/**
 * Output a zsh/bash completion script.
 */
export function completionCommand(): void {
  const name = cliName();
  const command = shellWord(name);
  const functionName = /^[A-Za-z0-9_]+$/.test(name) ? `_${name}` : `_barry_${Buffer.from(name).toString("hex")}`;
  const script = `
# Barry CLI completion (auto-generated)
# Add to your .zshrc: eval "$(${command} completion)"

if type compdef &>/dev/null; then
  ${functionName}() {
    local completions
    completions=("\${(@f)$(${command} __complete "\${words[@]:1}")}")
    compadd -a completions
  }
  compdef ${functionName} ${command}
elif type complete &>/dev/null; then
  ${functionName}() {
    local completions
    completions=$(${command} __complete "\${COMP_WORDS[@]:1}")
    COMPREPLY=( $(compgen -W "$completions" -- "\${COMP_WORDS[COMP_CWORD]}") )
  }
  complete -F ${functionName} ${command}
fi
`.trim();

  console.log(script);
}

/**
 * Hidden completion callback — returns one completion per line.
 * Called by the shell completion script with the current command line args.
 *
 * `program` is the live, fully-registered Commander instance — passed in
 * rather than imported, so this never needs to re-run `program.parse()` to
 * get it. By the time `__complete`'s action fires (during `program.parse()`
 * in index.ts), `registerBagGroups` has already run, so `program.commands`
 * already contains both static AND bag-generated groups in one tree.
 */
export async function completeCommand(args: string[], program: Command): Promise<void> {
  const completions = await getCompletions(args, program);
  for (const c of completions) console.log(c);
}

/**
 * Complete the live Commander tree, including visible aliases, at arbitrary depth.
 * Lazy bag groups require registry lookup because they have no Commander children;
 * reserved hidden blockers have no completion subtree. See docs/decisions/0041-command-classification-and-completion.md.
 */
async function getCompletions(args: string[], program: Command): Promise<string[]> {
  let current: Command = program;

  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    const isLastWord = i === args.length - 1;

    const visible = visibleChildNames(current);
    const next = current.commands.find(
      (c) => visible.has(c.name()) && (c.name() === word || c.aliases().includes(word)),
    );

    if (!next) {
      // `word` doesn't (yet) name a real subcommand of `current`. If we're
      // still typing it (last word), offer `current`'s subcommands for shell
      // filtering. If it's an earlier word that just doesn't match anything,
      // there's nothing sensible left to offer past a wrong turn.
      return isLastWord ? visibleSubcommandNames(current) : [];
    }

    if (isLastWord) {
      // `word` names a complete command AND is the word being completed —
      // ambiguous between "show me its subcommands" and "still typing this
      // one for a sibling match". Prefer subcommands when it has any (static
      // groups like `db`); fall through to bag-tool completion when it
      // doesn't (a bag group with no yet-loaded subcommands, or a genuine
      // static leaf like `identity model set`).
      const ownSubcommands = visibleSubcommandNames(next);
      if (ownSubcommands.length > 0) return ownSubcommands;
      return tryBagGroupCompletions(word);
    }

    if (next.commands.length === 0) {
      // Reached a leaf (or a lazily-loaded bag group) with more words still
      // to come — hand off to bag-tool/flag completion for the remainder.
      return completeBagRemainder(next.name(), args.slice(i + 1));
    }

    current = next;
  }

  // No args at all: top-level names, static + bag-generated, from one walk
  // of the real tree rather than a hand-maintained array unioned with a
  // separate bag-registry scan.
  return visibleSubcommandNames(program);
}

/** The subcommands of `parent` that `--help` would list.
 *
 *  Asks Commander through `createHelp().visibleCommands()` rather than reading
 *  the private `_hidden` field: that field is not in the public d.ts, and this
 *  is the same call `helpInformation()` makes to decide what to show. Keeping
 *  the two in agreement is the point -- `__complete` marks itself
 *  `{ hidden: true }` precisely so it never suggests itself.
 *
 *  `visibleCommands()` also reports the implicit `help` command, which is not
 *  in `parent.commands`; callers intersect against that list, so it drops out. */
function visibleChildNames(parent: Command): Set<string> {
  return new Set(parent.createHelp().visibleCommands(parent).map((c) => c.name()));
}

function visibleSubcommandNames(cmd: Command): string[] {
  const visible = visibleChildNames(cmd);
  return cmd.commands.map((c) => c.name()).filter((name) => visible.has(name));
}

/** Bag-tool completion for whatever comes after a bag group name, preserving
 *  the old tool-name / flag-name resolution by argument count. */
async function completeBagRemainder(group: string, rest: string[]): Promise<string[]> {
  if (rest.length === 0) return tryBagGroupCompletions(group);
  if (rest.length === 1) return tryBagGroupCompletions(group);
  // rest.length >= 2: a tool name was typed, now typing flags for it.
  const flags = await getToolFlagCompletions(group, rest[0]);
  if (flags.length > 0) return flags;
  return tryBagGroupCompletions(group);
}

async function tryBagGroupCompletions(group: string): Promise<string[]> {
  const registry = loadRegistry();
  for (const [name, source] of Object.entries(registry)) {
    if (source.disabled || source.type !== "local") continue;
    const result = loadBagSync(name);
    if (!result) continue;
    if (!result.manifest?.toolsEntry) continue;

    const groupName = result.manifest.cli?.alias ?? name;
    if (groupName !== group) continue;

    return await getBagToolCompletions(result);
  }
  return [];
}

async function getBagToolCompletions(bag: Bag): Promise<string[]> {
  if (!bag.manifest?.toolsEntry || bag.source.type !== "local") return [];

  const path = await import("node:path");
  const os = await import("node:os");
  const bagDir = bag.source.path.replace(/^~/, os.homedir());
  const entryFile = path.join(bagDir, bag.manifest.toolsEntry.entry);

  try {
    const mod = await import(entryFile);
    const tools = toolDefinitions(mod);

    return applyToolVisibility(tools, bag.manifest.toolVisibility ?? {})
      .filter((t) => !t.deferred)
      .map((t) => buildCliSpec(t as Parameters<typeof buildCliSpec>[0]).command)
      .filter((cmd) => cmd.length > 0);
  } catch {
    return [];
  }
}

async function getToolFlagCompletions(group: string, toolCommand: string): Promise<string[]> {
  const registry = loadRegistry();
  for (const [name, source] of Object.entries(registry)) {
    if (source.disabled || source.type !== "local") continue;
    const result = loadBagSync(name);
    if (!result) continue;
    if (!result.manifest?.toolsEntry) continue;

    const groupName = result.manifest.cli?.alias ?? name;
    if (groupName !== group) continue;
    if (result.source.type !== "local") continue;

    const bagDir = result.source.path.replace(/^~/, (await import("os")).homedir());
    const entryFile = (await import("path")).join(bagDir, result.manifest.toolsEntry.entry);

    try {
      const mod = await import(entryFile);
      const tools = Object.values(mod).filter(
        (v): v is { name: string; namespace: string; handler: unknown; schema: Record<string, unknown> } =>
          typeof v === "object" && v !== null && "name" in v && "handler" in v && "namespace" in v,
      );

      for (const tool of tools) {
        const spec = buildCliSpec(tool as Parameters<typeof buildCliSpec>[0]);
        if (spec.command === toolCommand && !spec.excluded) {
          const flags = spec.options
            .map((o) => {
              const match = o.flags.match(/^(--[a-z0-9-]+)/);
              return match ? match[1] : null;
            })
            .filter((f): f is string => f !== null);
          flags.push("--json");
          return flags;
        }
      }
    } catch {
      return [];
    }
  }
  return [];
}

