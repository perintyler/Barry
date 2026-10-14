import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { vi, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";
import type { IdentityRecord } from "./identities.js";

import {
  type IdentityYaml,
  IDENTITY_YAML,
  LEGACY_IDENTITY_YAML,
  SYNTHETIC_ID_OFFSET,
  createIdentityDirectory,
  findIdentityDirectoryById,
  findIdentityDirectoryByName,
  findIdentityYamlPath,
  isIdentityDirectory,
  listIdentityDirectories as realListIdentityDirectories,
  loadIdentityFromDirectory as realLoadIdentityFromDirectory,
  registerIdentityDirectory,
  syntheticIdFromName,
  findIdentityDrift,
  writeIdentityYaml,
  updateIdentity,
} from "./identity-files.js";

const diagnosticWarning = vi.hoisted(() => vi.fn());
vi.mock("@barry-rocks/sdk/logging", async original => {
  const logging = await original<typeof import("@barry-rocks/sdk/logging")>();
  return { ...logging, createLogger(...args: Parameters<typeof logging.createLogger>) {
    const logger = logging.createLogger(...args);
    if (args[0] !== "identities.files") return logger;
    return { ...logger, warn(...messages: Parameters<typeof logger.warn>) {
      diagnosticWarning(...messages);
      logger.warn(...messages);
    } };
  } };
});
beforeEach(() => diagnosticWarning.mockClear());

// POL-19 made actorId required on loadIdentityFromDirectory. These tests read
// metadata and do not care whose record it is, so a fixed test actor stands in.
const TEST_ACTOR = 1;
function loadIdentityFromDirectory(dir: string, options: { actorId: number } = { actorId: TEST_ACTOR }): IdentityRecord {
  return realLoadIdentityFromDirectory(dir, options);
}
function listIdentityDirectories(options: { actorId: number } = { actorId: TEST_ACTOR }): IdentityRecord[] {
  return realListIdentityDirectories(options);
}


function identityDir(yaml: string, dotenv?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "barry-identity-files-"));
  writeFileSync(join(dir, "identity.yaml"), yaml);
  if (dotenv) writeFileSync(join(dir, ".env"), dotenv);
  return dir;
}

/**
 * Point BARRY_HOME at a scratch dir so the directory-scanning helpers see
 * only what a test puts there, not the developer's real `~/.barry/identities`.
 */
function withBarryHome(): { home: string; identities: string } {
  const home = mkdtempSync(join(tmpdir(), "barry-home-"));
  const identities = join(home, "app-support", "identities");
  mkdirSync(identities, { recursive: true });
  process.env.BARRY_HOME = home;
  return { home, identities };
}

function seedIdentity(identities: string, name: string, yaml: string): string {
  const dir = join(identities, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.yaml"), yaml);
  return dir;
}

describe("isIdentityDirectory", () => {
  it("returns true when identity.yaml exists", () => {
    const dir = identityDir("name: test\n");
    expect(isIdentityDirectory(dir)).toBe(true);
  });

  it("returns false for a plain directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "barry-identity-files-"));
    expect(isIdentityDirectory(dir)).toBe(false);
  });
});

describe("syntheticIdFromName", () => {
  it("produces a stable ID for the same name", () => {
    const a = syntheticIdFromName("goode");
    const b = syntheticIdFromName("goode");
    expect(a).toBe(b);
  });

  it("produces different IDs for different names", () => {
    const a = syntheticIdFromName("goode");
    const b = syntheticIdFromName("default");
    expect(a).not.toBe(b);
  });

  it("IDs are above 1 billion to avoid DB serial collisions", () => {
    const id = syntheticIdFromName("test");
    expect(id).toBeGreaterThanOrEqual(1_000_000_000);
    expect(id).toBeLessThan(2_000_000_000);
  });
});

