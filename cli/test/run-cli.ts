import { owner } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore, identitiesSqlite } from "@barry-rocks/identities-bag/testing";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dirname, "../src/index.ts");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// tsx cold-starts crawl on macOS efficiency cores, so a full-suite parallel run
// can take well over 10s to boot the CLI. Keep this comfortably under the
// vitest testTimeout (60s) so a slow-but-valid start isn't SIGTERM'd into a
// bogus exit 143 that reads as a real assertion failure.
//
// Raised 20s -> 40s for the containerized lane, which runs every workspace's
// suite at once on capped CPUs: `barry mcp --help` took 22s there against ~2s
// in isolation. This raise was attempted once before and reverted, correctly —
// at the time the failing test was `db backup`, which turned out to HANG rather
// than start slowly (mkdirSync recursive under /proc never returns on Linux),
// and no budget can fix a hang. With that fixed, a real cold-start overrun is
// what is left, and it has a measured duration behind it rather than a guess.
const CLI_TIMEOUT_MS = 40_000;

/** Run the barry CLI with the given arguments and return stdout/stderr/exitCode. */
export function run(...args: string[]): CliResult {
  return runWithEnv({}, ...args);
}

/**
 * Like `run`, with extra environment variables layered on top of the usual
 * test env (NO_COLOR, plus whatever this process already has). Note it does NOT
 * create a separate store: the shared setup supplies a scratch installation,
 * and callers can override it for an isolated fixture. Extracted for tests that
 * need to pass a test-only flag into the spawned process — e.g. F18's
 * provider-load sentinel, which the CLI itself never sets.
 */
export function runIdentity(...args: string[]): CliResult {
  const home = process.env.BARRY_HOME!;
  // In Barry's own identities folder, where the generated CLI's binding finds
  // the directory carrying its id.
  const directory = join(home, "app-support", "identities", "fixture");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "identity.yaml"), "name: fixture\nid: 1234567890\n");
  const db = identitiesSqlite();
  const actor = { id: owner.installation().provision({ username: "CLI fixture owner" }).actorId };
  const existing = db.prepare("SELECT actor_id FROM identities WHERE id = 1234567890").get() as { actor_id: number } | undefined;
  if (existing && existing.actor_id !== actor.id) throw new Error("CLI fixture identity belongs to another actor");
  if (!existing) db.prepare("INSERT INTO identities (id, token, actor_id, name) VALUES (1234567890, 'cli-fixture-identity', ?, 'fixture')").run(actor.id);
  closeIdentitiesStore();
  return spawnCLI(resolve(import.meta.dirname, "../src/identity.ts"), [JSON.stringify({ home, directory, id: 1234567890 }), ...args], {});
}

export function runWithEnv(extraEnv: Record<string, string>, ...args: string[]): CliResult {
  // spawnSync, not execFileSync: the latter returns stdout ONLY, so stderr was
  // unavailable on success and this helper used to hardcode `stderr: ""` there.
  // That made any assertion about stderr on an exit-0 command silently vacuous
  // — it read that empty string and passed no matter what the CLI printed. A
  // command that warns and still exits 0 (`notify` falling back when no
  // identity resolves) is exactly the case worth asserting on.
  return spawnCLI(CLI_PATH, args, extraEnv);
}

function spawnCLI(entry: string, args: string[], extraEnv: Record<string, string>): CliResult {
  const result = spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    encoding: "utf-8",
    timeout: CLI_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // A timeout kill surfaces as killed/SIGTERM with a null status. Fail loudly
  // instead of returning exit 143 — otherwise the test reports a confusing
  // "expected 143 to be 0" that masks the real cause (the CLI never finished).
  if (result.error || result.signal === "SIGTERM") {
    throw new Error(
      `barry CLI timed out after ${CLI_TIMEOUT_MS}ms: \`barry ${args.join(" ")}\` ` +
        `(tsx cold-start likely exceeded the limit under load)`,
    );
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

/** Strip ANSI escape codes from a string. */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}
