import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
import { adapterStore, resetAdapterStore } from "./installed.js";

let home: string | undefined;
afterEach(() => {
  resetAdapterStore(); vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
});
it("keeps a fresh installation empty even though every harness is available in this checkout", async () => {
  home = mkdtempSync(join(tmpdir(), "barry-explicit-adapters-"));
  vi.stubEnv("BARRY_HOME", home); resetAdapterStore();
  const { adapters } = await adapterStore();
  expect(adapters.installed()).toEqual([]);
  expect(existsSync(barryAdaptersPath())).toBe(false);
  await expect(adapters.load("cursor")).rejects.toThrow("barry adapter add");
  expect(adapters.installed()).toEqual([]);
});

it("records only the explicitly added session package across store reloads", async () => {
  home = mkdtempSync(join(tmpdir(), "barry-selected-cursor-"));
  vi.stubEnv("BARRY_HOME", home); resetAdapterStore();
  const { adapters } = await adapterStore();
  const path = fileURLToPath(new URL("../../../adapters/sessions/cursor/", import.meta.url));
  vi.stubEnv("BARRY_CONFIG_ALLOW_EMPTY", "1");
  await adapters.add(path);
  expect(adapters.installed().map(record => record.id)).toEqual(["cursor"]);
  resetAdapterStore();
  const reopened = await adapterStore();
  expect(reopened.adapters.installed().map(record => record.id)).toEqual(["cursor"]);
  await expect(reopened.adapters.load("codex")).rejects.toThrow("barry adapter add");
});
