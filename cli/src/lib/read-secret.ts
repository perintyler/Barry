/**
 * Read one secret value WITHOUT it ever appearing on argv.
 *
 * A secret passed as a command-line argument is visible to `ps`, lands in
 * shell history, and is logged by anything auditing process starts. So the
 * value comes from a masked prompt on a TTY, or stdin when piped — never the
 * command line. This is the one place `env set`, `vault add` and
 * `identity secret set` share, so they cannot drift on where the value is
 * read from.
 */
import { password } from "@inquirer/prompts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/** Prompt (TTY) or read stdin (piped). Throws when nothing is supplied. */
export async function readSecretValue(key: string): Promise<string> {
  const value = process.stdin.isTTY ? await password({ message: `${key}:`, mask: true }) : await readStdin();
  if (value === "") throw new Error(`no value for ${key} on stdin; nothing was changed`);
  return value;
}
