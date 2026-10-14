import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBuiltinRegistry } from "@barry-rocks/sdk/internal/bags";
// Each file owns a scratch instance. Consolidation must not share mutable stores
// or a snapshot between test workers or force overridden homes back to one path.
const home = mkdtempSync(join(tmpdir(), "barry-cli-test-"));
// Registered first so file teardown releases clients before their scratch instance is removed.
afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }));
process.env.BARRY_HOME = home;
for (const key of ["BARRY_CONFIG_DB", "BARRY_BAGS_SNAPSHOT"]) delete process.env[key];
for (const [key, filename] of Object.entries({ BARRY_IDENTITIES_DB: "identities.db", BARRY_SESSIONS_DB: "sessions.db", BARRY_ACTIONS_DB: "actions.db", BARRY_SCHEDULES_DB: "schedules.db" })) process.env[key] = join(home, filename);
mkdirSync(join(home, "app-support"), { recursive: true });
writeFileSync(join(home, "app-support", "bags.snapshot.json"), JSON.stringify({ bags: loadBuiltinRegistry() }));
writeFileSync(join(home, "app-support", "bag-resources.json"), JSON.stringify({ version: 2, generated: new Date().toISOString(), resources: { "mcp.server": { bag: "mcp", name: "server", kind: "service", url: "http://127.0.0.1:2" }, "sessions.api": { bag: "sessions", name: "api", kind: "service", url: "http://127.0.0.1:1" } } }));
