import { symlinkSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cliShimDir,
  describeConflict,
  ensureShims,
  findConflict,
  findInstalledBarry,
  getShimDir,
  installShim,
  isOurShim,
  isCurrentShim,
  isHomebrewBarry,
  legacyCliShimDirs,
  onPath,
  pathHint,
  removeShim,
  renderShim,
  shimNamesFor,
} from "./identity-shims.js";

const REAL_PATH = process.env.PATH ?? "";

/** System dirs stay so the PATH walk and any shebang still resolve; user bins do not. */
const SYSTEM_PATH = "/bin:/usr/bin:/usr/sbin:/sbin";

function binDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "barry-shims-"));
  madeDirs.push(dir);
  // A temp bin dir is only "free" with the real PATH out of the way. `bux` and
  // `bgoode` are legitimate commands on any machine that has installed them —
  // which is what this feature does — so a test calling those names free was
  // measuring the developer's PATH, not the code, and went red the day the
  // feature worked.
  process.env.PATH = `${dir}:${SYSTEM_PATH}`;
  return dir;
}

/** Fixture directories made by a test, removed after it. */
const madeDirs: string[] = [];

afterEach(() => {
  process.env.PATH = REAL_PATH;
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BARRY = "/opt/homebrew/bin/barry";

describe("findConflict", () => {
  it("allows a free name", () => {
    expect(findConflict("bgoode", binDir())).toBeNull();
  });

  // The motivating case. `bg` is job control; a shim by that name would appear
  // to install, never win in an interactive shell, and break scripts that
  // resolve through PATH.
  it("refuses shell builtins", () => {
    expect(findConflict("bg", binDir())).toEqual({ kind: "builtin" });
  });

  it.each(["cd", "kill", "test", "export", "["])("refuses the builtin %j", (name) => {
    expect(findConflict(name, binDir())?.kind).toBe("builtin");
  });

  // Anything already on PATH — shadowing someone's binary is never ours to do.
  it("refuses a name that already resolves on PATH", () => {
    const dir = binDir();
    // Deliberately consults the real PATH: this asserts the check sees a
    // genuine foreign binary, and an isolated PATH has none to see.
    process.env.PATH = REAL_PATH;
    const conflict = findConflict("ls", dir);
    expect(conflict?.kind).toBe("occupied");
  });

  it("refuses a foreign file already in the bin dir", () => {
    const dir = binDir();
    writeFileSync(join(dir, "taken"), "#!/bin/sh\necho not ours\n");
    chmodSync(join(dir, "taken"), 0o755);

    const conflict = findConflict("taken", dir);
    expect(conflict).toEqual({ kind: "occupied", path: join(dir, "taken") });
  });

  // Re-running `barry heir` or `barry alias` must be able to refresh its own
  // shim, or every reinstall would report a spurious conflict.
  it("allows overwriting a shim we wrote", () => {
    const dir = binDir();
    installShim("bgoode", "bgoode", { binDir: dir, barryPath: BARRY });
    expect(findConflict("bgoode", dir)).toBeNull();
  });

  it.each(["9lives", "has space", "has/slash", "", "-lead"])(
    "refuses the unusable name %j",
    (name) => {
      expect(findConflict(name, binDir())?.kind).toBe("invalid");
    },
  );
});

describe("describeConflict", () => {
  it("names why an identity's file cannot be read", () => {
    expect(describeConflict("stale", { kind: "unreadable", reason: "Identity env is retired" })).toBe("`stale`'s identity.yaml cannot be read: Identity env is retired");
  });

  it("names the builtin problem", () => {
    expect(describeConflict("bg", { kind: "builtin" })).toContain("shell builtin");
  });

  it("names the occupying file", () => {
    const msg = describeConflict("ls", { kind: "occupied", path: "/bin/ls" });
    expect(msg).toContain("/bin/ls");
  });
});

describe("renderShim", () => {
  // Not `--name`: it is declared per-command, so it would break subcommands
  // that never declared the flag.
  it("exports BARRY_IDENTITY rather than passing --name", () => {
    const shim = renderShim("bux", BARRY);
    expect(shim).toContain('export BARRY_IDENTITY="bux"');
    expect(shim).not.toContain("--name");
  });

  it("forwards arguments to the bound identity entry point", () => {
    const shim = renderShim("bux", BARRY);
    expect(shim).toContain('"$@"');
    expect(shim).toContain("bin/barry.js --identity-binding");
    expect(shim).toContain('"id":');
  });
});

describe("installShim", () => {
  it("writes an executable, self-identifying shim", () => {
    const dir = binDir();
    expect(installShim("bux", "bux", { binDir: dir, barryPath: BARRY }).status).toBe("installed");

    const target = join(dir, "bux");
    expect(existsSync(target)).toBe(true);
    expect(isOurShim(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain('BARRY_IDENTITY="bux"');
  });

  it("installs an alias pointing at the identity's real name", () => {
    const dir = binDir();
    installShim("bgo", "bgoode", { binDir: dir, barryPath: BARRY });
    expect(readFileSync(join(dir, "bgo"), "utf8")).toContain('BARRY_IDENTITY="bgoode"');
  });

  // A refusal must be reported, never thrown: `barry heir` still created the
  // identity, and losing it over an alias would be the wrong trade.
  it("reports a conflict instead of throwing", () => {
    const outcome = installShim("bg", "bgoode", { binDir: binDir(), barryPath: BARRY });
    expect(outcome.status).toBe("conflict");
    expect(outcome.conflict?.kind).toBe("builtin");
  });

  it("does not write a file it refused", () => {
    const dir = binDir();
    installShim("bg", "bgoode", { binDir: dir, barryPath: BARRY });
    expect(existsSync(join(dir, "bg"))).toBe(false);
  });

  it("never pins the shipped identity's file to this machine", () => {
    const shipped = mkdtempSync(join(tmpdir(), "barry-shipped-identity-"));
    madeDirs.push(shipped);
    writeFileSync(join(shipped, "identity.yaml"), "name: barry\ntraits: []\n");
    const previous = process.env.BARRY_BUILTIN_DIR;
    // The shipped identity is the checkout root; its bags sit beside it.
    process.env.BARRY_BUILTIN_DIR = join(shipped, "bags");
    try {
      const outcome = installShim("barry", "barry", { binDir: binDir(), barryPath: BARRY, binding: { id: 23, home: null, directory: shipped } });
      expect(outcome.status).toBe("installed");
      expect(readFileSync(join(shipped, "identity.yaml"), "utf8")).toBe("name: barry\ntraits: []\n");
    } finally {
      if (previous === undefined) delete process.env.BARRY_BUILTIN_DIR; else process.env.BARRY_BUILTIN_DIR = previous;
    }
  });

  it("refuses an identity whose identity.yaml cannot be read, saying why", () => {
    const dir = binDir();
    const outcome = installShim("stale", "stale", { binDir: dir, barryPath: BARRY, binding: { id: 7, home: null, directory: unreadableIdentity() } });

    expect(outcome).toMatchObject({ status: "conflict", conflict: { kind: "unreadable", reason: expect.stringContaining("Failed to parse") } });
    expect(existsSync(join(dir, "stale"))).toBe(false);
  });
});

/** An identity directory whose identity.yaml is not YAML, so its id cannot be pinned in it. */
function unreadableIdentity(): string {
  const directory = mkdtempSync(join(tmpdir(), "barry-unreadable-identity-"));
  madeDirs.push(directory);
  writeFileSync(join(directory, "identity.yaml"), "name: stale\nbags: [unclosed\n");
  return directory;
}

describe("ensureShims", () => {
  // `barry doctor --fix` installs every identity's command before it repairs
  // anything else, so one identity in an old format stopped all of it.
  // A shim from before a layout move names an identity.ts that no longer
  // exists; it must be rewritten, not reported current.
  it("rewrites a shim whose entry point has moved", () => {
    const dir = binDir();
    installShim("bonanza", "bonanza", { binDir: dir, barryPath: BARRY, binding: { id: 17, home: null } });
    const path = join(dir, "bonanza");
    writeFileSync(path, readFileSync(path, "utf8").replace(/\/bin\/barry\.js/, "/sdk/src/cli/identity.ts"));

    const result = ensureShims([{ command: "bonanza", identity: "bonanza", binding: { id: 17, home: null } }], { binDir: dir, barryPath: BARRY });

    expect(result.installed).toEqual(["bonanza"]);
    expect(readFileSync(path, "utf8")).not.toContain("/sdk/src/cli/identity.ts");
  });

  it("installs the other identities' commands when one identity cannot be read", () => {
    const dir = binDir();
    const result = ensureShims(
      [
        { command: "stale", identity: "stale", binding: { id: 7, home: null, directory: unreadableIdentity() } },
        { command: "bux", identity: "bux" },
      ],
      { binDir: dir, barryPath: BARRY },
    );

    expect(result.installed).toEqual(["bux"]);
    expect(result.refused).toEqual([{ command: "stale", conflict: expect.objectContaining({ kind: "unreadable" }) }]);
  });
});

describe("removeShim", () => {
  it("removes a shim we wrote", () => {
    const dir = binDir();
    installShim("bux", "bux", { binDir: dir, barryPath: BARRY });
    expect(removeShim("bux", dir)).toBe(true);
    expect(existsSync(join(dir, "bux"))).toBe(false);
  });

  // Deleting an identity must never delete somebody else's binary that happens
  // to share its name.
  it("leaves a foreign file alone", () => {
    const dir = binDir();
    const target = join(dir, "precious");
    writeFileSync(target, "#!/bin/sh\necho important\n");

    expect(removeShim("precious", dir)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it("reports absence rather than succeeding", () => {
    expect(removeShim("never-existed", binDir())).toBe(false);
  });
});

describe("shimNamesFor", () => {
  it("includes the identity and its aliases", () => {
    expect(shimNamesFor("bgoode", ["bgo", "bg2"])).toEqual(["bgoode", "bgo", "bg2"]);
  });

  it("does not install the same name twice", () => {
    expect(shimNamesFor("bgoode", ["bgoode"])).toEqual(["bgoode"]);
  });
});

describe("an instance under BARRY_HOME keeps its commands in $BARRY_HOME/bin", () => {
  // A dev instance's setup wrote `barry` and its identity shims into the PATH
  // directory the installed instance uses, so `barry setup` from a worktree
  // repointed the real `barry` at that worktree.
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "barry-instance-bin-"));
    vi.stubEnv("BARRY_HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("writes the barry command there, not on the machine's PATH", () => {
    expect(cliShimDir()).toBe(join(home, "bin"));
  });

  it("does not find the machine's barry for this instance", () => {
    // /opt/homebrew/bin/barry may well exist; it is not this instance's.
    expect(findInstalledBarry()).toBeNull();
    expect(getShimDir()).toBeNull();
  });

  it("finds the instance's own barry, and puts identity shims beside it", () => {
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "barry"), "#!/bin/sh\n");
    expect(findInstalledBarry()).toBe(join(home, "bin", "barry"));
    expect(getShimDir()).toBe(join(home, "bin"));
  });
});

describe("installed identity commands", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "barry-current-shim-"));
    vi.stubEnv("BARRY_HOME", home);
    vi.stubEnv("BARRY_NODE", process.execPath);
    mkdirSync(join(home, "app-support"), { recursive: true });
    mkdirSync(join(home, "target"));
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  it("rewrites pre-current commands and exports the linked Node", () => {
    const target = join(home, "bux");
    writeFileSync(target, renderShim("bux", "unused"));
    expect(isCurrentShim("bux", "bux", home)).toBe(true);
    symlinkSync(join(home, "target"), join(home, "app-support/current"));
    expect(isCurrentShim("bux", "bux", home)).toBe(false);
    const text = renderShim("bux", "unused");
    expect(text).toContain("export BARRY_NODE=");
    expect(text).toContain(join(home, "app-support/current/bin/barry"));
    writeFileSync(target, text);
    expect(isCurrentShim("bux", "bux", home)).toBe(true);
    vi.stubEnv("BARRY_NODE", join(home, "different-node"));
    writeFileSync(join(home, "different-node"), "");
    expect(isCurrentShim("bux", "bux", home)).toBe(false);
  });
  it("runs a release's wrapper without a Node in the shim", () => {
    mkdirSync(join(home, "target/runtime/bin"), { recursive: true });
    symlinkSync(process.execPath, join(home, "target/runtime/bin/node"));
    symlinkSync(join(home, "target"), join(home, "app-support/current"));
    const text = renderShim("bux", "unused");
    expect(text).toContain(join(home, "app-support/current/bin/barry"));
    expect(text).not.toContain("export BARRY_NODE");
    expect(text).not.toContain(process.execPath);
  });
  it("recognizes only working Homebrew links", () => {
    const keg = join(home, "Cellar/barry/0.1.0/libexec/bin/barry");
    mkdirSync(join(keg, ".."), { recursive: true });
    writeFileSync(keg, "barry");
    const link = join(home, "barry");
    symlinkSync(keg, link);
    expect(isHomebrewBarry(link)).toBe(true);
    expect(isHomebrewBarry(keg)).toBe(false);
    rmSync(keg);
    expect(isHomebrewBarry(link)).toBe(false);
  });
});

