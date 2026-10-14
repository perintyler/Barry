import { describe, expect, it } from "vitest";
import { Traits } from "./index.js";
import { parseManifestObject } from "../bags/manifest.js";
import {
  resolveExecutionContext,
  assertToolAllowed,
} from "../bounds/execution-context.js";
import { mergeBounds } from "../bounds/merge-bounds.js";
import type { Bound, AgentTrait, ToolMeta } from "../bounds/types.js";

const tools: ToolMeta[] = [
  { namespace: "documents", toolName: "read", access: "read" },
  { namespace: "documents", toolName: "write", access: "write" },
  { namespace: "issues", toolName: "list", access: "read" },
  { namespace: "issues", toolName: "close", access: "write" },
  { namespace: "default", toolName: "inspect", access: "read" },
  { namespace: "unselected", toolName: "read", access: "read" },
];
const catalog: Record<string, AgentTrait> = {
  default: { name: "default", namespaces: ["default"], access: "read" },
  reader: { name: "reader", namespaces: ["documents"], access: "read" },
  editor: {
    name: "editor",
    namespaces: ["documents"],
    access: "readwrite",
    includes: ["reader"],
  },
  reviewer: {
    name: "reviewer",
    namespaces: ["issues"],
    access: "read",
    includes: ["reader"],
    boundNames: ["readonly"],
  },
  workspace: {
    name: "workspace",
    namespaces: ["documents", "issues"],
    access: "readwrite",
  },
};
const named: Record<string, Bound> = {
  readonly: { deniedAccess: ["write"] },
};
const boundByName = async (name: string) => named[name];

describe("identity, bag, trait and bound composition", () => {
  it("evaluates the documented scenario and prevents denied handlers from running", async () => {
    const bag = parseManifestObject({
      name: "workspace",
      description: "Fixture workspace",
      bags: ["documents", "issues"],
    });
    const selected = Traits.select({
      defaults: ["default"],
      identity: { bags: [bag.name], traits: ["editor"] },
      session: ["reviewer"],
    });
    expect(selected).toEqual(["default", "editor", "reviewer"]);
    const grants = Traits.grants(selected, catalog);
    expect(grants.byNamespace.get("documents")).toBe("readwrite");
    expect(grants.byNamespace.get("issues")).toBe("read");
    const context = await resolveExecutionContext({
      identity: "bonanza",
      traitNames: selected,
      traits: catalog,
      tools,
      boundByName,
      bounds: [{ deniedTools: ["list"] }],
    });
    expect(context.traits.filter((name) => name === "reader")).toHaveLength(1);
    expect(context.allowedToolIds.sort()).toEqual([
      "default:inspect",
      "documents:read",
    ]);
    let effects = 0;
    const invoke = (namespace: string, toolName: string) => {
      assertToolAllowed(context, { namespace, toolName }, "local");
      effects++;
    };
    invoke("documents", "read");
    for (const [namespace, toolName] of [
      ["documents", "write"],
      ["issues", "list"],
      ["issues", "close"],
      ["unselected", "read"],
    ]) {
      expect(() => invoke(namespace, toolName)).toThrow("tool access denied");
    }
    expect(effects).toBe(1);
  });

  it("distinguishes packed bags from grants and honors explicit identity bag grants", async () => {
    const identity = { bags: ["workspace"] };
    expect(Traits.select({ identity })).toEqual([]);
    const context = await resolveExecutionContext({
      traitNames: Traits.select({
        identity: { ...identity, bag_grant: "identity" },
      }),
      traits: catalog,
      tools,
      boundByName,
    });
    expect(context.allowedToolIds.sort()).toEqual([
      "documents:read",
      "documents:write",
      "issues:close",
      "issues:list",
    ]);
  });

  it("uses one harness branch for grants and bounds", async () => {
    const traits = {
      ...catalog,
      policy: {
        name: "policy",
        namespaces: [],
        access: "read" as const,
        harnessTraits: { fake: "editor" },
      },
    };
    const context = await resolveExecutionContext({
      traitNames: ["policy"],
      harness: "fake",
      traits,
      tools,
      boundByName,
      bounds: [named.readonly],
    });
    expect(context.allowedToolIds).toEqual(["documents:read"]);
    await expect(
      resolveExecutionContext({
        traitNames: ["policy"],
        harness: "missing",
        traits,
        tools,
        boundByName,
      }),
    ).rejects.toThrow("no policy");
    await expect(
      resolveExecutionContext({
        traitNames: ["policy"],
        traits,
        tools,
        boundByName,
      }),
    ).rejects.toThrow("requires the running harness");
  });

  it("fails closed for missing selections, references and cycles", async () => {
    const resolve = (
      traits: Record<string, AgentTrait>,
      traitNames: string[],
    ) => resolveExecutionContext({ traits, traitNames, tools, boundByName });
    await expect(resolve(catalog, ["missing"])).rejects.toThrow(
      "unknown selected trait",
    );
    await expect(
      resolve(
        {
          a: {
            name: "a",
            namespaces: [],
            access: "read",
            includes: ["missing"],
          },
        },
        ["a"],
      ),
    ).rejects.toThrow("unknown included trait");
    await expect(
      resolve(
        {
          a: {
            name: "a",
            namespaces: [],
            access: "read",
            boundNames: ["missing"],
          },
        },
        ["a"],
      ),
    ).rejects.toThrow("unknown bound");
    await expect(
      resolve(
        { a: { name: "a", namespaces: [], access: "read", includes: ["a"] } },
        ["a"],
      ),
    ).rejects.toThrow("cycle");
    expect((await resolve(catalog, [])).allowedToolIds).toEqual([]);
  });

  it("does not mutate definitions and adding restrictions cannot add permitted tools", async () => {
    const before = JSON.stringify(catalog);
    const base = await resolveExecutionContext({
      traitNames: ["workspace"],
      traits: catalog,
      tools,
      boundByName,
    });
    for (const bounds of [
      [named.readonly],
      [named.readonly, { deniedTools: ["read"] }],
    ]) {
      const restricted = await resolveExecutionContext({
        traitNames: ["workspace"],
        traits: catalog,
        tools,
        boundByName,
        bounds,
      });
      expect(
        restricted.allowedToolIds.every((id) =>
          base.allowedToolIds.includes(id),
        ),
      ).toBe(true);
    }
    expect(JSON.stringify(catalog)).toBe(before);
    expect(
      mergeBounds(
        { network: { allowDomains: ["a.test"] } },
        { network: { allowDomains: [] } },
      )?.network?.allowDomains,
    ).toEqual([]);
  });
});
