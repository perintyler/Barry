import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
function absent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

/** A refused collision never grants cleanup ownership; partial setup does. */
export class SystemCleanupLease {
  readonly paths: readonly string[];
  #started = false;
  constructor(paths: readonly string[]) { this.paths = [...paths]; }
  get started(): boolean { return this.#started; }
  start(operation: () => void): void {
    assert.equal(this.#started, false, "system setup already started");
    assert.ok(this.paths.every(absent), "fixture system paths already exist");
    this.#started = true;
    operation();
  }
  cleanup(operation: () => void): void { if (this.#started) operation(); }
}
