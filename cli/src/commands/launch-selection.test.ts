import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { adapterSettings, type IdentityAdapters } from "@barry-rocks/sdk/internal/identities";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { selectHarness, selectMode, resolveRecordedMode } from "./start.js";

const home = mkdtempSync(join(tmpdir(), "barry-selection-"));
let records: InstalledAdapter[];
beforeAll(async () => {
  const store = loadAdapters({ file: join(home, "adapters.json") });
  for (const folder of ["claude", "codex"]) await store.add(fileURLToPath(new URL(`../../../adapters/sessions/${folder}/`, import.meta.url)));
  records = store.installed();
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

it("records the launched identity mode on the selected codex harness", () => {
  const adapters: IdentityAdapters = { codex: { default: true, mode: "guest" }, "claude-code": { mode: "hosted" } };
  const record = selectHarness({}, adapters, records);
  const requested = adapterSettings(adapters, record)?.mode;
  expect(record.id).toBe("codex");
  expect(resolveRecordedMode(record, requested)).toBe(selectMode({}, { name: "coder", adapters }, record).mode);
  expect(resolveRecordedMode(record, "hosted")).toBe(selectMode({ mode: "hosted" }, { name: "coder", adapters }, record).mode);
});

it("keeps the stored claude spelling while selecting its canonical record", () => {
  const record = selectHarness({}, {}, records);
  expect(record.id).toBe("claude-code");
  expect(record.aliases?.[0] ?? record.id).toBe("claude");
});
