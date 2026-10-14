import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sessionsDbPath } from "./sessions-db.js";

afterEach(() => vi.unstubAllEnvs());

it("keeps sessions in the sessions bag's own data directory", () => {
  const home = mkdtempSync(join(tmpdir(), "barry-sessions-path-"));
  vi.stubEnv("BARRY_SESSIONS_DB", undefined);
  vi.stubEnv("BARRY_HOME", home);
  expect(sessionsDbPath()).toBe(join(home, "app-support", "data", "sessions", "sessions.db"));
});
