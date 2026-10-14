import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseManifest, parseManifestObject, parseManifestObjectSafe, findManifest, getSkillsDirs } from "../manifest.js";

describe("manifest", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bags-manifest-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no manifest exists", () => {
    expect(findManifest(tmpDir)).toBeNull();
    expect(parseManifest(tmpDir)).toBeNull();
  });

  it("accepts AG-UI app manifests and keeps the legacy v1 version explicit", () => {
    const common = { name: "Barry", description: "Barry app", platform: "ios", build: { project: "app/Barry.xcodeproj", scheme: "Barry" }, output: "dist/Barry.app" };
    const agUi = parseManifestObject({ version: "v0.1", name: "test", description: "test", apps: {
      mobile: { ...common, "protocol-version": 2, capabilities: { streaming: true, approvalReview: true, replay: true } },
    } });
    expect(agUi.apps.mobile).toMatchObject({ protocolVersion: 2, capabilities: { approvalReview: true, replay: true } });
    expect(() => parseManifestObject({ version: "v0.1", name: "test", description: "test", apps: {
      mobile: { ...common, "protocol-version": 3 },
    } })).toThrow(/supported app protocol versions/);
  });

  it("parses a full manifest", () => {
    writeFileSync(join(tmpDir, "tools.ts"), "export {};\n");
    writeFileSync(join(tmpDir, "bag.yaml"), `
version: v0.1
name: test-bag
description: A test bag

mcp-servers:
  sentry:
    type: http
    url: https://mcp.sentry.dev/mcp
  linear:
    command: npx
    args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"]
    env: [LINEAR_API_KEY]

traits:
  test-debug:
    description: Debug tools
    access: read
    namespaces: [sentry, linear]

tools:
  - create-report: deferred
`);

    const manifest = parseManifest(tmpDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.name).toBe("test-bag");
    expect(manifest!.description).toBe("A test bag");

    // MCP servers
    expect(Object.keys(manifest!.mcpServers)).toEqual(["sentry", "linear"]);
    expect(manifest!.mcpServers.sentry.url).toBe("https://mcp.sentry.dev/mcp");
    expect(manifest!.mcpServers.linear.command).toBe("npx");
    expect(manifest!.mcpServers.linear.env).toEqual(["LINEAR_API_KEY"]);

    // Traits
    expect(Object.keys(manifest!.traits)).toEqual(["test-bag:test-debug"]);
    expect(manifest!.traits[`${manifest!.name}:test-debug`].bags).toEqual(["sentry", "linear"]);

    expect(manifest!.toolsEntry).toEqual({ entry: "tools.ts" });
    expect(manifest!.toolVisibility).toEqual({ "create-report": "deferred" });
  });



  it.each([{ entry: "tools.ts" }, { entry: "tools.ts", env: ["KEY"] }, { entry: "tools.ts", deferred: ["read"] }, { entry: "tools.ts", default_access: "deferred" }])("rejects legacy tool-entry authoring %j", tools => {
    expect(() => parseManifestObject({ name: "fixture", description: "Fixture", tools })).toThrow(/tools/);
  });

  it("rejects duplicate tool metadata with a code-owned metadata diagnostic", () => {
    expect(() => parseManifestObject({ name: "combo", description: "Fixture", "tool-metadata": [{ toolName: "read", namespace: "fixture", access: "read" }] })).toThrow(/declare local metadata in Barry.Tool code/);
  });


  it("handles minimal manifest", () => {
    writeFileSync(join(tmpDir, "bag.yaml"), `
version: v0.1
name: minimal
description: Just a name
`);
    const manifest = parseManifest(tmpDir);
    expect(manifest!.name).toBe("minimal");
    expect(manifest!.mcpServers).toEqual({});
    expect(manifest!.traits).toEqual({});
    expect(manifest!.tools).toEqual([]);
  });

  // Read-only is composed as a grant plus `bounds: [readonly]` — auto-traits
  // stopped generating a second `<bag>-read` trait, so without this key a bag
  // author has no way to express read-only.
  it("parses a trait's named bounds", () => {
    writeFileSync(join(tmpDir, "bag.yaml"), `
version: v0.1
name: bounded-bag
description: A bag with a read-only trait

traits:
  bounded-read:
    description: Read-only view
    access: readwrite
    bags: [sentry]
    bounds: [readonly]
`);
    const manifest = parseManifest(tmpDir);
    expect(manifest!.traits[`${manifest!.name}:bounded-read`].boundNames).toEqual(["readonly"]);
  });

  // The legacy spelling is gone, and this schema is strict, so a straggler
  // fails loudly here rather than loading as an unrestricted trait.
  it("rejects the legacy `scopes` spelling", () => {
    writeFileSync(join(tmpDir, "bag.yaml"), `
version: v0.1
name: legacy-bag
description: A bag still using the pre-rename key

traits:
  legacy:
    description: Read-only view
    access: readwrite
    bags: [sentry]
    scopes: [readonly]
`);
    expect(() => parseManifest(tmpDir)).toThrow(/scopes/);
  });

  it("defaults a trait with no bounds to an empty list", () => {
    writeFileSync(join(tmpDir, "bag.yaml"), `
version: v0.1
name: unbounded-bag
description: A bag whose trait declares no bounds

traits:
  plain:
    description: Everything
    access: readwrite
    bags: [sentry]
`);
    const manifest = parseManifest(tmpDir);
    expect(manifest!.traits[`${manifest!.name}:plain`].boundNames).toEqual([]);
    expect(manifest!.traits[`${manifest!.name}:plain`].bound).toBeUndefined();
  });

  // An inline bound lets a bag outside this repo ship its own restriction
  // without a row in the framework's bounds table.
  it("parses a trait's inline bound", () => {
    writeFileSync(join(tmpDir, "bag.yaml"), `
version: v0.1
name: inline-bound-bag
description: A bag whose trait carries its own restriction

traits:
  guarded:
    description: Grants git tools but keeps raw git out of Bash
    access: readwrite
    bags: [sentry]
    bound:
      deniedTools: [dangerous]
      bash:
        denyPrograms: [git, gh]
      network:
        actions: [write]
`);
    const manifest = parseManifest(tmpDir);
    expect(manifest!.traits[`${manifest!.name}:guarded`].bound).toEqual({
      deniedTools: ["dangerous"],
      bash: { denyPrograms: ["git", "gh"] },
      network: { actions: ["write"] },
    });
  });

  // A bound that parses to {} restricts nothing and is indistinguishable from
  // a working one, so a misspelled dimension has to fail at parse time.
  it("rejects a misspelled key inside an inline bound", () => {
    writeFileSync(join(tmpDir, "bag.yaml"), `
version: v0.1
name: typo-bound-bag
description: A bag whose inline bound has a typo

traits:
  guarded:
    description: Means to deny git
    access: readwrite
    bags: [sentry]
    bound:
      bash:
        denyProgram: [git]
`);
    expect(() => parseManifest(tmpDir)).toThrow(/denyProgram/);
  });

  it("rejects an unknown network action in an inline bound", () => {
    writeFileSync(join(tmpDir, "bag.yaml"), `
version: v0.1
name: bad-action-bag
description: A bag whose inline bound names a tag that enforces nothing

traits:
  guarded:
    description: Means to deny outbound writes
    access: readwrite
    bags: [sentry]
    bound:
      network:
        actions: [writes]
`);
    expect(() => parseManifest(tmpDir)).toThrow();
  });

  it("rejects unknown fields with a path-specific error", () => {
    writeFileSync(join(tmpDir, "bag.yaml"), `
version: v0.1
name: invalid
description: Invalid bag
unexpected: true
`);

    expect(() => parseManifest(tmpDir)).toThrow("unexpected");
  });

  it("accepts a manifest with no version", () => {
    // There is only one manifest format, so nothing branches on a version and
    // a bag need not declare one.
    writeFileSync(join(tmpDir, "bag.yaml"), `
name: unversioned
description: No version declared
`);

    expect(parseManifest(tmpDir)?.version).toBeUndefined();
  });

  it("carries the bag's own version when declared", () => {
    writeFileSync(join(tmpDir, "bag.yaml"), `
version: v0.1
name: versioned
description: Declares a release
`);

    expect(parseManifest(tmpDir)?.version).toBe("v0.1");
  });

  it("detects skills directory", () => {
    mkdirSync(join(tmpDir, "skills"), { recursive: true });
    expect(getSkillsDirs(tmpDir)).toEqual([join(tmpDir, "skills")]);
  });

  it("returns empty when no skills directory", () => {
    expect(getSkillsDirs(tmpDir)).toEqual([]);
  });

  it("refuses deployment manifests with an explicit provider-script migration diagnostic", () => {
    expect(() => parseManifestObject({ name: "demo", description: "Demo", deployments: {} })).toThrow(/provider-owned deploy scripts/);
  });

  describe("default_notifier", () => {
    function write(yaml: string): void {
      writeFileSync(join(tmpDir, "bag.yaml"), yaml);
    }

    it("parses a tool-only notifier", () => {
      write(`
name: slack
description: d
default_notifier:
  tool: send_slack_message_to_self
`);
      expect(parseManifest(tmpDir)!.default_notifier).toEqual({
        tool: "send_slack_message_to_self",
      });
    });

    it("parses an optional target", () => {
      write(`
name: slack
description: d
default_notifier:
  tool: send_slack_message
  target: "#alerts"
`);
      expect(parseManifest(tmpDir)!.default_notifier).toEqual({
        tool: "send_slack_message",
        target: "#alerts",
      });
    });

    it("is absent when not declared", () => {
      write(`
name: git
description: d
`);
      expect(parseManifest(tmpDir)!.default_notifier).toBeUndefined();
    });

    it("rejects a notifier with no tool", () => {
      write(`
name: slack
description: d
default_notifier:
  target: "#alerts"
`);
      expect(() => parseManifest(tmpDir)).toThrow();
    });
  });
});

