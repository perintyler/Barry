import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { closeDb, setDb } from "./db.js";
import { claimLoginEvent, getState } from "./store.js";
it("preserves login claims across actual database reopening and isolates schedules/events", () => {
  const directory = mkdtempSync(join(tmpdir(), "barry-login-claims-"));
  const path = join(directory, "schedules.db");
  const now = new Date("2030-01-01T09:00:00Z");
  try {
    setDb(new Database(path));
    expect(claimLoginEvent("ops/task", null, now)).toBe(false);
    expect(claimLoginEvent("ops/task", "event-1", now)).toBe(true);
    expect(getState("ops/task")?.last_fired_at).toEqual(now);
    closeDb();
    setDb(new Database(path));
    expect(claimLoginEvent("ops/task", "event-1", now)).toBe(false);
    expect(claimLoginEvent("ops/other", "event-1", now)).toBe(true);
    expect(claimLoginEvent("ops/task", "event-2", now)).toBe(true);
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("lets only one independent process claim the same login event", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barry-login-race-"));
  const path = join(directory, "schedules.db");
  try {
    setDb(new Database(path));
    closeDb();
    const source = pathToFileURL(join(import.meta.dirname, "store.ts")).href;
    const code = `import { claimLoginEvent } from ${JSON.stringify(source)}; process.stdout.write(String(claimLoginEvent("ops/task", "same-login", new Date())));`;
    const run = () => new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        cwd: resolve(import.meta.dirname, "../../.."), env: { ...process.env, BARRY_HOME: directory, BARRY_SCHEDULES_DB: path },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let errors = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { errors += chunk; });
      child.on("error", reject);
      child.on("exit", status => status === 0 ? resolveOutput(output.trim()) : reject(new Error(errors)));
    });
    expect((await Promise.all([run(), run()])).sort()).toEqual(["false", "true"]);
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});