describe("loadIdentityFromDirectory", () => {
  it("binds declared file secrets without copying file values into their references", () => {
    const dir = identityDir("name: secret-owner\nsecrets:\n  API_KEY:\n    in: .env\n", "API_KEY=private-fixture\n");
    const record = loadIdentityFromDirectory(dir);
    expect(record.metadata.secrets).toEqual({ API_KEY: { reference: { in: ".env" }, directory: dir } });
    expect(JSON.stringify(record.metadata.secrets)).not.toContain("private-fixture");
  });
  it("reads a minimal identity.yaml", () => {
    const dir = identityDir("name: goode\n");
    const record = loadIdentityFromDirectory(dir);
    expect(record.name).toBe("goode");
    expect(record.id).toBe(syntheticIdFromName("goode"));
    expect(record.token).toMatch(/^prf_/);
    expect(record.actor_id).toBe(1);
  });

  // The yaml key has always been accepted; it just was not read, so a Barry
  // could carry a display name nothing could ever show.
  it("reads displayName into metadata", () => {
    const record = loadIdentityFromDirectory(identityDir("name: goode\ndisplayName: Barry B. Goode\n"));
    expect(record.metadata.display_name).toBe("Barry B. Goode");
    expect(record.name).toBe("goode");
  });

  it("leaves display_name unset when the yaml omits it", () => {
    const record = loadIdentityFromDirectory(identityDir("name: goode\n"));
    expect(record.metadata.display_name).toBeUndefined();
  });

  it("reads bags and traits", () => {
    const yaml = `
name: dev
bags:
  - git
  - bdiff
traits:
  - coding
`;
    const record = loadIdentityFromDirectory(identityDir(yaml));
    expect(record.metadata.bags).toEqual(["git", "bdiff"]);
    expect(record.metadata.traits).toEqual(["coding"]);
  });

  it("ignores retired settings and warns once per file", () => {
    const dir = identityDir("name: dev\ndefault_model: opus\ndefault_coding_agent: claude\nallow_native_tools: true\n");
    const warn = diagnosticWarning;
    for (let i = 0; i < 2; i++) expect(loadIdentityFromDirectory(dir).metadata).not.toHaveProperty("default_model");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("identities.file_warning");
    expect(warn.mock.calls[0][1].detail).toContain("barry doctor --fix");

  });

  it("reads models and modes from adapters", () => {
    const record = loadIdentityFromDirectory(identityDir("name: dev\nadapters: { claude-code: { model: ollama/qwen3:4b, mode: guest } }\n"));
    expect(record.metadata.adapters).toEqual({ "claude-code": { model: "ollama/qwen3:4b", mode: "guest" } });
  });

  it.each(["{ codex: { modle: gpt } }", "{ codex: { mode: attached } }", "{ codex: { default: true }, claude-code: { default: true } }"])("refuses invalid adapters %s", adapters => {
    expect(() => loadIdentityFromDirectory(identityDir(`name: dev\nadapters: ${adapters}\n`))).toThrow("Invalid adapters");
  });

  it("loads an ambiguous effective map for inspection", () => {
    expect(loadIdentityFromDirectory(identityDir("name: dev\nadapters: { claude-code: {}, codex: {} }\n")).metadata.adapters).toEqual({ "claude-code": {}, codex: {} });
  });

  it("rejects retired env maps without including their values in errors", () => {
    const yaml = `
name: dev
env:
  SOME_CONFIG: value
  OTHER: 42
`;
    expect(() => loadIdentityFromDirectory(identityDir(yaml))).toThrow("Identity env is retired");
  });

  it("does not infer declarations or cache credential values from .env", () => {
    const directory = identityDir("name: dev\nsecrets:\n  API_KEY:\n    in: .env\n", "API_KEY=private-fixture\nUNDECLARED=hidden\n");
    const record = loadIdentityFromDirectory(directory);
    expect(record.metadata.env).toBeUndefined();
    expect(record.metadata.env_file).toBeUndefined();
    expect(Object.keys(record.metadata.secrets ?? {})).toEqual(["API_KEY"]);
    expect(JSON.stringify(record.metadata)).not.toContain("private-fixture");
    expect(JSON.stringify(record.metadata)).not.toContain("hidden");
  });

  it("falls back to directory basename when name is missing", () => {
    const dir = identityDir("bags:\n  - git\n");
    const record = loadIdentityFromDirectory(dir);
    expect(record.name).toBe(basename(dir));
  });

  it("throws on a missing identity config", () => {
    const dir = mkdtempSync(join(tmpdir(), "barry-identity-files-"));
    expect(() => loadIdentityFromDirectory(dir)).toThrow("No identity.yaml");
  });

  it("throws on invalid YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "barry-identity-files-"));
    writeFileSync(join(dir, "identity.yaml"), ":\n  :\n  [invalid");
    expect(() => loadIdentityFromDirectory(dir)).toThrow("Failed to parse");
  });

  it("accepts a custom actorId", () => {
    const dir = identityDir("name: test\n");
    const record = loadIdentityFromDirectory(dir, { actorId: 42 });
    expect(record.actor_id).toBe(42);
  });

  it("requires an explicit actorId and never silently attributes to actor 1 (POL-19)", () => {
    const dir = identityDir("name: owned\n");
    // The record carries exactly the actor the caller named — a caller that
    // omits one is typed out, so no record is ever silently attributed to the
    // development actor 1 (migration 001's agent row) as readFileIdentity
    // previously did with `options.actorId ?? 1`.
    // @ts-expect-error actorId is required: a caller that returns an IdentityRecord must name the actor.
    void (() => realLoadIdentityFromDirectory(dir));
    expect(realLoadIdentityFromDirectory(dir, { actorId: 7 }).actor_id).toBe(7);
    expect(realLoadIdentityFromDirectory(dir, { actorId: 99 }).actor_id).toBe(99);
    expect(realLoadIdentityFromDirectory(dir, { actorId: 7 }).actor_id).not.toBe(1);
  });

  it("reads status_notify", () => {
    const yaml = `
name: dev
status_notify:
  tool: slack_post_message
  target: "#general"
`;
    const record = loadIdentityFromDirectory(identityDir(yaml));
    expect(record.metadata.status_notify).toEqual({
      tool: "slack_post_message",
      target: "#general",
    });
  });



  // Identities no longer inherit. A `parent:` left over in an existing identity.yaml
  // is inert rather than an error, so upgrading can't brick a Barry on disk.
  it("ignores a leftover parent key", () => {
    const record = loadIdentityFromDirectory(identityDir("name: child\nparent: base\n"));
    expect(record.name).toBe("child");
    expect("parent_name" in record.metadata).toBe(false);
  });

  it("reads an inline bound", () => {
    const yaml = `
name: locked
bound:
  deniedTools:
    - Bash
  files:
    deny:
      - "*.env"
`;
    const record = loadIdentityFromDirectory(identityDir(yaml));
    expect(record.metadata.bound).toEqual({
      deniedTools: ["Bash"],
      files: { deny: ["*.env"] },
    });
  });

  // identity.yaml lives in the user's own directory, outside this repo and
  // outside the database, so nothing converts it from the pre-rename spelling.
  // Reading only `bound:` would drop the deny rules of every unconverted
  // identity in silence — fail-open, which is the direction that matters.
  it("still reads a pre-rename inline `scope:` block", () => {
    const yaml = `
name: locked
scope:
  deniedTools:
    - Bash
  files:
    deny:
      - "*.env"
`;
    const record = loadIdentityFromDirectory(identityDir(yaml));
    expect(record.metadata.bound).toEqual({
      deniedTools: ["Bash"],
      files: { deny: ["*.env"] },
    });
  });

  it("omits an empty bound block rather than storing a no-op", () => {
    const record = loadIdentityFromDirectory(identityDir("name: open\nbound: {}\n"));
    expect(record.metadata.bound).toBeUndefined();
  });

  it("reads tool_discovery", () => {
    const yaml = `
name: dev
tool_discovery: barry
`;
    const record = loadIdentityFromDirectory(identityDir(yaml));
    expect(record.metadata.tool_discovery).toBe("barry");
  });
});

