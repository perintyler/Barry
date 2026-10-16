import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { parse } from "yaml";
import { Barry } from "@barry-rocks/sdk";
import { identities, identityRecords, store } from "@barry-rocks/identities-bag";
import { barryAdaptersPath, barryBackupsDir, barryStoresDir } from "@barry-rocks/sdk/services";
import { closeSessionsDb } from "@barry-rocks/sessions-bag/store/sessions-db";
import { createIdentity, provisionOwner } from "../../test/helpers/identities.js";
import { migrateAdaptersRegistry, reportBoundProblems } from "./doctor-bounds.js";

beforeAll(() => {
  Barry.use(identities);
  provisionOwner();
  vi.stubEnv("BARRY_SESSIONS_DB", "");
});
afterAll(() => {
  closeSessionsDb();
  Barry.reset();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

it("copies custom DB bounds to default identity.yaml and converts legacy Bound shapes and inline bound: idempotently", async () => {
  const bux = await createIdentity({ name: "bux" });
  const bgoode = await createIdentity({ name: "bgoode", inherits: "bux" });
  const buxPath = join(bux.dir!, "identity.yaml");
  const bgoodePath = join(bgoode.dir!, "identity.yaml");
  writeFileSync(
    bgoodePath,
    [
      `id: ${bgoode.record.id}`,
      `name: bgoode`,
      `inherits: bux`,
      `bound: { files: { deny: [".env"], allowOnly: ["/workspace/**"] }, bash: { denyPrograms: ["sudo"] } }`,
      `bounds:`,
      `  - legacy-inline:`,
      `      description: "Legacy inline bound"`,
      `      deniedAccess: [write]`,
      `      nativeTools:`,
      `        claude: [Bash]`,
      `        default: [Edit]`,
      `      network:`,
      `        actions: [write]`,
      `        domains: ["evil.example"]`,
      `        allowDomains: ["api.github.com"]`,
      "",
    ].join("\n"),
  );
  const db = new Database(store.path());
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        bound TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}'
      );
    `);
    db.prepare("INSERT INTO bounds (name, description, bound, metadata) VALUES (?, ?, ?, ?)").run(
      "old-no-bash",
      "Custom DB bound blocking Bash",
      JSON.stringify({ deniedTools: ["Bash"] }),
      "{}",
    );
  } finally {
    db.close();
  }
  mkdirSync(barryStoresDir(), { recursive: true });
  writeFileSync(join(barryStoresDir(), "active.json"), JSON.stringify({ id: "bounds-test" }));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  await reportBoundProblems(false);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("writes restrictions inline"));
  expect(log).toHaveBeenCalledWith(expect.stringContaining("uses legacy bound keys in bounds:"));
  expect(log).toHaveBeenCalledWith(expect.stringContaining("Stored bound 'old-no-bash' in identities.db"));
  expect(parse(readFileSync(bgoodePath, "utf8"))).toHaveProperty("bound");
  expect(parse(readFileSync(buxPath, "utf8"))).not.toHaveProperty("bounds");

  await reportBoundProblems(true);

  const migratedBux = parse(readFileSync(buxPath, "utf8")) as Record<string, unknown>;
  expect(migratedBux.bounds).toEqual([
    {
      "old-no-bash": {
        description: "Custom DB bound blocking Bash",
        tools: { deny: ["*:Bash"] },
        optional: true,
      },
    },
  ]);

  const migratedBgoode = parse(readFileSync(bgoodePath, "utf8")) as Record<string, unknown>;
  expect(migratedBgoode).not.toHaveProperty("bound");
  expect(migratedBgoode.bounds).toEqual([
    {
      "legacy-inline": {
        description: "Legacy inline bound",
        tools: { deny: ["*:write", "claude-code:Bash", "*:Edit"] },
        network: {
          allow: ["api.github.com"],
          deny: ["write", "evil.example"],
        },
      },
    },
    {
      bgoode: {
        description: "bgoode's own restrictions, moved from bound:",
        files: { allow: ["/workspace/**"], deny: [".env"] },
        bash: { deny: ["sudo"] },
      },
    },
  ]);

  expect((await identityRecords.find("bgoode")).record.metadata.bounds).toBeDefined();

  expect(existsSync(barryBackupsDir())).toBe(true);
  const backupDirs = readdirSync(barryBackupsDir()).filter((d) => d.startsWith("pre-no-traits-"));
  expect(backupDirs.length).toBeGreaterThan(0);

  const beforeBux = readFileSync(buxPath, "utf8");
  const beforeBgoode = readFileSync(bgoodePath, "utf8");
  await reportBoundProblems(true);
  expect(readFileSync(buxPath, "utf8")).toBe(beforeBux);
  expect(readFileSync(bgoodePath, "utf8")).toBe(beforeBgoode);

  warning.mockRestore();
  log.mockRestore();
});

it("migrates legacy keys in adapters.json in write mode while leaving dry-run untouched", () => {
  const adaptersFile = barryAdaptersPath();
  mkdirSync(dirname(adaptersFile), { recursive: true });
  const legacyAdapters = [
    {
      name: "claude-code",
      nativeTools: ["Bash", "Edit"],
      vendorCode: {
        catalog: { anthropic: { models: ["claude-sonnet-4-6"] } },
      },
      modes: {
        interactive: {
          native: {
            grantable: ["Bash"],
          },
        },
      },
      bag: {
        manifest: {
          name: "claude-code",
          traits: { "claude-code:write": { description: "legacy" } },
          bounds: {
            "claude-code-readonly": {
              description: "Read-only Claude Code",
              bound: {
                deniedTools: ["Bash", "Edit"],
              },
            },
          },
        },
      },
    },
  ];
  writeFileSync(adaptersFile, `${JSON.stringify(legacyAdapters, null, 2)}\n`);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  migrateAdaptersRegistry(false);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining("Installed session adapter registry uses legacy keys"),
  );
  expect(JSON.parse(readFileSync(adaptersFile, "utf8"))).toEqual(legacyAdapters);

  migrateAdaptersRegistry(true);
  const migrated = JSON.parse(readFileSync(adaptersFile, "utf8")) as Record<string, unknown>[];
  expect(migrated).toEqual([
    {
      name: "claude-code",
      tools: ["Bash", "Edit"],
      vendorCode: {
        vendors: { anthropic: { models: ["claude-sonnet-4-6"] } },
      },
      modes: {
        interactive: {
          native: {
            controllable: ["Bash"],
          },
        },
      },
      bag: {
        manifest: {
          name: "claude-code",
          bounds: {
            "claude-code-readonly": {
              description: "Read-only Claude Code",
              tools: { deny: ["*:Bash", "*:Edit"] },
              bound: {
                tools: { deny: ["*:Bash", "*:Edit"] },
              },
            },
          },
        },
      },
    },
  ]);

  log.mockClear();
  migrateAdaptersRegistry(false);
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
});