describe("retired service keys say what replaced them", () => {
  const service = (fields: Record<string, unknown>) =>
    parseManifestObject({
      name: "x",
      description: "x",
      services: { web: { description: "web", command: "node", serves: "http", ...fields } },
    }).services.web;

  it.each([
    ["port", 4870, /replaced by `serves: http`/],
    ["run-at-load", false, /replaced by `autostart`/],
    ["keep-alive", true, /always restarted/],
    ["host", "metrics.home.test", /hosting\.yaml/],
    ["tunnel", { hostname: "metrics.example.com" }, /hosting\.yaml/],
    ["tailnet", true, /hosting\.yaml/],
  ])("refuses `%s`", (key, value, message) => {
    expect(() => service({ [key]: value })).toThrow(message);
  });

  it("defaults autostart to login", () => {
    expect(service({}).autostart).toBe("login");
  });
});

// A service naming `user:` runs as a different PRINCIPAL, which is the only
// thing that separates it from the agent sessions sharing this machine —
// same-UID is same-trust. These guards exist because the failure they prevent
// is invisible: a service that quietly runs as the invoking user looks exactly
// like a correctly isolated one.
describe("service user and socket (privilege separation)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bags-user-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (serviceBody: string) => {
    writeFileSync(join(tmpDir, "bag.yaml"), `
version: v0.1
name: vault-bag
description: A bag with an isolated service

services:
  api:
    description: Secret store
    command: node
${serviceBody}
`);
  };

  it("carries user and socket through to the parsed service", () => {
    write("    user: _barryvault\n    socket: run/vault.sock");
    const svc = parseManifest(tmpDir)?.services?.api;
    expect(svc?.user).toBe("_barryvault");
    expect(svc?.socket).toBe("run/vault.sock");
  });

  it("leaves user undefined for an ordinary service", () => {
    write("    serves: http");
    expect(parseManifest(tmpDir)?.services?.api?.user).toBeUndefined();
  });

  // A name without the underscore prefix is most likely a real login account —
  // running a daemon as the human would defeat the whole point.
  it("rejects a user that is not a service account", () => {
    write("    user: tyler\n    socket: run/vault.sock");
    expect(() => parseManifest(tmpDir)).toThrow(/service account name/);
  });

});