describe("directory-scanning helpers", () => {
  const originalHome = process.env.BARRY_HOME;
  const originalBuiltin = process.env.BARRY_BUILTIN_DIR;
  let identities: string;
  let emptyBuiltin: string;

  beforeEach(() => {
    identities = withBarryHome().identities;
    emptyBuiltin = mkdtempSync(join(tmpdir(), "empty-builtin-"));
    process.env.BARRY_BUILTIN_DIR = emptyBuiltin;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.BARRY_HOME;
    else process.env.BARRY_HOME = originalHome;
    if (originalBuiltin === undefined) delete process.env.BARRY_BUILTIN_DIR;
    else process.env.BARRY_BUILTIN_DIR = originalBuiltin;
    rmSync(emptyBuiltin, { recursive: true, force: true });
  });

  describe("listIdentityDirectories", () => {
    it("returns every barry directory", () => {
      seedIdentity(identities, "goode", "name: goode\n");
      seedIdentity(identities, "bucks", "name: bucks\n");

      const names = listIdentityDirectories().map((r) => r.name).sort();
      expect(names).toEqual(["bucks", "goode"]);
    });

    it("skips directories without an identity config", () => {
      seedIdentity(identities, "goode", "name: goode\n");
      mkdirSync(join(identities, "not-a-barry"), { recursive: true });

      expect(listIdentityDirectories().map((r) => r.name)).toEqual(["goode"]);
    });

    it("skips an unparseable identity config rather than failing the whole list", () => {
      seedIdentity(identities, "goode", "name: goode\n");
      seedIdentity(identities, "broken", ":\n  :\n  [invalid");

      expect(listIdentityDirectories().map((r) => r.name)).toEqual(["goode"]);
    });

    it("returns empty when the identities dir does not exist", () => {
      process.env.BARRY_HOME = mkdtempSync(join(tmpdir(), "barry-empty-"));
      expect(listIdentityDirectories()).toEqual([]);
    });

    it("passes actorId through to the loaded records", () => {
      seedIdentity(identities, "goode", "name: goode\n");
      expect(listIdentityDirectories({ actorId: 7 })[0].actor_id).toBe(7);
    });
  });

  describe("findIdentityDirectoryById", () => {
    it("finds a barry by its synthetic id", () => {
      const dir = seedIdentity(identities, "goode", "name: goode\n");
      expect(findIdentityDirectoryById(syntheticIdFromName("goode"))).toBe(dir);
    });

    it("matches the yaml name, not the directory name", () => {
      // loadIdentityFromDirectory hashes the yaml `name`, so the lookup must too
      const dir = seedIdentity(identities, "some-dir", "name: realname\n");
      expect(findIdentityDirectoryById(syntheticIdFromName("realname"))).toBe(dir);
      expect(findIdentityDirectoryById(syntheticIdFromName("some-dir"))).toBeNull();
    });

    it("returns null when nothing matches", () => {
      seedIdentity(identities, "goode", "name: goode\n");
      expect(findIdentityDirectoryById(syntheticIdFromName("absent"))).toBeNull();
    });
  });

  describe("findIdentityDirectoryByName", () => {
    it("finds a barry by its yaml name", () => {
      const dir = seedIdentity(identities, "goode", "name: goode\n");
      expect(findIdentityDirectoryByName("goode")).toBe(dir);
    });

    it("matches the yaml name, not the directory name", () => {
      const dir = seedIdentity(identities, "some-dir", "name: realname\n");
      expect(findIdentityDirectoryByName("realname")).toBe(dir);
      expect(findIdentityDirectoryByName("some-dir")).toBeNull();
    });

    it("returns null when nothing matches", () => {
      seedIdentity(identities, "goode", "name: goode\n");
      expect(findIdentityDirectoryByName("absent")).toBeNull();
    });
  });

  describe("createIdentityDirectory", () => {
    it("scaffolds identity.yaml, .env, .gitignore, and bags/", () => {
      const dir = createIdentityDirectory("goode");

      expect(existsSync(join(dir, "identity.yaml"))).toBe(true);
      expect(existsSync(join(dir, ".env"))).toBe(true);
      expect(existsSync(join(dir, ".gitignore"))).toBe(true);
      expect(existsSync(join(dir, "bags"))).toBe(true);
    });

    it("writes the supplied config", () => {
      const dir = createIdentityDirectory("dev", {
        traits: ["coding"],
        adapters: { "claude-code": { model: "claude-sonnet-4-20250514" } },
      });

      const yaml = yamlParse(readFileSync(join(dir, "identity.yaml"), "utf-8")) as IdentityYaml;
      expect(yaml.name).toBe("dev");
      expect(yaml.traits).toEqual(["coding"]);
      expect(yaml.adapters?.["claude-code"].model).toBe("claude-sonnet-4-20250514");
      expect(yaml.inherits).toBe("base");
    });

    it("throws when the barry already exists", () => {
      createIdentityDirectory("goode");
      expect(() => createIdentityDirectory("goode")).toThrow("already exists");
    });
  });

  describe("writeIdentityYaml", () => {
    it("rejects inline vault connections on read and write without exposing credentials", () => {
      const legacy = identityDir("name: legacy\nvault:\n  email: private-account\n  serverUrl: private-endpoint\n  credentials:\n    value: private-credential\n");
      expect(() => loadIdentityFromDirectory(legacy)).toThrow("inline vault connections are retired");
      const current = identityDir("name: current\n");
      expect(() => writeIdentityYaml(current, { vault: { credentials: "private-credential" } } as never)).toThrow("inline vault connections are retired");
      expect(readFileSync(join(current, "identity.yaml"), "utf-8")).toBe("name: current\n");
    });

    it("rejects legacy maps before resolving or mutating a backing store", async () => {
      await expect(updateIdentity({ id: 42, name: "unknown-identity", actor_id: 1 }, { env: { API_KEY: "inline" } })).rejects.toThrow("declare credential references under secrets");
    });

    it("rejects legacy credential maps without changing the identity file", () => {
      const original = "name: safe\n";
      const dir = identityDir(original, "API_KEY=local-only\n");
      expect(() => writeIdentityYaml(dir, { env: { API_KEY: "inline-credential" } })).toThrow("declare credential references under secrets");
      expect(readFileSync(join(dir, "identity.yaml"), "utf-8")).toBe(original);
      expect(existsSync(join(dir, ".identity.yaml.tmp"))).toBe(false);
    });

    it("allows removal of a retired env map", () => {
      const dir = identityDir("name: safe\nenv:\n  API_KEY: legacy\n");
      writeIdentityYaml(dir, { env: undefined });
      expect(yamlParse(readFileSync(join(dir, "identity.yaml"), "utf-8"))).toEqual({ name: "safe" });
    });

    it("merges updates into the existing config", () => {
      const dir = seedIdentity(identities, "dev", "name: dev\ntraits:\n  - coding\n");
      writeIdentityYaml(dir, { adapters: { "claude-code": { model: "claude-sonnet-4-20250514" } } });

      const record = loadIdentityFromDirectory(dir);
      expect(record.metadata.traits).toEqual(["coding"]);
      expect(record.metadata.adapters?.["claude-code"].model).toBe("claude-sonnet-4-20250514");
    });

    it("preserves keys it does not know about", () => {
      const dir = seedIdentity(identities, "dev", "name: dev\ncustom_key: keep-me\n");
      writeIdentityYaml(dir, { traits: ["coding"] });

      const raw = yamlParse(readFileSync(join(dir, "identity.yaml"), "utf-8"));
      expect(raw.custom_key).toBe("keep-me");
      expect(raw.traits).toEqual(["coding"]);
    });

    it("deletes a key when the update sets it to undefined", () => {
      const dir = seedIdentity(identities, "dev", "name: dev\ndefault_model: old\n");
      writeIdentityYaml(dir, { default_model: undefined });

      const raw = yamlParse(readFileSync(join(dir, "identity.yaml"), "utf-8"));
      expect(raw).not.toHaveProperty("default_model");
      expect(raw.name).toBe("dev");
    });

    it("leaves no temp file behind", () => {
      const dir = seedIdentity(identities, "dev", "name: dev\n");
      writeIdentityYaml(dir, { traits: ["coding"] });
      expect(existsSync(join(dir, ".identity.yaml.tmp"))).toBe(false);
    });

    it("throws when there is no identity config to merge into", () => {
      const dir = mkdtempSync(join(tmpdir(), "barry-nofile-"));
      expect(() => writeIdentityYaml(dir, { traits: [] })).toThrow("No identity.yaml");
    });
  });
});

