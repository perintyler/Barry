import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifestObject } from "@barry-rocks/sdk/bags";
import type { Bag } from "@barry-rocks/sdk/bags";
import { buildServiceSpecs } from "./specs.js";

/** Service preparation from a bag's declared launch forms. Split from launch.test.ts, which covers the launch contract itself. */
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "launch contract ")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const base = { name: "demo", description: "demo" };
it("prepares an entry service and preserves explicit native command arguments", () => {
  const manifest = parseManifestObject({ ...base, services: { api: { description: "api", entry: "service.mjs" }, native: { description: "native", command: "/usr/bin/env", args: ["node", "--version"] } } });
  const bag = { name: "demo", services: Object.entries(manifest.services).map(([name, service]) => ({ name, ...service })) } as Bag;
  const result = buildServiceSpecs([bag], { demo: { type: "local", path: directory } });
  expect(result.problems).toEqual([]);
  expect(result.specs[0].args).toEqual([join(directory, "service.mjs")]);
  expect(result.specs[1]).toMatchObject({ command: "/usr/bin/env", args: ["node", "--version"] });
});

it("reports a bad service entry while retaining independently valid services", () => {
  const bag = { name: "demo", services: [
    { name: "bad", description: "bad", entry: "../outside.ts", command: "node" },
    { name: "native", description: "native", command: "/usr/bin/env", args: ["node", "--version"] },
  ] } as Bag;
  const result = buildServiceSpecs([bag], { demo: { type: "local", path: directory } });
  expect(result.problems).toHaveLength(1);
  expect(result.problems[0].key).toBe("demo.bad");
  expect(result.specs.map(spec => spec.key)).toEqual(["demo.native"]);
});
