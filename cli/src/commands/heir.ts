/**
 * barry heir to the <name> empire — the easter-egg spelling of
 * `barry identity create <name>`. Only the phrase lives here; creation is
 * shared with `identity create` in `identity-create.ts`.
 */

import {
  createIdentity,
  nameIdentity,
  type CreateIdentityOptions,
  type CreationWording,
} from "./identity-create.js";
import { CliError } from "../lib/cli-error.js";

/** heir's flavor text; everything else is `identity create`'s. */
const HEIR_WORDING: CreationWording = {
  starting: (name) => `Birthing Barry ${name}...`,
  ready: (name) => `Barry ${name} is ready.`,
};

/**
 * Parse `heir to the <name> empire` from raw CLI args.
 *
 * The phrase is: `barry heir to the <...name words...> empire`
 * Returns the extracted name or null if the phrase doesn't match.
 */
export function parseBirthPhrase(args: string[]): { name: string; slug: string } | null {
  // args = ["to", "the", ..., "empire"]
  if (args.length < 4) return null;
  if (args[0] !== "to" || args[1] !== "the") return null;
  if (args[args.length - 1] !== "empire") return null;

  const nameWords = args.slice(2, -1);
  if (nameWords.length === 0) return null;

  return nameIdentity(nameWords.join(" "));
}

export async function heirCommand(
  args: string[],
  options: CreateIdentityOptions = {},
): Promise<void> {
  const parsed = parseBirthPhrase(args);
  if (!parsed) {
    throw new CliError("Usage: barry heir to the <name> empire" + "\n" + "" + "\n" + "Examples:" + "\n" + "  barry heir to the B. Goode empire" + "\n" + "  barry heir to the Bucks empire" + "\n" + "  barry heir to the Jazz empire", 1);
  }
  await createIdentity(parsed, options, HEIR_WORDING);
}