describe("SYNTHETIC_ID_OFFSET", () => {
  // sessions.identity_id has a foreign key onto identities(id). A synthetic id
  // satisfies no row, so anything persisting one has to map it back to the
  // cache row's serial first — see resolveForeignKeyId.
  it("separates synthetic ids from DB serials", () => {
    expect(syntheticIdFromName("anything")).toBeGreaterThanOrEqual(SYNTHETIC_ID_OFFSET);
    expect(SYNTHETIC_ID_OFFSET).toBe(1_000_000_000);
  });
});

/**
 * Drift is what made a stale row invisible: the directory wins on read, so a
 * row that disagrees only shows up as a session behaving unlike its yaml.
 */
// The rename shipped with no back-compat, so this key is not read at all.
// Reading it as "no bags" is indistinguishable from an identity that grants
// none, so the loader must say something.
describe("pre-rename blocks: key", () => {
  it("warns rather than silently granting nothing", () => {
    const dir = identityDir("name: legacy\nblocks:\n  - slack\n  - linear\n");
    const record = loadIdentityFromDirectory(dir);
    expect(record.metadata.bags).toBeUndefined();
    const warnings = diagnosticWarning.mock.calls.map(([, context]) => String(context.detail));
    expect(warnings.some(w => w.includes("blocks:") && w.includes("bags:"))).toBe(true);
  });

  it("stays quiet for a file already using bags:", () => {
    const dir = identityDir("name: modern\nbags:\n  - slack\n");
    const record = loadIdentityFromDirectory(dir);
    expect(record.metadata.bags).toEqual(["slack"]);
    expect(diagnosticWarning).not.toHaveBeenCalled();
  });
});

