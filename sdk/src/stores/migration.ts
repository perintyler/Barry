import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cp } from "node:fs/promises";
import {
  prepareStoreGeneration,
  validatePreparedStoreGeneration,
} from "./generation-preparation.js";
import { SqliteDatabase as DatabaseSync } from "./sqlite-connection.js";
import { barryArchivesDir, barryStoresDir } from "../services/home.mjs";
import {
  activateStoreGeneration,
  bootstrapStoreGeneration,
  acquireStoreGenerationLock,
  requireStoreGenerationActive,
} from "./generation-activation.js";
export interface LegacyStore {
  bag: string;
  store: string;
  path: string;
  nodeStore?: string;
  /** Read-only catalog prerequisites required by a store-local foreign key. */
  replicateTables?: string[];
  /** Every ordinary table must be classified. Unknown tables are archived. */
  owner(table: string, row: Record<string, unknown>): string | undefined;
}
export interface MigrationReport {
  id: string;
  state: "staged" | "active";
  originals: {
    path: string;
    checksum: string;
    archive: string;
  }[];
  tables: {
    store: string;
    table: string;
    total: number;
    assigned: number;
    archived: number;
  }[];
  archived: {
    store: string;
    table: string;
    row: Record<string, unknown>;
    reason: string;
  }[];
}
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const segment = (value: string) => {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value) || value.includes(".."))
    throw new Error("unsafe migration identifier");
  return value;
};
/** Caller must stop services first; no source file is ever changed or removed. */
export async function migrateLegacyStores(
  sources: LegacyStore[],
  options: {
    servicesStopped: boolean;
    id?: string;
    archives?: string;
    root?: string;
  },
): Promise<MigrationReport & { reportPath: string }> {
  if (!options.servicesStopped) throw new Error("stop instance services before migrating stores");
  const root = options.root ?? barryStoresDir();
  requireStoreGenerationActive(root);
  const archives = options.archives ?? barryArchivesDir();
  const id = segment(options.id ?? randomUUID());
  const directory = join(archives, "store-migrations", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const unlock = acquireStoreGenerationLock(root);
  let locked = true;
  const release = () => {
    if (locked) {
      locked = false;
      unlock();
    }
  };
  const staging = join(root, `.migration-${id}`);
  const reportPath = join(directory, "report.json");
  const report: MigrationReport = { id, state: "staged", originals: [], tables: [], archived: [] };
  try {
    requireStoreGenerationActive(root);
    const receipt = join(root, "activations", `${id}.json`);
    if (existsSync(receipt) && JSON.parse(readFileSync(receipt, "utf8")).state === "active") {
      const previous = JSON.parse(readFileSync(reportPath, "utf8")) as MigrationReport;
      Object.assign(report, previous, { state: "active" });
      return { ...report, reportPath };
    }
    if (activeStoreRoot(root) === join(root, "generations", id))
      throw new Error("migration id names the active generation");
    // Rebuild failed preparations from immutable migration archives.
    rmSync(join(root, "generations", id), { recursive: true, force: true });
    // A supplied ID resumes from immutable archives, rebuilding partial outputs.
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const source of sources) {
      segment(source.bag);
      segment(source.store);
      if (source.bag === "vault") throw new Error("vaults require separate migration");
      const archive = join(directory, `${source.bag}-${source.store}.db`);
      const original = new DatabaseSync(source.path, { readOnly: true });
      try {
        if (!existsSync(archive)) original.prepare("VACUUM INTO ?").run(archive);
      } finally {
        original.close();
      }
      report.originals.push({
        path: source.path,
        archive,
        checksum: createHash("sha256").update(readFileSync(archive)).digest("hex"),
      });
      const snapshot = new DatabaseSync(archive, { readOnly: true });
      const outputs = new Map<string, DatabaseSync>();
      try {
        const tables = snapshot
          .prepare(
            "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as {
          name: string;
          sql: string;
        }[];
        const virtuals = tables.filter((table) => /CREATE VIRTUAL TABLE/i.test(table.sql));
        const ordinary = tables.filter(
          (table) =>
            !virtuals.some(
              (virtual) => table.name === virtual.name || table.name.startsWith(`${virtual.name}_`),
            ) && table.name !== "schema_migrations",
        );
        const records = ordinary.map((table) => ({
          ...table,
          rows: snapshot
            .prepare(`SELECT rowid AS __migration_rowid, * FROM ${identifier(table.name)}`)
            .all(),
        }));
        const owners = new Set<string>();
        const assignments = new Map<string, (string | undefined)[]>();
        for (const table of records) {
          const assigned = table.rows.map((row) => {
            const clean = { ...row };
            delete clean.__migration_rowid;
            const owner = source.owner(table.name, clean);
            if (owner) owners.add(segment(owner));
            else
              report.archived.push({
                store: `${source.bag}/${source.store}`,
                table: table.name,
                row: clean,
                reason: "identity ownership could not be established",
              });
            return owner;
          });
          assignments.set(table.name, assigned);
          report.tables.push({
            store: `${source.bag}/${source.store}`,
            table: table.name,
            total: table.rows.length,
            assigned: assigned.filter(Boolean).length,
            archived: assigned.filter((owner) => !owner).length,
          });
        }
        for (const owner of owners) {
          const path = join(
            staging,
            owner === "node" ? "node" : "identities",
            ...(owner === "node" ? [] : [owner]),
            source.bag,
            `${owner === "node" ? (source.nodeStore ?? source.store) : source.store}.db`,
          );
          mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
          if (existsSync(path))
            throw new Error(`staging store already exists: ${path}; inspect interrupted migration`);
          snapshot.prepare("VACUUM INTO ?").run(path);
          const output = new DatabaseSync(path);
          outputs.set(owner, output);
          output.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
          for (const table of records) {
            const assigned = assignments.get(table.name)!;
            const remove = output.prepare(`DELETE FROM ${identifier(table.name)} WHERE rowid=?`);
            table.rows.forEach((row, index) => {
              if (assigned[index] !== owner && !source.replicateTables?.includes(table.name))
                remove.run(Number(row.__migration_rowid));
            });
          }
          // Rebuild external-content FTS from the retained rows. Standalone memory
          // FTS uses the memory rowid and must be copied from those same rows.
          for (const virtual of virtuals) {
            if (/content\s*=/.test(virtual.sql))
              output.exec(
                `INSERT INTO ${identifier(virtual.name)}(${identifier(virtual.name)}) VALUES('rebuild')`,
              );
            else if (virtual.name === "memories_fts") {
              output.exec(
                "DELETE FROM memories_fts; INSERT INTO memories_fts(rowid,title,body,tags) SELECT m.rowid,m.title,m.body,COALESCE((SELECT group_concat(tag, ' ') FROM memory_tags WHERE memory_id=m.id), '') FROM memories m;",
              );
            } else throw new Error(`no index rebuild adapter for ${virtual.name}`);
          }
          output.exec("COMMIT;");
          if (String(output.prepare("PRAGMA integrity_check").get()?.integrity_check) !== "ok")
            throw new Error(`migration integrity failure: ${path}`);
          const violations = output.prepare("PRAGMA foreign_key_check").all();
          if (violations.length) throw new Error(`migration relationship failure: ${path}`);
        }
      } finally {
        for (const output of outputs.values()) output.close();
        snapshot.close();
      }
    }
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    release();
    // Only now: a selector on a legacy home hides its stores, so a failed
    // migration must leave none behind.
    const previousId = bootstrapStoreGeneration(root);
    await prepareStoreGeneration({
      root,
      id,
      previousId,
      servicesStopped: true,
      build: async (candidate) => {
        await cp(staging, candidate, { recursive: true });
      },
    });
    await activateStoreGeneration({
      root,
      id,
      previousId,
      servicesStopped: true,
      validate: async () => {
        await validatePreparedStoreGeneration(root, id);
      },
      sealPrevious: async () => {},
    });
    rmSync(staging, { recursive: true, force: true });
    report.state = "active";
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    return { ...report, reportPath };
  } finally {
    try {
      writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    } finally {
      release();
    }
  }
}
export function activeStoreRoot(root = barryStoresDir()): string {
  requireStoreGenerationActive(root);
  const marker = join(root, "active.json");
  if (!existsSync(marker)) return root;
  const { id } = JSON.parse(readFileSync(marker, "utf8")) as {
    id: string;
  };
  return join(root, "generations", segment(id));
}
