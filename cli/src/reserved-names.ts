/** Hidden list/delete blockers reserve generic names against bag claims. See docs/decisions/0041-command-classification-and-completion.md. */

import type { Command } from "commander";

/**
 * Reserve the hidden name and reject invocation with its supported replacement.
 * Disable help interception and accept arbitrary tails so the action always gives guidance.
 * See docs/decisions/0041-command-classification-and-completion.md.
 */
export function registerReservedName(
  program: Command,
  oldName: string,
  newPathSegments: readonly string[],
): void {
  const newSpelling = `barry ${newPathSegments.join(" ")}`;

  program
    .command(oldName, { hidden: true })
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments(true)
    .argument("[args...]")
    .action(() => {
      console.error(`barry ${oldName} is now ${newSpelling}. Run that instead.`);
      process.exitCode = 1;
    });
}