describe("findIdentityDrift", () => {
  const originalHome = process.env.BARRY_HOME;
  let identities: string;

  beforeEach(() => {
    identities = withBarryHome().identities;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.BARRY_HOME;
    else process.env.BARRY_HOME = originalHome;
  });

  function row(name: string, metadata: Record<string, unknown>): IdentityRecord {
    return {
      id: 1,
      token: "tok",
      actor_id: 1,
      name,
      metadata,
      created_at: "2026-01-01T00:00:00Z",
      last_used_at: null,
    };
  }

  it("reports nothing when the row matches the yaml", () => {
    seedIdentity(identities, "goode", "name: goode\nadapters: { claude-code: { model: claude-opus-4-6 } }\n");
    expect(findIdentityDrift(row("goode", { adapters: { "claude-code": { model: "claude-opus-4-6" } } }), 1)).toEqual([]);
  });

  // The bug this exists for: a row naming a model the yaml never did.
  it("reports a field the row disagrees on", () => {
    seedIdentity(identities, "goode", "name: goode\nadapters: { claude-code: { model: claude-opus-4-6 } }\n");
    const drift = findIdentityDrift(row("goode", { adapters: { "claude-code": { model: "claude-sonnet-4-20250514" } } }), 1);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ field: "adapters", file: { "claude-code": { model: "claude-opus-4-6" } } });
  });

  it("reports a value present in the row but absent from the yaml", () => {
    seedIdentity(identities, "goode", "name: goode\n");
    const drift = findIdentityDrift(row("goode", { bags: ["linear"] }), 1);
    expect(drift.map((d) => d.field)).toEqual(["bags"]);
  });

  // The loader leaves an empty `bag_configs` out and the row stores `{}`: the
  // same nothing, which used to read as drift on every such identity.
  it("treats an empty map in the row as the yaml leaving it out", () => {
    seedIdentity(identities, "goode", "name: goode\n");
    expect(findIdentityDrift(row("goode", { bag_configs: {} }), 1)).toEqual([]);
    expect(findIdentityDrift(row("goode", { bag_configs: { linear: { team: "x" } } }), 1).map((d) => d.field)).toEqual(["bag_configs"]);
  });

  it("treats an empty list in the row as the yaml leaving it out", () => {
    seedIdentity(identities, "goode", "name: goode\n");
    expect(findIdentityDrift(row("goode", { bounds: [] }), 1)).toEqual([]);
    expect(findIdentityDrift(row("goode", { bounds: ["readonly"] }), 1).map((d) => d.field)).toEqual(["bounds"]);
  });

  // Order is not meaning for these lists, so a reorder must not read as drift.
  it("ignores list ordering", () => {
    seedIdentity(identities, "goode", "name: goode\ntraits:\n  - coding\n  - sessions\n");
    expect(findIdentityDrift(row("goode", { traits: ["sessions", "coding"] }), 1)).toEqual([]);
  });

  // A DB-only identity has no directory to disagree with, so it can never drift.
  it("reports nothing for an identity with no directory", () => {
    expect(findIdentityDrift(row("db-only", { adapters: { "claude-code": { model: "anything" } } }), 1)).toEqual([]);
  });

  it("reports unreadable yaml rather than passing it off as clean", () => {
    const dir = join(identities, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "identity.yaml"), "name: [unclosed\n");
    const drift = findIdentityDrift(row("broken", {}), 1);
    expect(drift).toHaveLength(1);
    expect(drift[0].field).toBe("identity.yaml");
  });

  // The shape every real install actually has: `heir` registers the directory
  // outside ~/.barry/identities, and the row carries a DB serial. Resolving by
  // id compared against synthetic ids (>= 1e9), which a serial can never equal,
  // so this reported "no drift" for every registered identity — a check whose
  // broken state was indistinguishable from a healthy one.
  it("finds a registered directory when the row carries a DB serial", () => {
    const outside = mkdtempSync(join(tmpdir(), "barry-elsewhere-"));
    const dir = join(outside, "barry-goode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "identity.yaml"), "name: goode\nadapters: { claude-code: { model: claude-opus-5 } }\n");
    registerIdentityDirectory("goode", dir);

    const drift = findIdentityDrift(row("goode", { adapters: { "claude-code": { model: "claude-opus-4-6" } } }), 1);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      field: "adapters",
      file: { "claude-code": { model: "claude-opus-5" } },
      db: { "claude-code": { model: "claude-opus-4-6" } },
    });
  });

  it("reports stale retired credential caches for removal", () => {
    seedIdentity(identities, "goode", "name: goode\n");
    const drift = findIdentityDrift(row("goode", { env: { API_KEY: "legacy" }, env_file: { API_KEY: "cached" } }), 1);
    expect(drift.map((entry) => entry.field)).toEqual(["env", "env_file"]);
    expect(drift.every((entry) => entry.file === undefined)).toBe(true);
  });

});

