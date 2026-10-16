import { describe, expect, it } from "vitest";
import { parseManifest } from "../bags/manifest.js";
import { parseBounds } from "../identities/entries.js";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { NativeControl } from "../adapters/harnesses/index.js";
import type { ModeId } from "../ids.js";
import type { Tool } from "../barry/types.js";
import type { Bound } from "./types.js";
import {
  NATIVE_CATEGORIES,
  nativeToolsTakenBack,
  resolveNativeTools,
  validateNativeTools,
} from "./native-tools.js";
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
  [{ bash: { allow: ["npm:*"] } }, ["shell"]],
  [{ network: { deny: ["all"] } }, ["shell", "network"]],
  [{ network: { deny: ["example.com"] } }, ["shell", "network"]],
  [{ network: { allow: [] } }, ["shell", "network"]],
  [{ network: { enforce: "sandbox" } }, ["shell", "network"]],
  [{ files: { deny: [] } }, ["shell", "file-reads", "file-writes"]],
  [{ files: { allow: [] } }, ["shell", "file-reads", "file-writes"]],
  [{ inputs: { "slack:send_slack_message": { channel: { allow: ["@me"] } } } }, ["shell"]],
  [{ tools: { deny: ["*:write"] } }, ["shell", "file-writes"]],
  [{ tools: { allow: ["*:read"] } }, ["shell", "file-writes"]],
  [{ tools: { deny: ["*:bAsH"] } }, ["shell"]],
  [{ tools: { deny: ["*:Bash"] } }, ["shell"]],
  [{ tools: { deny: ["*:rEaD"] } }, ["file-reads"]],
  [{ tools: { deny: ["*:Glob", "*:Grep"] } }, ["file-reads"]],
  [{ tools: { deny: ["*:Write", "*:Edit"] } }, ["file-writes"]],
  [{ tools: { deny: ["*:WebFetch", "*:WebSearch"] } }, ["network"]],
];

describe.each(rows)("%s native tools", (folder, id, inventory, modes) => {
  const manifest = parseManifest(new URL(`../../../adapters/sessions/${folder}`, import.meta.url).pathname)!;
  const harness = { id, tools: inventory, bag: { manifest }, modes, defaultMode: "hosted" as const };
  const tools: Tool[] = inventory.map(name => ({ name, namespace: id, bag: null, access: "read" }));
  const category = (name: string) =>
    (manifest.bounds![`${folder}:no-${name}`].bound.tools?.deny ?? [])
      .filter(p => p.startsWith(`${id}:`))
      .map(p => p.slice(id.length + 1));
  it("validates the inventory and keeps only bounds", () => {
    expect(() => validateNativeTools(manifest, harness)).not.toThrow();
    expect(manifest).not.toHaveProperty("nativePolicy");
    expect(manifest.tools).toEqual([]);
    expect(manifest.mcpServers).toEqual({});
    expect(Object.keys(manifest.bounds!).some(name => /:(legacy-|guard-network|baseline|no-native-tools)/.test(name))).toBe(false);
    for (const name of NATIVE_CATEGORIES) expect(manifest.bounds).toHaveProperty(`${folder}:no-${name}`);
    for (const name of NATIVE_CATEGORIES) {
      for (const tool of category(name)) {
        expect(inventory).toContain(tool);
      }
    }
    expect(() => validateNativeTools({ ...manifest, bounds: { bad: { description: "bad", bound: { tools: { deny: [`${id}:not-a-tool`] } } } } }, harness)).toThrow();
  });
  for (const mode of Object.keys(modes) as (keyof typeof modes)[]) {
    it(`${mode} denies the inventory with no grant and with the workflow ceiling`, () => {
      expect(resolveNativeTools({ bound: null, tools: [] }, harness, mode).denied).toEqual(inventory);
      expect(resolveNativeTools({ bound: { tools: { deny: inventory.map(t => `${id}:${t}`) } }, tools }, harness, mode).allowed).toEqual([]);
    });
    it(`${mode} applies category restrictions before grants`, () => {
      for (const [bound, categories] of restrictions) {
        const taken = categories.flatMap(category);
        const ruling = resolveNativeTools({ bound, tools }, harness, mode);
        expect(ruling.allowed.filter(tool => taken.includes(tool))).toEqual([]);
        expect(nativeToolsTakenBack(bound, harness)).toEqual(inventory.filter(tool => taken.includes(tool)));
        expect(nativeToolsTakenBack(bound, { ...harness, bag: undefined })).toEqual(inventory);
      }
      for (const definition of [...Object.values(rootBounds), ...Object.values(bash.bounds!), ...Object.values(manifest.bounds!)]) {
        const taken = nativeToolsTakenBack(definition.bound, harness);
        expect(resolveNativeTools({ bound: definition.bound, tools }, harness, mode).allowed.filter(tool => taken.includes(tool))).toEqual([]);
      }
      expect(nativeToolsTakenBack({ tools: { deny: [`*:${inventory[0].toUpperCase()}`] } }, harness)).toContain(inventory[0]);
    });
    it(`${mode} grants each category or reports its refusal`, () => {
      const native = modes[mode]!.native;
      for (const group of native.inseparable ?? []) {
        const partial = tools.filter(tool => tool.name === group[0]);
        expect(resolveNativeTools({ bound: null, tools: partial }, harness, mode).allowed).toEqual([]);
        expect(resolveNativeTools({ bound: null, tools: tools.filter(tool => group.includes(tool.name)) }, harness, mode).allowed).toEqual(inventory.filter(tool => group.includes(tool)));
      }
      for (const tool of Object.keys(native.uncontrolled ?? {})) {
        expect(resolveNativeTools({ bound: { tools: { deny: [`${id}:${tool}`] } }, tools }, harness, mode).conflicts).toHaveProperty(tool);
      }
    });
  }
});

it("retains native Bash, Read, Write, and Edit on an unrestricted session (bounds: [])", () => {
  const manifest = parseManifest(new URL("../../../adapters/sessions/claude", import.meta.url).pathname)!;
  const harness = {
    id: "claude-code",
    tools: CLAUDE,
    bag: { manifest },
    modes: { hosted: { native: CLAUDE_NATIVE } },
    defaultMode: "hosted" as const,
  };
  const tools: Tool[] = CLAUDE.map((name) => ({
    name,
    namespace: "claude-code",
    bag: null,
    access: ["Write", "Edit", "Bash"].includes(name) ? "write" : "read",
  }));
  expect(nativeToolsTakenBack(null, harness)).toEqual([]);
  expect(nativeToolsTakenBack({}, harness)).toEqual([]);
  const resolved = resolveNativeTools({ bound: {}, tools }, harness, "hosted");
  expect(resolved.allowed).toEqual(expect.arrayContaining(["Bash", "Read", "Write", "Edit"]));
});

it("does not mistake automatically listed uncontrolled tools for requested grants", () => {
  const harness = { id: "fixture", tools: ["Read"], modes: { hosted: { native: { controllable: [], uncontrolled: { Read: "No permission request" } } } } };
  const tools: Tool[] = [{ name: "Read", namespace: "fixture", bag: null, access: "read", uncontrolled: "No permission request" }];
  expect(resolveNativeTools({ bound: null, tools }, harness, "hosted").refused).toEqual({});
  expect(resolveNativeTools({ bound: { tools: { deny: ["fixture:Read"] } }, tools }, harness, "hosted").conflicts).toEqual({ Read: "No permission request" });
});
