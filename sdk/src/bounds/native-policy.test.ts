import { describe, expect, it } from "vitest";
import { parseManifest } from "../bags/manifest.js";
import { parseBounds } from "../identities/entries.js";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { NativeControl } from "../adapters/harnesses/index.js";
import type { ModeId } from "../ids.js";
import type { Tool } from "../barry/types.js";
import type { Bound } from "./types.js";
import { NATIVE_CATEGORIES, nativeToolsTakenBack, nativeToolStatus, resolveNativePolicy, validateNativeTools } from "./native-policy.js";
import { NATIVE_TOOLS as CLAUDE, NATIVE as CLAUDE_NATIVE } from "../../../adapters/sessions/claude/src/native-tools.js";
import { NATIVE_TOOLS as CODEX, NATIVE as CODEX_NATIVE } from "../../../adapters/sessions/codex/src/native-tools.js";
import { NATIVE_TOOLS as OPENCODE, NATIVE as OPENCODE_NATIVE } from "../../../adapters/sessions/opencode/src/native-tools.js";
import { NATIVE_TOOLS as PI, NATIVE as PI_NATIVE } from "../../../adapters/sessions/pi/src/native-tools.js";
import { NATIVE_TOOLS as CURSOR, HOSTED_NATIVE, TUI_NATIVE } from "../../../adapters/sessions/cursor/src/native-tools.js";
import { NATIVE_TOOLS as AGY, NATIVE as AGY_NATIVE } from "../../../adapters/sessions/antigravity/src/native-tools.js";

const rows: [string, string, readonly string[], Partial<Record<ModeId, { native: NativeControl }>>][] = [
  ["claude", "claude-code", CLAUDE, { hosted: { native: CLAUDE_NATIVE }, guest: { native: CLAUDE_NATIVE }, instrumented: { native: CLAUDE_NATIVE } }],
  ["codex", "codex", CODEX, { hosted: { native: CODEX_NATIVE }, guest: { native: CODEX_NATIVE }, instrumented: { native: CODEX_NATIVE } }],
  ["opencode", "opencode", OPENCODE, { hosted: { native: OPENCODE_NATIVE }, guest: { native: OPENCODE_NATIVE } }],
  ["pi", "pi", PI, { hosted: { native: PI_NATIVE } }],
  ["cursor", "cursor", CURSOR, { hosted: { native: HOSTED_NATIVE }, guest: { native: TUI_NATIVE }, instrumented: { native: TUI_NATIVE } }],
  ["antigravity", "antigravity", AGY, { hosted: { native: AGY_NATIVE }, guest: { native: AGY_NATIVE }, instrumented: { native: AGY_NATIVE } }],
];
const rootBounds = parseBounds(parse(readFileSync(new URL("../../../identity.yaml", import.meta.url), "utf8")).bounds).filter(entry => entry.bound);
const bash = parseManifest(new URL("../../../bags/bash", import.meta.url).pathname)!;
const restrictions: [Bound, readonly string[]][] = [
  [{ bash: { deny: ["git *"] } }, ["shell"]],
  [{ bash: { denyPrograms: ["git"] } }, ["shell"]],
  [{ network: { actions: ["all"] } }, ["shell", "network"]],
  [{ network: { domains: ["example.com"] } }, ["shell", "network"]],
  [{ network: { allowDomains: [] } }, ["shell", "network"]],
  [{ network: { enforce: "sandbox" } }, ["shell", "network"]],
  [{ files: { deny: [] } }, ["shell", "file-reads", "file-writes"]],
  [{ files: { allowOnly: [] } }, ["shell", "file-reads", "file-writes"]],
  [{ deniedAccess: ["write"] }, ["shell", "file-writes"]],
  [{ deniedTools: ["bAsH"] }, ["shell"]],
  [{ deniedTools: ["rEaD"] }, ["file-reads"]],
  [{ deniedTools: ["Glob", "Grep"] }, ["file-reads"]],
  [{ deniedTools: ["Write", "Edit"] }, ["file-writes"]],
  [{ deniedTools: ["filesystem"] }, ["file-reads", "file-writes"]],
  [{ deniedTools: ["WebFetch", "WebSearch"] }, ["network"]],
];

