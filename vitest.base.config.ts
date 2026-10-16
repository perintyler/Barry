import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Package configs extend these shared defaults through spreading or mergeConfig.
 * Import the tracked vitest.base.config.ts relative to the package directory.
 * See docs/decisions/0046-instance-service-and-event-comments.md.
 */
/**
 * A scratch instance home with a registry in it, so code that looks a core
 * service up finds one. The ports are ones nothing listens on: a test that
 * reaches for the API or the engine without standing up its own gets a fast
 * connection refused, never this machine's real services. A test that needs a
 * working address writes its own registry into its own BARRY_HOME.
 */
function scratchInstanceHome(): string {
  const home = mkdtempSync(join(tmpdir(), "barry-vitest-home-"));
  const entry = (bag: string, name: string, port: number) => ({ bag, name, kind: "service", url: `http://127.0.0.1:${port}` });
  mkdirSync(join(home, "app-support"), { recursive: true });
  writeFileSync(
    join(home, "app-support", "bag-resources.json"),
    JSON.stringify({
      version: 2,
      generated: new Date().toISOString(),
      resources: {
        "sessions.api": entry("sessions", "api", 1),
        "mcp.server": entry("mcp", "server", 2),
      },
    }),
  );
  return home;
}

const INSTANCE_HOME = scratchInstanceHome();

export default defineConfig({
  test: {
    maxWorkers: 4,
    testTimeout: 120000,
    hookTimeout: 120000,
    include: ["src/**/*.test.ts"],
    // Test files share worker processes, so a file that points BARRY_HOME
    // somewhere else and does not put it back would hand the next file an
    // instance with no registry. This puts every file back in the scratch one.
    setupFiles: [fileURLToPath(new URL("./vitest.instance-home.setup.ts", import.meta.url))],
    env: {
      LOG_LEVEL: "silent",
      // macOS shells warn for inherited C.UTF-8 and contaminate captured stderr.
      LC_ALL: "C",
      // Memory-only events prevent tests from writing the owner store.
      BARRY_EVENTS_DB: ":memory:",
      // Disposable file stores allow multiple handles to share the test schema.
      // See docs/decisions/0002-test-store-isolation.md.
      BARRY_IDENTITIES_DB: join(
        mkdtempSync(join(tmpdir(), "barry-vitest-identities-")),
        "identities.db",
      ),
      // Reopened session handles must share a disposable file, never the owner store.
      BARRY_SESSIONS_DB: join(
        mkdtempSync(join(tmpdir(), "barry-vitest-sessions-")),
        "sessions.db",
      ),
      // Pin identity directories, config and registry snapshots together.
      // See docs/decisions/0038-test-isolation-and-command-reservations.md.
      BARRY_HOME: INSTANCE_HOME,
      BARRY_TEST_INSTANCE_HOME: INSTANCE_HOME,
      BARRY_CONFIG_DB: join(mkdtempSync(join(tmpdir(), "barry-vitest-config-")), "config.db"),
      BARRY_BAGS_SNAPSHOT: join(mkdtempSync(join(tmpdir(), "barry-vitest-snapshot-")), "bags.snapshot.json"),
      // Pin unattended action and schedule writes to disposable stores.
      // See docs/decisions/0038-test-isolation-and-command-reservations.md.
      BARRY_ACTIONS_DB: join(mkdtempSync(join(tmpdir(), "barry-vitest-actions-")), "actions.db"),
      BARRY_SCHEDULES_DB: join(mkdtempSync(join(tmpdir(), "barry-vitest-schedules-")), "schedules.db"),
    },
  },
});