// ── The barrys → identities rename ───────────────────────────────────────
//
// These pin the two things that rename could have silently broken: existing
// directories on the old filename, and the synthetic ids derived from a hash
// whose input deliberately still says `barry:`.

describe("legacy barry.yaml compatibility", () => {
  // createIdentityDirectory registers directories outside the well-known dir in
  // the real `~/.barry` registry, so point BARRY_HOME at a scratch dir first.
  const originalHome = process.env.BARRY_HOME;

  beforeEach(() => {
    process.env.BARRY_HOME = mkdtempSync(join(tmpdir(), "identity-home-"));
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.BARRY_HOME;
    else process.env.BARRY_HOME = originalHome;
  });

  it("recognises a directory that still uses the legacy filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-legacy-"));
    writeFileSync(join(dir, LEGACY_IDENTITY_YAML), "name: legacy\n");

    expect(isIdentityDirectory(dir)).toBe(true);
    expect(findIdentityYamlPath(dir)).toBe(join(dir, LEGACY_IDENTITY_YAML));
    expect(loadIdentityFromDirectory(dir).name).toBe("legacy");
  });

  it("prefers identity.yaml when a directory somehow has both", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-both-"));
    writeFileSync(join(dir, LEGACY_IDENTITY_YAML), "name: old\n");
    writeFileSync(join(dir, IDENTITY_YAML), "name: new\n");

    expect(findIdentityYamlPath(dir)).toBe(join(dir, IDENTITY_YAML));
    expect(loadIdentityFromDirectory(dir).name).toBe("new");
  });

  // Nothing rewrites a user's files for them, so the first write after the
  // rename is what moves a directory forward.
  it("migrates a legacy directory to identity.yaml on write", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-migrate-"));
    writeFileSync(join(dir, LEGACY_IDENTITY_YAML), "name: mover\nadapters: { claude-code: { model: old-model } }\n");

    writeIdentityYaml(dir, { adapters: { "claude-code": { model: "new-model" } } });

    expect(existsSync(join(dir, IDENTITY_YAML))).toBe(true);
    expect(existsSync(join(dir, LEGACY_IDENTITY_YAML))).toBe(false);

    const written = yamlParse(readFileSync(join(dir, IDENTITY_YAML), "utf-8"));
    expect(written).toMatchObject({ name: "mover", adapters: { "claude-code": { model: "new-model" } } });
  });

  it("creates new directories with identity.yaml only", () => {
    const root = mkdtempSync(join(tmpdir(), "identity-create-"));
    const dir = createIdentityDirectory("fresh", {}, { dir: join(root, "fresh") });

    expect(existsSync(join(dir, IDENTITY_YAML))).toBe(true);
    expect(existsSync(join(dir, LEGACY_IDENTITY_YAML))).toBe(false);
  });

  it("refuses to overwrite a directory still on the legacy filename", () => {
    const root = mkdtempSync(join(tmpdir(), "identity-clash-"));
    const dir = join(root, "taken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LEGACY_IDENTITY_YAML), "name: taken\n");

    expect(() => createIdentityDirectory("taken", {}, { dir })).toThrow("already exists");
  });
});

