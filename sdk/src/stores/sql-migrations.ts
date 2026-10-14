import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Migration } from "./migrate.js";

function contained(root: string, path: string): void {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("..")) {
    throw new Error("migration paths must remain inside the bag root");
  }
}

/** Read the authored SQL history. Directory and file symlinks cannot escape the bag. */
export function loadSqlMigrations(bagRoot: string, directory: string): Migration[] {
  if (isAbsolute(directory)) throw new Error("migrations must be relative to the bag root");
  const root = realpathSync(bagRoot);
  const requested = resolve(root, directory);
  contained(root, requested);
  const path = realpathSync(requested);
  contained(root, path);
  if (!statSync(path).isDirectory()) throw new Error("migrations must reference a directory");
  const entries = readdirSync(path).map((name) => {
    const match = /^(\d{3,})_([a-z0-9][a-z0-9_-]*)\.sql$/.exec(name);
    if (!match) throw new Error(`unsupported migration file ${name}; expected NNN_description.sql`);
    const file = realpathSync(resolve(path, name));
    contained(root, file);
    if (!statSync(file).isFile()) throw new Error(`migration must be a file: ${name}`);
    const sql = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
    if (!sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()) throw new Error(`empty SQL migration ${name}`);
    if (/^\s*--\s*(?:migrate|\+goose)\s*:?\s*(?:up|down)\b/im.test(sql)) {
      throw new Error(`up/down sections are unsupported: ${name}; use forward-only SQL`);
    }
    return { version: Number(match[1]), name, sql };
  }).sort((a, b) => a.version - b.version);
  entries.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`migration versions must be consecutive from 001: ${migration.name}`);
  });
  return entries.map(({ name, sql }) => ({ name, sql }));
}
