import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeIdentitiesDb, getIdentitiesSqlite } from "../store/identities-db.js";
import { Traits } from "./traits.js";
import { Bounds } from "./bounds.js";
import { resolveIdentitySessionBound, resolveIdentitySessionContext, sessionPolicy } from "./session-bound.js";
import { nativeToolDenials, nativeToolsTakenBack, filterTools, resolveNativePolicy } from "@barry-rocks/sdk/bounds";
import { testAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { parseBounds } from "@barry-rocks/sdk/internal/identities";
import { parse as parseYaml } from "yaml";
import { parseManifest } from "@barry-rocks/sdk/bags";

import { Identities, resolveIdentityConfig } from "../store/identities.js";
import { createUser } from "../store/users.js";


let directory: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.BARRY_IDENTITIES_DB;
  directory = mkdtempSync(join(tmpdir(), "bag-bound-roundtrip-"));
  closeIdentitiesDb();
  process.env.BARRY_IDENTITIES_DB = join(directory, "identities.db");
});
afterEach(() => {
  closeIdentitiesDb();
  if (previous === undefined) delete process.env.BARRY_IDENTITIES_DB;
  else process.env.BARRY_IDENTITIES_DB = previous;
  rmSync(directory, { recursive: true, force: true });
});

describe("stored bag policy composition", () => {
  it.each([
    ["claude", "claude-code", "Bash"],
    ["cursor", "cursor", "Shell"],
    ["codex", "codex", "exec_command"],
    ["opencode", "opencode", "shell"],
  ])("an identity selecting bash:no-bash carries the bash bag's policy into %s launch settings", async (folder, id, shell) => {
    const bash = parseManifest(new URL("../../../bash", import.meta.url).pathname)!;
    const manifest = parseManifest(new URL(`../../../../adapters/sessions/${folder}`, import.meta.url).pathname)!;
    for (const bag of [bash, manifest]) {
      for (const [name, definition] of Object.entries(bag.bounds ?? {})) {
        await Bounds.upsertBound({ name, ...definition, bag: bag.name });
      }
      await Traits.ensureTraits(Object.entries(bag.traits).map(([name, trait]) => ({
        name, ...trait, namespaces: trait.bags, access: "read" as const, bag: bag.name,
      })));
    }
    const user = await createUser({ name: "Reviewer", email: "reviewer@example.test" });
    const identity = await Identities.create({ actor_id: user.id, name: "reviewer", metadata: { traits: ["bash:no-bash"] } });
    const bound = await resolveIdentitySessionBound({ identityId: identity.id, traitNames: [], harness: id });
    const inventory = [...new Set(Object.values(manifest.bounds ?? {}).flatMap((definition) => definition.bound.nativeTools?.[id] ?? []))];
    const harness = { id, nativeTools: inventory, bag: { path: "", manifest } };
    const cliDenied = resolveNativePolicy({ bound, tools: [] }, harness, "guest").denied;
    const hostedDenied = resolveNativePolicy({ bound, tools: [] }, harness, "hosted").denied;
    expect(cliDenied).toContain(shell);
    expect(hostedDenied).toContain(shell);
    expect(nativeToolsTakenBack(bound, harness)).toEqual(manifest.bounds![`${folder}:no-shell`].bound.nativeTools![id]);

    const grant = { name: "grant", namespaces: ["bash", "filesystem"], access: "readwrite" as const };
    expect(filterTools([
      { namespace: "bash", toolName: "Bash", access: "write" },
      { namespace: "bash", toolName: "BashOutput", access: "read" },
      { namespace: "bash", toolName: "KillShell", access: "write" },
      { namespace: "filesystem", toolName: "Read", access: "read" },
    ], ["grant"], { grant }, bound!)).toEqual(["Read"]);

    const unselected = await resolveIdentitySessionBound({ traitNames: [], harness: id });
    expect(resolveNativePolicy({ bound: unselected, tools: [] }, harness, "guest").denied).toContain(shell);
    await expect(Traits.ensureTraits([{ name: "bash:no-bash", namespaces: [], access: "read", bag: "another-bag" }])).rejects.toThrow(/already owned by bag bash/);
  });

  it("resolves an identity's per-harness traits on the harness its sessions run on, when the session names none", async () => {
    await Traits.ensureTraits([
      { name: "probe:claude", namespaces: ["filesystem"], access: "read", bag: "probe" },
      { name: "probe:codex", namespaces: ["github"], access: "read", bag: "probe" },
      { name: "probe:shell", namespaces: [], access: "read", harnessTraits: { "claude-code": "probe:claude", codex: "probe:codex" }, bag: "probe" },
    ]);
    const policy = sessionPolicy({
      identity: (id) => Identities.get(id),
      config: resolveIdentityConfig,
      traits: () => Traits.list(),
      bounds: () => Bounds.list(),
      harness: id => {
        const adapter = testAdapter({ id: id === "claude" ? "claude-code" : id });
        return { id: adapter.id, label: adapter.label, requirements: adapter.requirements, capabilities: adapter.capabilities,
          nativeTools: [], defaultMode: adapter.defaultMode, modes: adapter.modes,
          packageName: "fixture", contractVersion: 1, path: "/fixture", version: "1.0.0", installedAt: "fixture" };
      },
    });
    const user = await createUser({ name: "Prober", email: "prober@example.test" });
    const identity = await Identities.create({ actor_id: user.id, name: "prober", metadata: { traits: ["probe:shell"] } });
    expect((await policy.grants(identity, { defaults: false }, [])).namespaces).toEqual(["filesystem"]);
    const codex = { ...identity, metadata: { ...identity.metadata, adapters: { codex: { default: true } } } };
    expect((await policy.grants(codex, { defaults: false }, [])).namespaces).toEqual(["github"]);
    expect((await policy.grants(codex, { defaults: false, harness: "claude-code" }, [])).namespaces).toEqual(["filesystem"]);
    // A session with no identity has no default harness to fall back to.
    await expect(policy.grants(undefined, { traits: ["probe:shell"], defaults: false }, [])).rejects.toThrow(/requires the running harness/);
  });

  it("preserves includes and harness dispatch through sync and resolves named and inline bounds together", async () => {
    await Bounds.upsertBound({ name: "harness:shell", bound: { nativeTools: { harness: ["shell"] } }, bag: "harness" });
    await Traits.ensureTraits([
      { name: "harness:no-shell", namespaces: [], access: "read", boundNames: ["harness:shell"], bag: "harness" },
      { name: "harness:all", namespaces: [], access: "read", includes: ["harness:no-shell"], bag: "harness" },
      { name: "shared:all", namespaces: [], access: "read", harnessTraits: { harness: "harness:all" }, bag: "shared" },
    ]);
    const resolved = await resolveIdentitySessionBound({ traitNames: ["shared:all"], harness: "harness", inlineBound: { deniedTools: ["McpOnly"] } });
    expect(nativeToolDenials(resolved, "harness", ["shell", "read"])).toEqual(["shell"]);
    expect(resolved?.deniedTools).toEqual(["McpOnly"]);
    const withoutSelection = await resolveIdentitySessionBound({ traitNames: [], harness: "harness" });
    expect(nativeToolDenials(withoutSelection, "harness", ["shell", "read"])).toEqual([]);
    await expect(resolveIdentitySessionBound({ traitNames: ["shared:all"], harness: "other" })).rejects.toThrow(/no policy/);
  });

  it("resolves composed and harness grants, skills and instructions through the same stored trait chain", async () => {
    await Traits.ensureTraits([
      { name: "base", namespaces: ["memory"], access: "read", skills: ["remember"], instructions: ["context"], bag: "probe" },
      { name: "vendor", namespaces: ["filesystem"], access: "readwrite", skills: ["write"], instructions: ["limits"], bag: "probe" },
      { name: "composed", namespaces: [], access: "read", includes: ["base"], harnessTraits: { test: "vendor" }, bag: "probe" },
    ]);
    await Traits.upsertTrait({ name: "base", namespaces: ["memory"], tools: ["memory_save"], access: "read", skills: ["remember"], instructions: ["context"] });
    await Traits.upsertTrait({ name: "vendor", namespaces: ["filesystem"], tools: ["Write"], access: "readwrite", skills: ["write"], instructions: ["limits"] });
    expect(await Traits.resolveTools(["composed"], "test")).toEqual(["memory_save", "Write"]);
    expect(await Traits.resolveTraitToolsets(["composed"], "test")).toEqual(["memory", "filesystem"]);
    expect(await Traits.resolveSkills(["composed"], "test")).toEqual(["remember", "write"]);
    expect(await Traits.resolveInstructions(["composed"], "test")).toEqual(["context", "limits"]);
    await expect(Traits.resolveTools(["composed"], "other")).rejects.toThrow(/no policy/);
    expect(await Traits.resolveTools([], "test")).toEqual([]);
  });

  it("filters raw process permission through stored grants and inherited restrictions", async () => {
    await Traits.ensureTraits([
      { name: "writer", namespaces: ["bash"], access: "readwrite", bag: "probe" },
      { name: "reader", namespaces: ["bash"], access: "read", bag: "probe" },
    ]);
    const tool = [{ namespace: "bash", toolName: "Bash", access: "write" as const }];
    const context = (traitNames: string[], inlineBound?: Parameters<typeof resolveIdentitySessionContext>[0]["inlineBound"]) =>
      resolveIdentitySessionContext({ traitNames, inlineBound, includeDefaultTraits: false }, tool);
    expect((await context(["writer"])).allowedToolIds).toEqual(["bash:Bash"]);
    expect((await context(["reader"])).allowedToolIds).toEqual([]);
    expect((await context([])).allowedToolIds).toEqual([]);
    expect((await context(["writer"], { deniedTools: ["Bash"] })).allowedToolIds).toEqual([]);
    await expect(context(["missing"])).rejects.toThrow(/unknown/);
    await expect(resolveIdentitySessionContext({ identityId: 99999, traitNames: ["writer"] }, tool)).rejects.toThrow(/unknown session identity/);
  });

  it("refuses conflicting bound aliases without replacing the owner's restrictions", async () => {
    await Bounds.upsertBound({ name: "legacy", bound: { deniedTools: ["Protected"] }, bag: "first" });
    await expect(Bounds.upsertBound({ name: "legacy", bound: {}, bag: "second" })).rejects.toThrow(/already owned/);
    expect((await Bounds.getByName("legacy"))?.bound.deniedTools).toEqual(["Protected"]);
    await expect(Bounds.assertOwnership([{ name: "new-alias", bag: "first" }, { name: "new-alias", bag: "second" }])).rejects.toThrow(/already owned/);
  });
});


