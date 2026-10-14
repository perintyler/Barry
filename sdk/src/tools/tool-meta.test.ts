import { afterEach, expect, it } from "vitest";
import type { Bag, BagRegistrySnapshot } from "../bags/types.js";
import { collectToolMeta, clearToolMetaCache } from "./tool-meta.js";
afterEach(clearToolMetaCache);
it("retains same-named tools from different namespaces with their own access classification", async () => {
  const bag = (name: string, namespace: string, access: "read" | "readwrite"): Bag => ({
    name, description: "", builtin: false, source: { type: "remote", url: "https://example.invalid/mcp" }, manifest: null,
    skillsDirs: [], actionsDirs: [], instructionsDirs: [], traits: [], mcpServers: {}, tools: [{ toolName: "status", namespace, access }],
    dependencies: [], slashCommands: [], hooks: [], requires: [], services: [], apps: [], schedules: [],
  });
  const bags = [bag("reader", "documents", "read"), bag("writer", "deployment", "readwrite")];
  const snapshot: BagRegistrySnapshot = { registry: {}, bags, byName: new Map(bags.map(bag => [bag.name, bag])) };
  expect(await collectToolMeta(snapshot)).toEqual([
    { toolName: "status", namespace: "documents", access: "read", bag: "reader" },
    { toolName: "status", namespace: "deployment", access: "write", bag: "writer" },
  ]);
  expect(await collectToolMeta({ ...snapshot, bags: [bags[1]] })).toEqual([{ toolName: "status", namespace: "deployment", access: "write", bag: "writer" }]);
});

it("reads contract hashes from the bag's summarized tools, importing no bag code", async () => {
  // A local bag whose tool code does not exist: importing it would throw.
  const bag: Bag = {
    name: "summarized", description: "", builtin: false, source: { type: "local", path: "/nonexistent/summarized" },
    manifest: null, skillsDirs: [], actionsDirs: [], instructionsDirs: [], traits: [], mcpServers: {},
    tools: [{ toolName: "read", namespace: "documents", access: "read", contractHash: "a".repeat(64) }],
    dependencies: [], slashCommands: [], hooks: [], requires: [], services: [], apps: [], schedules: [],
  };
  const snapshot: BagRegistrySnapshot = { registry: {}, bags: [bag], byName: new Map([[bag.name, bag]]) };
  expect(await collectToolMeta(snapshot)).toEqual([
    { toolName: "read", namespace: "documents", access: "read", bag: "summarized", contractHash: "a".repeat(64) },
  ]);
});