describe("cliShimDir without an isolated instance", () => {
  // No BARRY_HOME: the shim defaults to ~/.local/bin, a directory Barry owns,
  // rather than the Homebrew prefix — unless Homebrew installed this checkout.
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "barry-shimdir-"));
    madeDirs.push(home);
    vi.stubEnv("HOME", home);
    delete process.env.BARRY_HOME;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to ~/.local/bin when Homebrew did not install barry", () => {
    // No barry on PATH: findInstalledBarry() is null, so not Homebrew.
    process.env.PATH = SYSTEM_PATH;
    expect(cliShimDir()).toBe(join(home, ".local", "bin"));
  });

  it("uses the Homebrew prefix only when the installed barry is a Homebrew link", () => {
    const prefix = mkdtempSync(join(tmpdir(), "barry-brew-prefix-"));
    madeDirs.push(prefix);
    const keg = join(home, "Cellar", "barry", "0.1.0", "libexec", "bin", "barry");
    mkdirSync(join(keg, ".."), { recursive: true });
    writeFileSync(keg, "barry");
    const link = join(prefix, "barry");
    symlinkSync(keg, link);
    chmodSync(keg, 0o755);
    process.env.PATH = `${prefix}:${SYSTEM_PATH}`;
    expect(findInstalledBarry()).toBe(link);
    expect(isHomebrewBarry(link)).toBe(true);
    expect(cliShimDir()).toBe(prefix);
  });

  it("does not use the prefix for a plain (non-Homebrew) barry on PATH", () => {
    const prefix = mkdtempSync(join(tmpdir(), "barry-plain-prefix-"));
    madeDirs.push(prefix);
    const barry = join(prefix, "barry");
    writeFileSync(barry, "#!/bin/sh\n");
    chmodSync(barry, 0o755);
    process.env.PATH = `${prefix}:${SYSTEM_PATH}`;
    expect(cliShimDir()).toBe(join(home, ".local", "bin"));
  });

  it("lists the old locations setup migrates off, minus the current one", () => {
    process.env.PATH = SYSTEM_PATH; // current dir is ~/.local/bin
    const legacy = legacyCliShimDirs();
    expect(legacy).toContain("/opt/homebrew/bin");
    expect(legacy).toContain("/usr/local/bin");
    expect(legacy).not.toContain(join(home, ".local", "bin"));
  });

  it("an isolated instance has no legacy locations", () => {
    const instanceHome = mkdtempSync(join(tmpdir(), "barry-instance-legacy-"));
    madeDirs.push(instanceHome);
    vi.stubEnv("BARRY_HOME", instanceHome);
    expect(legacyCliShimDirs()).toEqual([]);
  });
});

describe("PATH helpers", () => {
  afterEach(() => {
    process.env.PATH = REAL_PATH;
  });
  it("onPath is true only for a directory on PATH", () => {
    process.env.PATH = "/a:/b:/c";
    expect(onPath("/b")).toBe(true);
    expect(onPath("/d")).toBe(false);
  });
  it("pathHint names the directory and the export line", () => {
    expect(pathHint("/opt/x/bin")).toContain("/opt/x/bin is not in your PATH");
    expect(pathHint("/opt/x/bin")).toContain('export PATH="/opt/x/bin:$PATH"');
  });
});