it("stores, composes and retires native grants without deleting user policy", async () => {
  await Traits.ensureTraits([{ name: "probe:native-file-reads", bag: "probe", namespaces: [], access: "read", nativeTools: { probe: ["Read"] } }]);
  expect((await Traits.list()).find(trait => trait.name === "probe:native-file-reads")?.nativeTools).toEqual({ probe: ["Read"] });
  await Traits.ensureTraits([{ name: "probe:native-file-reads", bag: "probe", namespaces: [], access: "read" }]);
  expect((await Traits.list()).find(trait => trait.name === "probe:native-file-reads")?.nativeTools).toBeUndefined();
  const db = getIdentitiesSqlite();
  const insert = db.prepare("INSERT INTO traits (token, name, access, bag, metadata) VALUES (lower(hex(randomblob(16))), ?, 'read', ?, ?)");
  insert.run("no-native-tools", null, "{}");
  insert.run("claude:no-shell", "claude", "{}");
  insert.run("user:no-shell", "user", "{}");
  insert.run("bash:no-bash", "bash", JSON.stringify({ harnessTraits: { "claude-code": "claude:no-shell" } }));
  await Bounds.upsertBound({ name: "claude:baseline", bag: "claude", bound: {} });
  await Bounds.upsertBound({ name: "claude:no-shell", bag: "claude", bound: {} });
  db.exec(readFileSync(new URL("../../migrations/identities/005_retired_native_policy.sql", import.meta.url), "utf8"));
  expect((await Traits.list()).map(trait => trait.name)).toEqual(expect.arrayContaining(["user:no-shell", "bash:no-bash", "probe:native-file-reads"]));
  expect((await Traits.list()).some(trait => ["no-native-tools", "claude:no-shell"].includes(trait.name))).toBe(false);
  expect((await Traits.list()).find(trait => trait.name === "bash:no-bash")?.harnessTraits).toBeUndefined();
  expect(await Bounds.getByName("claude:baseline")).toBeUndefined();
  expect(await Bounds.getByName("claude:no-shell")).toBeDefined();
});


