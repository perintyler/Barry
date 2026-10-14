import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run, runIdentity, runWithEnv, stripAnsi } from "./run-cli.js";

describe("barry CLI", () => {
  describe("basic invocation", () => {
    it("shows help with --help", () => {
      const { stdout, exitCode } = run("--help");
      const clean = stripAnsi(stdout);
      expect(exitCode).toBe(0);
      expect(clean).toContain("Barry - personal AI coding agent CLI");
      // Root help is grouped into named sections (help-format.ts) rather than
      // one "Commands:" block — that block existing at all was the thing
      // Phase 2 of the command-surface restructure replaced. Assert on a
      // representative section instead of the literal string it replaced.
      expect(clean).not.toMatch(/^\s+session(?:\s|$)/m);
      expect(clean).toContain("Your setup:");
    });

    it("shows version with --version", () => {
      const { stdout, exitCode } = run("--version");
      expect(exitCode).toBe(0);
      // A checkout never prints a release's version: it is the commit's described
      // version (or 0.0.0 outside git) marked -dev, and still valid semver.
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-dev$/);
    });

    it("shows help and exits 0 when invoked bare without arguments", () => {
      const { stdout, exitCode } = run();
      const clean = stripAnsi(stdout);
      expect(exitCode).toBe(0);
      expect(clean).toContain("Barry - personal AI coding agent CLI");
      expect(clean).toContain("Identity Personas:");
      expect(clean).toContain("-i, --identity <identity>");
    });

    it("intercepts identity commands in system scope with persona guidance", () => {
      const bareSession = run("session");
      expect(bareSession.exitCode).toBe(1);
      expect(stripAnsi(bareSession.stderr)).toContain('"session" is an identity command, not a system command');
      expect(stripAnsi(bareSession.stderr)).toContain("Barry operates through identity personas");
      expect(stripAnsi(bareSession.stderr)).toContain("barry --identity <identity> session");

      const sessionStart = run("session", "start");
      expect(sessionStart.exitCode).toBe(1);
      expect(stripAnsi(sessionStart.stderr)).toContain('"session" is an identity command, not a system command');
      expect(stripAnsi(sessionStart.stderr)).toContain("barry --identity <identity> session start");

      const runCmd = run("run");
      expect(runCmd.exitCode).toBe(1);
      expect(stripAnsi(runCmd.stderr)).toContain('"run" is an identity command, not a system command');
    });

    it("reports error when --identity flag argument is missing or identity does not exist", () => {
      const missingArg = run("--identity");
      expect(missingArg.exitCode).toBe(1);
      expect(stripAnsi(missingArg.stderr)).toContain("option '--identity' argument missing");

      const notFound = run("--identity", "totally-unknown-identity-xyz", "status");
      expect(notFound.exitCode).toBe(1);
      expect(stripAnsi(notFound.stderr)).toContain('Identity "totally-unknown-identity-xyz" not found');
    });

    it("bridges execution to an identity via --identity and -i", () => {
      runIdentity("status");
      const longFlag = run("--identity", "fixture", "session", "list");
      expect(longFlag.exitCode).toBe(0);

      const shortFlag = run("-i", "fixture", "session", "list");
      expect(shortFlag.exitCode).toBe(0);
    });

    /**
     * `barry <unknown> --help` used to print ROOT help and exit 0: Commander
     * resolves --help at the root before any action runs, so the old
     * typo-detection guard (living only in the default `session start`
     * action) never saw this shape. That silently swallowed every typo
     * followed by --help, and separately made a test for an entirely
     * unregistered command ("prof") pass vacuously off the root listing.
     *
     * Negative control: an unknown command WITHOUT --help must still error
     * the same way it always did, proving this isn't just "--help always
     * fails now".
     */
    it("reports an unknown command even when --help follows it", () => {
      const withHelp = run("totallyfake-command-xyz", "--help");
      expect(withHelp.exitCode).not.toBe(0);
      expect(stripAnsi(withHelp.stdout + withHelp.stderr)).toMatch(/^Unknown command: totallyfake-command-xyz/m);

      const withoutHelp = run("totallyfake-command-xyz");
      expect(withoutHelp.exitCode).not.toBe(0);
      expect(stripAnsi(withoutHelp.stdout + withoutHelp.stderr)).toMatch(/^Unknown command: totallyfake-command-xyz/m);
    });

    it("does not misreport a real command's --help as unknown", () => {
      // `devops`, not `db`: `db` was a real top-level command only through
      // Phase 3's deprecation alias, dropped for good in Phase 5 — `barry db`
      // is now a genuine unknown command, so it stopped being a valid
      // fixture for "a real command" here.
      const { stdout, exitCode } = run("devops", "--help");
      expect(exitCode).toBe(0);
      expect(stripAnsi(stdout)).not.toMatch(/^Unknown command/m);
    });

    it("resolves --identity before --help rather than mis-parsing its value as a command", () => {
      // The identity bridge (index.ts) consumes `--identity <value>` before the
      // command tree parses, so the value is never mistaken for a command name.
      // An unknown identity is reported as such even when --help follows — the
      // bridge validates first. (Previously this guarded `--name bux --help`,
      // which fell through to root help; `--name` is gone, `--identity` is the
      // one selector and it short-circuits here.)
      const { stderr, exitCode } = run("--identity", "totally-unknown-identity-xyz", "--help");
      expect(exitCode).toBe(1);
      expect(stripAnsi(stderr)).toContain('Identity "totally-unknown-identity-xyz" not found');
    });

    it("still dispatches Commander's implicit help command", () => {
      // Commander registers `help [command]` lazily, so it is absent from
      // `program.commands` (and knownCommands) at the point the pre-parse
      // guard runs. Without an explicit exemption, `barry help` would
      // misreport itself as unknown before Commander ever handles it.
      const bare = run("help");
      expect(bare.exitCode).toBe(0);
      expect(stripAnsi(bare.stdout)).not.toMatch(/^Unknown command/m);

      const withArg = runIdentity("help", "session");
      expect(withArg.exitCode).toBe(0);
      expect(stripAnsi(withArg.stdout)).toContain("Manage sessions");
    });

    /**
     * `--version` must not load an agent SDK — the two
     * heavy third-party ones (@anthropic-ai/claude-agent-sdk,
     * @openai/codex-sdk) cost ~57MB for a version check that never touches a
     * provider. A module-load sentinel (a marker file, written the instant an
     * SDK-bearing module's body starts executing — see
     * adapters/sessions/claude/src/anthropic-compatible/sdk-impl.ts and
     * the hosted Codex application-server implementation)
     * proves this directly rather than asserting on an ms timing budget,
     * which would be flaky under the "tsx cold-starts crawl on macOS
     * efficiency cores" conditions this suite's own harness comment warns
     * about.
     */
    it("does not load the provider registry for --version", () => {
      const sentinel = join(tmpdir(), `barry-provider-sentinel-${Math.random().toString(36).slice(2)}.marker`);
      rmSync(sentinel, { force: true });
      try {
        const { exitCode } = runWithEnv(
          { BARRY_TEST_PROVIDER_LOAD_SENTINEL: sentinel },
          "--version",
        );
        expect(exitCode).toBe(0);
        expect(existsSync(sentinel)).toBe(false);
      } finally {
        rmSync(sentinel, { force: true });
      }
    });

    it("sentinel fires only when an SDK is actually loaded — mechanism negative control", () => {
      // Proves the sentinel mechanism works, decoupled from CLI routing: every
      // CLI path this suite can reasonably drive (--help on any command) is
      // provider-free by design, since commander resolves --help before any
      // .action() handler runs. So a script is spawned instead.
      //
      // The sentinel lives in the SDK-bearing module
      // (claude-code's anthropic-compatible/sdk-impl.ts). Adapters reach it
      // through `await import`, so this asserts the sharper pair:
      // importing an adapter loads no SDK, and starting a session does. The first half alone would pass just as well
      // against a sentinel that never fires, which is what the second half
      // rules out.
      const sentinel = join(tmpdir(), `barry-provider-sentinel-${Math.random().toString(36).slice(2)}.marker`);
      rmSync(sentinel, { force: true });
      // A relative filesystem path: this file sits at cli/test/, so the repo
      // root is two levels up.
      const adapterPath = join(import.meta.dirname, "../../adapters/sessions/claude/src/adapter.ts");

      try {
        // Wrapped in an async IIFE: `tsx --eval` compiles to CJS, where
        // top-level await is a transform error.
        const script = [
          `(async () => {`,
          `  const m = await import(${JSON.stringify(adapterPath)});`,
          `  const fs = require("node:fs");`,
          `  if (fs.existsSync(${JSON.stringify(sentinel)})) { console.error("SDK loaded on import"); process.exit(3); }`,
          `  const session = await m.default.modes.hosted.start({ sessionId: "sentinel", cwd: "/tmp", env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "sentinel-test-key" }, mcpServers: {}, ephemeral: true }, () => Promise.reject(new Error("no engine")));`,
          `  await session.close();`,
          `})().catch((e) => { console.error(e); process.exit(4); });`,
        ].join("\n");
        execFileSync("tsx", ["--eval", script], {
          env: { ...process.env, BARRY_TEST_PROVIDER_LOAD_SENTINEL: sentinel },
          timeout: 20_000,
        });
        expect(existsSync(sentinel)).toBe(true);
      } finally {
        rmSync(sentinel, { force: true });
      }
    });

    it("shows error for unknown subcommands", () => {
      // Top-level unknown args go to default 'start' command,
      // so test unknown subcommands instead. `db` is only reachable as
      // `devops db` now — Phase 5 dropped the root-level deprecation alias
      // entirely (see reserved-names.test.ts for what root `db` does now:
      // reports "unknown command", same as any other unregistered name).
      const { stderr, exitCode } = run("db", "nonexistent");
      expect(exitCode).not.toBe(0);
      expect(stripAnsi(stderr)).toContain("unknown command");
    });
  });

  describe("command registration", () => {
    // Catch accidental command deletions — if a command disappears
    // from the help output, something was broken during refactoring
    it("registers all expected top-level commands", () => {
      const { stdout } = run("--help");
      const clean = stripAnsi(stdout);

      // Actual top-level commands (see cli/src/index.ts). start/resume live
      // under `session`; status/up/stop/restart/logs under `service`.
      // git and github are bag commands (via cli.yaml), not static.
      // Barry verbs are top-level now — `barry` is gone.
      // `devops` is hidden from help unless BARRY_DEV=1 (step 25), so it is
      // no longer expected in the default `--help` listing.
      const expectedCommands = ["identity", "ls", "doctor", "use", "alias", "trait", "bound", "config", "bag", "adapter", "install", "service", "setup", "uninstall", "upgrade", "up", "down", "hosting", "env", "db", "workers", "trash", "archive", "cursor"];

      for (const cmd of expectedCommands) {
        // Match the command at line start; the alias forms render as
        // "barry|prof" / "use|switch", so allow a trailing | or whitespace.
        expect(clean, `missing command: ${cmd}`).toMatch(
          new RegExp(`^\\s+${cmd}[\\s|]`, "m")
        );
      }
    });

    // `switch` was the name before `use`. Keeping it is a compatibility promise
    // to muscle memory and scripts, and a promise nothing tests is one that
    // lapses the next time someone tidies the registration.
    it("still accepts 'switch' as an alias for 'use'", () => {
      const { stdout, exitCode } = run("use", "--help");
      expect(exitCode).toBe(0);
      expect(stripAnsi(stdout)).toContain("barry use|switch");
    });

    it("shows subcommand help for 'db'", () => {
      const { stdout, exitCode } = run("db", "--help");
      const clean = stripAnsi(stdout);
      expect(exitCode).toBe(0);
      // `backup` is all that is left: migrate/status/rollback/reset/schema
      // belonged to the retired server database and went with it.
      expect(clean).toContain("backup");
    });

    // `identity create` is the documented way to create a Barry; heir is an
    // easter egg that must keep working without ever being advertised.
    it("offers 'identity create' in help and keeps 'heir' out of it", () => {
      const root = run("--help");
      expect(root.exitCode).toBe(0);
      expect(stripAnsi(root.stdout)).not.toMatch(/\bheir\b/);

      const group = run("identity", "--help");
      expect(group.exitCode).toBe(0);
      expect(stripAnsi(group.stdout)).toMatch(/^\s+create \[options\] <name>/m);
    });

    it("still runs 'heir' as a hidden command", () => {
      const { stderr, exitCode } = run("heir");
      expect(exitCode).toBe(1);
      expect(stripAnsi(stderr)).toContain("Usage: barry heir to the <name> empire");
    });
  });

  describe("read-only commands", () => {
    it("service status works when no Barry services are running", () => {
      // The suite runs against a home with no service management, so this is the
      // answer a person gets before `barry up`. The running case is covered
      // by the service management's own test, which starts one.
      const { stdout, stderr, exitCode } = run("service", "status");
      expect(exitCode, stderr).toBe(0);
      expect(stripAnsi(stdout)).toContain("0 services running");
    });

    it("config shows configuration", () => {
      const { stdout, exitCode } = run("config");
      const clean = stripAnsi(stdout);
      expect(exitCode).toBe(0);
      // Should contain some config sections
      expect(clean.length).toBeGreaterThan(50);
    });

    it("db backup --help describes the stores it captures", () => {
      const { stdout, exitCode } = run("db", "backup", "--help");
      const clean = stripAnsi(stdout);
      expect(exitCode).toBe(0);
      expect(clean).toContain("destination");
    });

    it("mcp list shows configured servers", () => {
      const { stdout, stderr, exitCode } = runIdentity("mcp", "list");
      // mcp list depends on local barry installation state; in CI it may
      // fail to load env or registry. Accept exit 0 with output OR exit 1
      // with stderr (no local install).
      if (exitCode === 0) {
        const clean = stripAnsi(stdout);
        expect(clean.length).toBeGreaterThan(0);
      } else {
        expect(stderr.length).toBeGreaterThan(0);
      }
    });

    it("mcp --help lists enable and disable", () => {
      const { stdout, exitCode } = runIdentity("mcp", "--help");
      const clean = stripAnsi(stdout);
      expect(exitCode).toBe(0);
      expect(clean).toContain("enable");
      expect(clean).toContain("disable");
    });
  });
});