describe("synthetic ids survive the rename", () => {
  // The hash input is the literal string `barry:<name>`, deliberately left
  // alone: changing it would renumber every file-based identity and invalidate
  // every token already issued. These are the live values — if this test fails,
  // the hash input moved and ids/tokens shifted underneath existing installs.
  it("still derives the pre-rename ids", () => {
    expect(syntheticIdFromName("bux")).toBe(1_357_913_634);
    expect(syntheticIdFromName("bgoode")).toBe(1_309_697_090);
  });

  it("keeps ids in the reserved range above DB serials", () => {
    for (const name of ["bux", "bgoode", "anything-else"]) {
      const id = syntheticIdFromName(name);
      expect(id).toBeGreaterThanOrEqual(SYNTHETIC_ID_OFFSET);
      expect(id).toBeLessThan(2 * SYNTHETIC_ID_OFFSET);
    }
  });
});


describe("keyed bag YAML", () => {
  it("loads store options without exposing mappings as bag names", () => {
    const dir = identityDir("name: keyed\nbags:\n  - artifacts:\n      store:\n        filepath: /data/artifacts.db\n      tools:\n        - get: deferred\n");
    try {
      const metadata = loadIdentityFromDirectory(dir).metadata;
      expect(metadata.bags).toEqual(["artifacts"]);
      expect(metadata.bag_configs).toEqual({ artifacts: { stores: { default: { filepath: "/data/artifacts.db" } }, tools: { get: "deferred" } } });
      writeIdentityYaml(dir, { displayName: "Edited label" });
      expect(loadIdentityFromDirectory(dir).metadata.bag_configs).toEqual(metadata.bag_configs);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