it("composes real installed native traits, restrictions and mode limits", async () => {
  const store = loadAdapters({ file: join(directory, "adapters.json"), registerBag: async () => {} });
  const records = await Promise.all(["claude", "pi", "cursor"].map(folder => store.add(new URL(`../../../../adapters/sessions/${folder}`, import.meta.url).pathname)));
  for (const record of records) {
    const manifest = record.bag!.manifest;
    await Traits.ensureTraits(Object.entries(manifest.traits).map(([name, trait]) => ({ ...trait, name, namespaces: trait.bags, bag: manifest.name })));
    for (const [name, definition] of Object.entries(manifest.bounds ?? {})) await Bounds.upsertBound({ ...definition, name, bag: manifest.name });
  }
  for (const entry of parseBounds(parseYaml(readFileSync(new URL("../../../../identity.yaml", import.meta.url), "utf8")).bounds)) await Bounds.upsertBound({ name: entry.name, bound: entry.bound! });
  const bash = parseManifest(new URL("../../../bash", import.meta.url).pathname)!;
  await Traits.ensureTraits(Object.entries(bash.traits).map(([name, trait]) => ({ ...trait, name, namespaces: trait.bags, bag: "bash" })));
  for (const [name, definition] of Object.entries(bash.bounds!)) await Bounds.upsertBound({ ...definition, name, bag: "bash" });
  const policy = sessionPolicy({ identity: id => Identities.get(id), config: resolveIdentityConfig, traits: () => Traits.list(), bounds: () => Bounds.list(), harness: id => records.find(record => record.id === id || record.aliases?.includes(id)), harnesses: () => records });
  const select = (traits: string[], harness = "claude-code", bounds: string[] = []) => policy.grants(undefined, { traits, harness, bounds, defaults: false, mode: "hosted" }, []);
  const reads = await select(["native-file-reads"]);
  expect(reads.traits).toEqual(["claude:native-file-reads"]);
  expect(reads.tools.map(tool => tool.name)).toEqual(["Read", "Glob", "Grep"]);
  expect(reads.tools.every(tool => tool.bag === null && tool.namespace === "claude-code")).toBe(true);
  expect((await select(["native-network"], "claude-code", ["no-network"])).tools).toEqual([]);
  expect((await select(["native-shell", "bash:no-bash"])).tools).toEqual([]);
  const cursor = await select([], "cursor");
  expect(cursor.tools.find(tool => tool.name === "Grep")?.uncontrolled).toBeTruthy();
  expect(resolveNativePolicy(cursor, records.find(record => record.id === "cursor")!, "hosted").refused).toEqual({});
  const restricted = await select([], "cursor", ["no-secrets"]);
  expect(resolveNativePolicy(restricted, records.find(record => record.id === "cursor")!, "hosted").conflicts).toHaveProperty("Grep");
  expect((await select(["native-network"], "pi")).traits).toEqual([]);
});


