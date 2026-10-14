import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getDbPath } from "./db.js";

afterEach(() => vi.unstubAllEnvs());

it("keeps events in the events bag's own data directory", () => {
  const home = mkdtempSync(join(tmpdir(), "barry-events-path-"));
  vi.stubEnv("BARRY_EVENTS_DB", undefined);
  vi.stubEnv("BARRY_HOME", home);
  expect(getDbPath()).toBe(join(home, "app-support", "data", "events", "events.db"));
});
