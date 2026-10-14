/**
 * Read the mode-0600 instance secrets file by declared service key or explicit CLI name; never load every installation secret into an agent environment.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateBarrySecret } from "../auth/internal.js";
import { barryEnvPath } from "./home.mjs";

/** Parse `KEY=VALUE` lines. Blank lines and `#` comments are skipped; one layer of quotes is removed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "");
    out[match[1]] = value;
  }
  return out;
}

/** Every key in the instance env. Absent file means none. */
export function readInstanceEnv(path = barryEnvPath()): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnvFile(readFileSync(path, "utf8"));
}

/** Read one value from the selected instance's private file. */
export function instanceEnvValue(key: string, path?: string): string | undefined {
  const value = readInstanceEnv(path)[key];
  return value === "" ? undefined : value;
}

/**
 * Set one key, keeping every other line (comments included) as it was.
 *
 * Written through a temp file and a rename, at mode 0600, so a crash never
 * leaves half a secrets file and no other user can read it.
 */
export function setInstanceEnvValue(key: string, value: string, path = barryEnvPath()): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`not an env key: ${JSON.stringify(key)}`);
  if (/[\r\n]/.test(value)) throw new Error(`${key}: a value cannot span lines`);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const assignment = `${key}=${quoteEnvValue(key, value)}`;
  const matchingLineIndex = lines.findIndex((l) => new RegExp(`^(?:export\\s+)?${key}\\s*=`).test(l.trim()));
  if (matchingLineIndex === -1) lines.push(assignment);
  else lines[matchingLineIndex] = assignment;
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, lines.join("\n") + "\n", { mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

/**
 * A value as `parseEnvFile` reads it back. Quotes are stripped, never
 * unescaped, so a value is wrapped in whichever quote it does not contain.
 */
function quoteEnvValue(key: string, value: string): string {
  if (!/[\s#"']/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new Error(`${key}: a value cannot hold both kinds of quote`);
}

/**
 * Generate `BARRY_SECRET` into the instance env when it has none; true when it did.
 *
 * Every service and client authenticates with it, so an instance without one
 * starts nothing. `barry setup` calls this for the installed instance and
 * `barry up` for a contributor or test one, which its first `up` creates.
 * Reads the file only, never the calling shell: a shell exporting an old
 * secret would otherwise leave the file without one, and service management
 * launchd starts has no shell.
 */
export function ensureInstanceSecret(path = barryEnvPath()): boolean {
  if (readInstanceEnv(path).BARRY_SECRET) return false;
  setInstanceEnvValue("BARRY_SECRET", generateBarrySecret(), path);
  return true;
}

/** Whether the instance env is readable by anyone but its owner. */
export function instanceEnvIsPrivate(path = barryEnvPath()): boolean {
  if (!existsSync(path)) return true;
  return (statSync(path).mode & 0o077) === 0;
}