describe("identity entry grants", () => {
  const trait = { name: "bash", description: null, tools: [], namespaces: ["bash"], access: "readwrite" as const, skills: [], instructions: [], bound: {}, boundNames: [], bag: "bash" };
  const base = resolveIdentityConfig({ id: 1, token: "base", actor_id: 1, name: "barry", created_at: "", last_used_at: null, metadata: {
    traits: ["bash"], bounds: [{ readonly: { optional: true, description: "Read only", deniedAccess: ["write"] } }],
  } });
  const row = (metadata: import("../store/identities.js").IdentityMetadata): import("../store/identities.js").IdentityRecord => ({ id: 2, token: "child", actor_id: 1, name: "child", created_at: "", last_used_at: null, metadata });
  const policy = sessionPolicy({ identity: async () => undefined, config: resolveIdentityConfig, traits: async () => [trait], bounds: async () => [], base: () => base });

  it("offers local optional traits and bounds without granting them", async () => {
    const identity = row({ traits: [{ review: { optional: true, description: "Review", bags: ["github"], bounds: ["no-push"] } }], bounds: [{ "no-push": { optional: true, description: "No push", bash: { denyPrograms: ["git:push"] } } }] });
    expect((await policy.grants(identity, {}, [])).namespaces).toEqual(["bash"]);
    const selected = await policy.grants(identity, { traits: ["review"] }, []);
    expect(selected.namespaces).toContain("github");
    expect(selected.bound?.bash?.denyPrograms).toEqual(["git:push"]);
    expect((await policy.identityTraits(identity))[0]).toMatchObject({ name: "review", optional: true });
    expect((await policy.grants(identity, { bounds: ["no-push"] }, [])).bound?.bash?.denyPrograms).toEqual(["git:push"]);
  });
  it("keeps required restrictions when defaults and identity traits are disabled", async () => {
    const identity = row({ bounds: [{ safe: { description: "Safe", deniedTools: ["Write"] } }] });
    expect((await policy.grants(identity, { defaults: false, identityTraits: false }, [])).bound?.deniedTools).toEqual(["Write"]);
  });
  it("turns a base default off outside the base's inheritance chain", async () => {
    const identity = row({ traits: [{ bash: { optional: true } }] });
    expect((await policy.grants(identity, {}, [])).traits).toEqual([]);
    expect((await policy.grants(undefined, { bounds: ["readonly"] }, [])).bound?.deniedAccess).toEqual(["write"]);
  });
  it("refuses typos, bag-owned definitions and retired cached ids", async () => {
    await expect(policy.grants(undefined, { bounds: ["typo"] }, [])).rejects.toThrow("unknown selected bound typo");
    await expect(policy.grants(row({ traits: [{ bash: { description: "Override" } }] }), {}, [])).rejects.toThrow("owned by bag bash");
    await expect(policy.grants(row({ bound_id: 7 }), {}, [])).rejects.toMatchObject({ reason: "conflict", hint: "barry doctor --fix" });
  });
});