describe("service literal environment", () => {
  it("preserves literals and empty values while keeping secret names separate", () => {
    const manifest = parseManifestObject({ name: "x", description: "d", services: { api: {
      description: "d", command: "true", env: ["MODE=production", "EMPTY=", "PATH_LITERAL=$HOME/config"], secrets: ["API_KEY"],
    } } });
    expect(manifest.services?.api?.env).toEqual([
      { name: "MODE", source: "value", value: "production" },
      { name: "EMPTY", source: "value", value: "" },
      { name: "PATH_LITERAL", source: "value", value: "$HOME/config" },
    ]);
    expect(manifest.services?.api?.secrets).toEqual(["API_KEY"]);
  });
  it.each([["TOKEN"], { TOKEN: { source: "vault" } }, { TOKEN: { source: ".env" } }, { TOKEN: { source: "keychain" } }, ["MODE=a", "MODE=b"]])("rejects retired or ambiguous environment declarations: %j", env => {
    expect(() => parseManifestObject({ name: "x", description: "d", services: { api: { description: "d", command: "true", env } } })).toThrow();
  });
  // A service that can run without a secret (push credentials, an optional
  // fallback) says so, instead of failing to start when it is undeclared.
  it("carries optional secrets separately from required ones", () => {
    const manifest = parseManifestObject({ name: "x", description: "d", services: { api: {
      description: "d", command: "true", secrets: ["API_KEY"], "optional-secrets": ["PUSH_KEY"],
    } } });
    expect(manifest.services?.api?.secrets).toEqual(["API_KEY"]);
    expect(manifest.services?.api?.optionalSecrets).toEqual(["PUSH_KEY"]);
  });
  it("rejects a service vault selector", () => {
    expect(() => parseManifestObject({ name: "x", description: "d", services: { api: { description: "d", command: "true", vault: "ops" } } })).toThrow();
  });
});

