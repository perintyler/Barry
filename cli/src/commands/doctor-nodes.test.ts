import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { barryConfigDir, barryStoresDir } from "@barry-rocks/sdk/services";
import { familyDirectories, reportRetiredNodeState, retiredEnvOverrides } from "./doctor-nodes.js";

afterEach(() => { vi.restoreAllMocks(); });

it("finds and, with --fix, removes Family copies and node-era workflow overrides, keeping everything else in barry.yaml", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const family = join(barryStoresDir(), "node", "family", "sources");
  mkdirSync(family, { recursive: true });
  writeFileSync(join(family, "..", "aggregate.db"), "");
  const config = join(barryConfigDir(), "barry.yaml");
  mkdirSync(barryConfigDir(), { recursive: true });
  writeFileSync(config, "# keep this comment\nservices:\n  workflows.runtime:\n    env:\n      - BARRY_WORKFLOW_OWNERS=laptop\n      - BARRY_WORKFLOW_CAPACITY=2\n");
  expect(familyDirectories()).toEqual([join(barryStoresDir(), "node", "family")]);
  expect(retiredEnvOverrides(config)).toEqual([{ service: "workflows.runtime", entry: "BARRY_WORKFLOW_OWNERS=laptop" }]);
  await reportRetiredNodeState(false, config);
  expect(existsSync(join(barryStoresDir(), "node", "family"))).toBe(true);
  await reportRetiredNodeState(true, config);
  expect(existsSync(join(barryStoresDir(), "node", "family"))).toBe(false);
  expect(retiredEnvOverrides(config)).toEqual([]);
  const kept = readFileSync(config, "utf8");
  expect(kept).toContain("# keep this comment");
  expect(kept).toContain("BARRY_WORKFLOW_CAPACITY=2");
});