describe("direct per-session grants (POL-14)", () => {
  // A namespace carrying both a read and a write tool: a direct grant's access
  // level decides which survive.
  const candidates = [
    { namespace: "web", toolName: "fetch", access: "read" as const },
    { namespace: "web", toolName: "post", access: "write" as const },
  ];
  const policy = sessionPolicy({ identity: async () => undefined, config: resolveIdentityConfig, traits: async () => [], bounds: async () => [] });

  it("defaults a direct namespace grant to read, so a write tool is not admitted", async () => {
    const granted = await policy.grants(undefined, { defaults: false, namespaces: ["web"] }, candidates);
    // Read is the default (not readwrite): the read tool is reachable, the write tool is not.
    expect(granted.tools.map((tool) => tool.name).sort()).toEqual(["fetch"]);
  });

  it("records a direct namespace grant as a synthetic trait so session show reports it", async () => {
    const granted = await policy.grants(undefined, { defaults: false, namespaces: ["web"] }, candidates);
    expect(granted.traits).toContain("__direct_namespaces");
    expect(granted.namespaces).toContain("web");
  });

  it("records a direct tool grant as a synthetic trait, read by default", async () => {
    const granted = await policy.grants(undefined, { defaults: false, tools: ["fetch", "post"] }, candidates);
    expect(granted.traits).toContain("__direct_tools");
    // The read tool is granted; the write tool is held back by the default read access.
    expect(granted.tools.map((tool) => tool.name).sort()).toEqual(["fetch"]);
  });

  it("names no synthetic trait when nothing is granted directly", async () => {
    const granted = await policy.grants(undefined, { defaults: false }, candidates);
    expect(granted.traits).not.toContain("__direct_namespaces");
    expect(granted.traits).not.toContain("__direct_tools");
  });
});

describe("dropped default traits surface as warnings (POL-18)", () => {
  const trait = { name: "known", description: null, tools: [], namespaces: ["memory"], access: "read" as const, skills: [], instructions: [], bound: {}, boundNames: [], bag: "probe" };
  // A base that requires a default trait the catalog does not have: it resolves
  // to nothing and must be reported, not silently dropped.
  const base = resolveIdentityConfig({ id: 1, token: "base", actor_id: 1, name: "barry", created_at: "", last_used_at: null, metadata: {
    traits: ["known", "ghost"],
  } });
  const policy = sessionPolicy({ identity: async () => undefined, config: resolveIdentityConfig, traits: async () => [trait], bounds: async () => [], base: () => base });

  it("reports a base default that cannot be resolved, keeping the ones that can", async () => {
    const granted = await policy.grants(undefined, {}, []);
    expect(granted.traits).toContain("known");
    expect(granted.traits).not.toContain("ghost");
    expect(granted.warnings?.join(" ")).toMatch(/default trait ghost could not be resolved/);
  });

  it("omits warnings entirely when every default resolves", async () => {
    const clean = resolveIdentityConfig({ id: 1, token: "base", actor_id: 1, name: "barry", created_at: "", last_used_at: null, metadata: { traits: ["known"] } });
    const cleanPolicy = sessionPolicy({ identity: async () => undefined, config: resolveIdentityConfig, traits: async () => [trait], bounds: async () => [], base: () => clean });
    const granted = await cleanPolicy.grants(undefined, {}, []);
    expect(granted.warnings).toBeUndefined();
  });
});