/**
 * `bags:` in both forms.
 *
 * The map form exists so a bag can say where its children come from, replacing
 * the git submodules that did that job outside Barry's view. The property that
 * matters most here is that BOTH forms normalize to the same `bags: string[]`
 * — every consumer of composition (auto-traits, identity sync, doctor) reads
 * that array and must never learn which form was written.
 */
describe("manifest bags: composition", () => {
  const base = { name: "parent", description: "d" };
  const parse = (bags: unknown) => parseManifestObject({ ...base, bags });

  it("keeps the list form working", () => {
    const m = parse(["git", "filesystem"]);
    expect(m.bags).toEqual(["git", "filesystem"]);
    expect(m.bagSources).toBeUndefined();
  });

  it("reads the map form as the same composition list, plus sources", () => {
    const m = parse({ "point-guard": { repo: "perintyler/point-guard", rev: "ee11bc85" } });
    expect(m.bags).toEqual(["point-guard"]);
    expect(m.bagSources).toEqual({
      "point-guard": { repo: "perintyler/point-guard", rev: "ee11bc85" },
    });
  });

  it("accepts a local path as a source", () => {
    const m = parse({ child: { path: "../sibling-bag" } });
    expect(m.bags).toEqual(["child"]);
    expect(m.bagSources?.child).toEqual({ path: "../sibling-bag" });
  });

  // One bag out of a repo holding several. A separate key from `path:`, which
  // means a sibling on local disk instead of a directory inside a clone.
  it("accepts a subdir alongside a repo", () => {
    const m = parse({ "vantage-core": { repo: "vantage-sh/vantage-bags", rev: "abc", subdir: "vantage-core/" } });
    expect(m.bagSources?.["vantage-core"]).toEqual({
      repo: "vantage-sh/vantage-bags",
      rev: "abc",
      subdir: "vantage-core/",
    });
  });

  // `my-bag:` with nothing after it is null in YAML, and means "compose this,
  // source unstated" — the map-form spelling of a bare name.
  it("treats a null entry as a bare name", () => {
    const m = parse({ plain: null });
    expect(m.bags).toEqual(["plain"]);
    expect(m.bagSources).toBeUndefined();
  });

  it("allows sourced and unsourced children side by side", () => {
    const m = parse({ git: null, mine: { repo: "o/n" } });
    expect(m.bags).toEqual(["git", "mine"]);
    expect(m.bagSources).toEqual({ mine: { repo: "o/n" } });
  });

  it("preserves declaration order", () => {
    expect(parse({ c: null, a: null, b: null }).bags).toEqual(["c", "a", "b"]);
  });

  /**
   * Every one of these would otherwise parse into something that looks
   * installable. The first is the important one: an entry naming no source at
   * all would fall back to "resolve from the registry", which is exactly the
   * silent, best-effort behaviour the map form exists to replace — and it
   * would report success while contributing nothing.
   */
  it("rejects an entry that names no source", () => {
    expect(() => parse({ x: {} })).toThrow(/needs .repo. or .path./);
  });

  it("rejects a contradictory entry", () => {
    expect(() => parse({ x: { repo: "o/n", path: "../y" } })).toThrow(/mutually exclusive/);
    expect(() => parse({ x: { repo: "o/n", rev: "a", ref: "b" } })).toThrow(/mutually exclusive/);
  });

  // A pin against a path would silently do nothing rather than pin anything.
  it("rejects a pin without a repo", () => {
    expect(() => parse({ x: { path: "../y", rev: "abc" } })).toThrow(/need a .repo./);
  });

  // `path:` already points at the bag directory itself, so a subdir beside it
  // is either a contradiction or a `repo:` the author forgot to write.
  it("rejects a subdir without a repo", () => {
    expect(() => parse({ x: { path: "../y", subdir: "core" } })).toThrow(/needs a .repo./);
    expect(() => parse({ x: { subdir: "core" } })).toThrow(/needs a .repo./);
  });

  // The schema is strict everywhere else, and a misspelled key here would
  // read as "track the default branch" instead of the pin that was meant.
  it("rejects an unknown key", () => {
    expect(() => parse({ x: { repo: "o/n", brnch: "main" } })).toThrow(/Unrecognized key/);
  });

  it("rejects an empty source value", () => {
    expect(() => parse({ x: { repo: "" } })).toThrow();
  });
});

