/**
 * Register test bags in the synchronous registry snapshot using the CLI writer’s shape.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";

type Snapshot = { bags: Record<string, unknown> };

function snapshotPath(): string {
  const path = process.env.BARRY_BAGS_SNAPSHOT;
  if (!path) throw new Error("snapshot-fixture: set BARRY_BAGS_SNAPSHOT to a scratch path first");
  return path;
}

function read(): Snapshot {
  const path = snapshotPath();
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Snapshot) : { bags: {} };
}

export function addSnapshotBag(name: string, source: object): void {
  const snapshot = read();
  snapshot.bags[name] = source;
  writeFileSync(snapshotPath(), JSON.stringify({ generated: new Date().toISOString(), source: "test", ...snapshot }));
}

export function removeSnapshotBag(name: string): boolean {
  const snapshot = read();
  if (!(name in snapshot.bags)) return false;
  delete snapshot.bags[name];
  writeFileSync(snapshotPath(), JSON.stringify(snapshot));
  return true;
}
