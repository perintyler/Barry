import { existsSync, mkdtempSync, statSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;

vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => home,
}));

const { acceptFolderTrust } = await import("./trust.js");
const { planClaudeLaunch } = await import("./anthropic-compatible/launch.js");
const { default: adapter } = await import("./adapter.js");

describe("accepting a worktree's folder trust", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-trust-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function configPath(): string {
    return join(home, ".claude.json");
  }

  function readConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  }

  it("does not pre-accept an ordinary directory without a Barry creation attestation", () => {
    const ordinary = mkdtempSync(join(tmpdir(), "cc-unowned-work-"));
    acceptFolderTrust(ordinary);
    expect(existsSync(configPath())).toBe(false);
  });

  it("refuses an attestation for a different canonical directory", () => {
    const ordinary = mkdtempSync(join(tmpdir(), "cc-unowned-work-"));
    const created = mkdtempSync(join(tmpdir(), "cc-created-work-"));
    acceptFolderTrust(ordinary, created);
    expect(existsSync(configPath())).toBe(false);
  });

  it("the real launch pre-accepts only its matching explicit creation attestation", async () => {
    const cwd = mkdtempSync(join(home, "created-launch-"));
    const config = { sessionId: "created-launch", cwd, env: { ANTHROPIC_API_KEY: "synthetic-fixture-key" }, mcpServers: {} };
    const ordinary = await planClaudeLaunch(config, adapter.modes.guest!.guarantees);
    try { expect(existsSync(configPath())).toBe(false); }
    finally { for (const dir of ordinary.tmpDirs) rmSync(dir, { recursive: true, force: true }); }
    const created = await planClaudeLaunch({ ...config, options: { barryCreatedDirectory: cwd } }, adapter.modes.guest!.guarantees);
    try {
      expect(readConfig().projects).toMatchObject({ [realpathSync(cwd)]: { hasTrustDialogAccepted: true } });
    } finally { for (const dir of created.tmpDirs) rmSync(dir, { recursive: true, force: true }); }
  });

  it("creates ~/.claude.json when none exists, trusting the given directory", () => {
    const worktree = mkdtempSync(join(tmpdir(), "cc-trust-work-"));
    acceptFolderTrust(worktree, worktree);

    const config = readConfig();
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    const projects = config.projects as Record<string, { hasTrustDialogAccepted?: boolean }>;
    expect(projects[realpathSync(worktree)]?.hasTrustDialogAccepted).toBe(true);
  });

  it("preserves unrelated projects and fields already in the file", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        projects: { "/some/other/repo": { hasTrustDialogAccepted: true, lastCost: 12.5 } },
        userId: "kept-as-is",
      }),
    );
    const worktree = mkdtempSync(join(tmpdir(), "cc-trust-work-"));

    acceptFolderTrust(worktree, worktree);

    const config = readConfig();
    expect(config.userId).toBe("kept-as-is");
    const projects = config.projects as Record<string, { hasTrustDialogAccepted?: boolean; lastCost?: number }>;
    expect(projects["/some/other/repo"]).toEqual({ hasTrustDialogAccepted: true, lastCost: 12.5 });
    expect(projects[realpathSync(worktree)]?.hasTrustDialogAccepted).toBe(true);
  });

  it("does not touch the file again once a directory is already trusted", () => {
    const worktree = mkdtempSync(join(tmpdir(), "cc-trust-work-"));
    acceptFolderTrust(worktree, worktree);
    const firstWrite = readFileSync(configPath());

    // A second call must be a no-op: if it rewrote the file, mtime/content
    // would differ in a way this equality check would catch.
    acceptFolderTrust(worktree, worktree);
    expect(readFileSync(configPath())).toEqual(firstWrite);
  });

  it("does not throw when the config file is malformed", () => {
    writeFileSync(configPath(), "{ not json");
    const worktree = mkdtempSync(join(tmpdir(), "cc-trust-work-"));

    expect(() => acceptFolderTrust(worktree, worktree)).not.toThrow();
    // Left as-is: a courtesy write must not stomp a file it can't parse.
    expect(readFileSync(configPath(), "utf8")).toBe("{ not json");
  });

  it("does not throw when the target directory does not exist", () => {
    expect(() => acceptFolderTrust(join(home, "never-created"), join(home, "never-created"))).not.toThrow();
  });

  it("resolves symlinked directories to the real path claude itself looks up", () => {
    const real = mkdtempSync(join(tmpdir(), "cc-trust-real-"));
    const link = join(tmpdir(), `cc-trust-link-${process.pid}`);
    symlinkSync(real, link);

    try {
      acceptFolderTrust(link, real);
      const config = readConfig();
      const projects = config.projects as Record<string, { hasTrustDialogAccepted?: boolean }>;
      expect(projects[realpathSync(real)]?.hasTrustDialogAccepted).toBe(true);
      expect(projects[link]).toBeUndefined();
    } finally {
      rmSync(link, { force: true });
    }
  });
});