describe.each(rows)("%s native policy", (folder, id, inventory, modes) => {
  const manifest = parseManifest(new URL(`../../../adapters/sessions/${folder}`, import.meta.url).pathname)!;
  const harness = { id, nativeTools: inventory, bag: { manifest }, modes, defaultMode: "hosted" as const };
  const traits = Object.entries(manifest.traits).map(([name, trait]) => ({ ...trait, name, namespaces: trait.bags }));
  const tools: Tool[] = inventory.map(name => ({ name, namespace: id, bag: null, access: "read" }));
  const category = (name: string) => manifest.bounds![`${folder}:no-${name}`].bound.nativeTools![id];
  it("validates the inventory and keeps only granting traits", () => {
    expect(() => validateNativeTools(manifest, harness)).not.toThrow();
    expect(manifest).not.toHaveProperty("nativePolicy");
    expect(manifest.tools).toEqual([]);
    expect(manifest.mcpServers).toEqual({});
    expect(Object.keys(manifest.traits).some(name => name.startsWith(`${folder}:no-`))).toBe(false);
    expect(Object.keys(manifest.bounds!).some(name => /:(legacy-|guard-network|baseline|no-native-tools)/.test(name))).toBe(false);
    for (const name of NATIVE_CATEGORIES) expect(manifest.bounds).toHaveProperty(`${folder}:no-${name}`);
    for (const trait of traits) for (const tool of trait.nativeTools?.[id] ?? []) {
      expect(inventory).toContain(tool);
      expect(category(trait.name.split(":native-")[1])).toContain(tool);
      expect(Object.values(modes).some(mode => mode.native.grantable.includes(tool) || tool in (mode.native.uncontrolled ?? {}))).toBe(true);
    }
    expect(() => validateNativeTools({ ...manifest, traits: { bad: { ...manifest.traits[Object.keys(manifest.traits)[0]], nativeTools: { [id]: ["not-a-tool"] } } } }, harness)).toThrow();
  });
  for (const mode of Object.keys(modes) as (keyof typeof modes)[]) {
    it(`${mode} denies the inventory with no grant and with the workflow ceiling`, () => {
      expect(resolveNativePolicy({ bound: null, tools: [] }, harness, mode).denied).toEqual(inventory);
      expect(resolveNativePolicy({ bound: { deniedTools: [...inventory] }, tools }, harness, mode).allowed).toEqual([]);
    });
    it(`${mode} applies category restrictions before grants`, () => {
      for (const [bound, categories] of restrictions) {
        const taken = categories.flatMap(category);
        const policy = resolveNativePolicy({ bound, tools }, harness, mode);
        expect(policy.allowed.filter(tool => taken.includes(tool))).toEqual([]);
        expect(nativeToolsTakenBack(bound, harness)).toEqual(inventory.filter(tool => taken.includes(tool)));
        expect(nativeToolsTakenBack(bound, { ...harness, bag: undefined })).toEqual(inventory);
      }
      for (const definition of [...Object.values(rootBounds), ...Object.values(bash.bounds!), ...Object.values(manifest.bounds!)]) {
        const taken = nativeToolsTakenBack(definition.bound, harness);
        expect(resolveNativePolicy({ bound: definition.bound, tools }, harness, mode).allowed.filter(tool => taken.includes(tool))).toEqual([]);
      }
      expect(nativeToolsTakenBack({ deniedTools: [inventory[0].toUpperCase()] }, harness)).toContain(inventory[0]);
    });
    it(`${mode} grants each trait or reports its refusal`, () => {
      const native = modes[mode]!.native;
      for (const trait of traits) {
        const wanted = trait.nativeTools?.[id] ?? [];
        const expected = wanted.filter(tool => native.grantable.includes(tool));
        const status = nativeToolStatus([trait], null, harness, mode);
        expect(new Set(status.allowed)).toEqual(new Set(expected));
        expect(Object.keys(status.refused)).toEqual(inventory.filter(tool => wanted.includes(tool) && !expected.includes(tool)));
      }
      for (const group of native.inseparable ?? []) {
        const partial = tools.filter(tool => tool.name === group[0]);
        expect(resolveNativePolicy({ bound: null, tools: partial }, harness, mode).allowed).toEqual([]);
        expect(resolveNativePolicy({ bound: null, tools: tools.filter(tool => group.includes(tool.name)) }, harness, mode).allowed).toEqual(inventory.filter(tool => group.includes(tool)));
      }
      for (const tool of Object.keys(native.uncontrolled ?? {})) {
        expect(resolveNativePolicy({ bound: { nativeTools: { [id]: [tool] } }, tools }, harness, mode).conflicts).toHaveProperty(tool);
      }
    });
  }
});

it("does not mistake automatically listed uncontrolled tools for requested grants", () => {
  const harness = { id: "fixture", nativeTools: ["Read"], modes: { hosted: { native: { grantable: [], uncontrolled: { Read: "No permission request" } } } } };
  const tools: Tool[] = [{ name: "Read", namespace: "fixture", bag: null, access: "read", uncontrolled: "No permission request" }];
  expect(resolveNativePolicy({ bound: null, tools }, harness, "hosted").refused).toEqual({});
  expect(resolveNativePolicy({ bound: { nativeTools: { fixture: ["Read"] } }, tools }, harness, "hosted").conflicts).toEqual({ Read: "No permission request" });
});