describe("manifest hooks", () => {
  const agentHook = { event: "session-start", run: "hooks/tracker.ts", args: ["start"] };

  // Every bag that declared hooks before the map form wrote a bare array, and
  // a manifest that fails to parse loses the WHOLE bag, not just its hooks.
  it("still accepts the bare array, as agent hooks", () => {
    const m = parseManifestObject({ name: "x", description: "d", hooks: [agentHook] });
    expect(m.hooks).toEqual([{ event: "session-start", run: "hooks/tracker.ts", args: ["start"] }]);
    expect(m.barryHooks).toBeUndefined();
  });

  it("accepts the map form and keeps the two kinds apart", () => {
    const m = parseManifestObject({
      name: "x",
      description: "d",
      hooks: { agent: [agentHook], barry: [{ event: "event-created", run: "hooks/on-event.ts" }] },
    });
    expect(m.hooks).toHaveLength(1);
    expect(m.barryHooks).toEqual([{ event: "event-created", run: "hooks/on-event.ts" }]);
  });

  it("produces the same agent hooks from either spelling", () => {
    const fromArray = parseManifestObject({ name: "x", description: "d", hooks: [agentHook] });
    const fromMap = parseManifestObject({ name: "x", description: "d", hooks: { agent: [agentHook] } });
    expect(fromArray.hooks).toEqual(fromMap.hooks);
  });

  it("rejects an unknown hook kind", () => {
    expect(() =>
      parseManifestObject({ name: "x", description: "d", hooks: { agentt: [agentHook] } }),
    ).toThrow();
  });
});

describe("services declare what they serve, not where", () => {
  const service = (fields: Record<string, unknown>) =>
    parseManifestObject({
      name: "x",
      description: "x",
      services: { web: { description: "web", command: "node", ...fields } },
    }).services.web;

  it("carries serves and local-only through to the parsed service", () => {
    const web = service({ serves: "http", health: "/health", "local-only": true });
    expect(web.serves).toBe("http");
    expect(web.localOnly).toBe(true);
  });

  it("refuses a health path on a service that serves nothing", () => {
    expect(() => service({ health: "/health" })).toThrow(/`health` requires `serves: http`/);
  });

  it("refuses local-only on a service that serves nothing", () => {
    expect(() => service({ "local-only": true })).toThrow(/`local-only` describes a service/);
  });

  it("refuses a protocol it does not know", () => {
    expect(() => service({ serves: "grpc" })).toThrow();
  });
});

describe("hosting providers declare what they provide", () => {
  const provides = (value: unknown) =>
    parseManifestObject({ name: "p", description: "p", provides: value }).provides;

  it("normalizes a tunnel provider, defaulting to no gates", () => {
    expect(provides({ tunnel: { reach: ["private"] } })).toEqual({ tunnel: { reach: ["private"], gates: [] } });
    expect(provides({ tunnel: { reach: ["public"], gates: ["access"] } })).toEqual({
      tunnel: { reach: ["public"], gates: ["access"] },
    });
  });

  it("normalizes a local-name provider", () => {
    expect(provides({ local: {} })).toEqual({ local: {} });
  });

  it("refuses an empty capability and an unknown reach or gate", () => {
    expect(() => provides({})).toThrow(/must name `local`, `tunnel`, or both/);
    expect(() => provides({ tunnel: { reach: ["everywhere"] } })).toThrow();
    expect(() => provides({ tunnel: { reach: ["public"], gates: ["password"] } })).toThrow();
    expect(() => provides({ tunnel: { reach: [] } })).toThrow();
  });
});

describe("permissions", () => {
  const base = { version: "v0.1", name: "demo", description: "a bag" };

  it("carries the macOS permissions a bag declares", () => {
    const { manifest } = parseManifestObjectSafe({
      ...base,
      permissions: [{ kind: "automation", app: "Pages", reason: "reads and writes documents" }],
    });
    expect(manifest?.permissions).toEqual([{ kind: "automation", app: "Pages", reason: "reads and writes documents" }]);
  });

  it("refuses an automation permission that names no app", () => {
    const { manifest, error } = parseManifestObjectSafe({ ...base, permissions: [{ kind: "automation", reason: "x" }] });
    expect(manifest).toBeFalsy();
    expect(error).toMatch(/names the `app`/);
  });
});

describe("bag script literal environment", () => {
  it("preserves exact values and empty strings", () => {
    const env = ["MODE=$HOME/exact=value", "EMPTY="];
    const manifest = parseManifestObject({ name: "fixture", description: "Fixture", scripts: { run: { description: "Run", command: "true", env } } });
    expect(manifest.scripts?.run.env).toEqual(env);
  });
  it.each([{ env: ["MODE=one", "MODE=two"] }, { env: ["TOKEN"] }, { env: ["MODE=bad\0value"] }])("rejects malformed script literals %j", ({ env }) => {
    expect(() => parseManifestObject({ name: "fixture", description: "Fixture", scripts: { run: { description: "Run", command: "true", env } } })).toThrow();
  });
});


describe("declared store restore adapters", () => {
  const base = { name: "notes", description: "Notes", store: { owned_by: "identity", engine: "sqlite", migrations: "./migrations" } };
  it("normalizes local compiled restore entries separately from capture", () => {
    const parsed = parseManifestObject({ ...base, restores: { default: { entry: "./dist/restore.mjs" } }, snapshots: { default: { entry: "./dist/capture.js" } } });
    expect(parsed.storeRestores).toEqual({ default: { entry: "./dist/restore.mjs" } });
    expect(parsed.storeSnapshots).toEqual({ default: { entry: "./dist/capture.js" } });
  });
  it.each(["../restore.js", "/restore.js", "./restore.ts", "./dist/../restore.js"])("refuses unsafe or uncompiled restore entry %s", entry => {
    expect(() => parseManifestObject({ ...base, restores: { default: { entry } } })).toThrow(/restore entry/);
  });
});


describe("extensions", () => {
  const base = { name: "search", extends: "sessions", description: "Search" };
  it("parses the parent and short name", () => {
    expect(parseManifestObject(base)).toMatchObject(base);
    expect(parseManifestObject({ name: "plain", description: "Plain", extends: undefined, services: {} }).extends).toBeUndefined();
  });
  it.each([
    ["bags", []], ["services", {}], ["apps", {}],
    ["store", { owned_by: "identity", engine: "sqlite", migrations: "migrations" }],
    ["stores", {}], ["snapshots", {}], ["restores", {}], ["traits", {}], ["bounds", {}],
    ["mcp-servers", {}], ["jobs", {}], ["hooks", {}], ["requires", {}],
    ["prompts", { entry: "prompt.ts" }], ["permissions", []], ["credentials", {}],
    ["constants", {}], ["verbs", {}], ["nouns", {}], ["auth", {}], ["cli", {}],
    ["slash-commands", {}], ["default_notifier", {}], ["native-policy", {}], ["vendors", {}],
    ["infra", {}], ["provides", {}], ["deployments", {}], ["tool-metadata", {}], ["unknown-key", {}],
  ])("refuses %s and names the parent", (key, value) => {
    expect(() => parseManifestObject({ ...base, [key]: value })).toThrow(new RegExp(`${key}.*declare it on the parent`));
  });
  it.each([{ name: "sessions/search" }, { extends: "sessions/search" }, { extends: "search" }])("refuses invalid names %j", (value) => {
    expect(() => parseManifestObject({ ...base, ...value })).toThrow();
  });
});
