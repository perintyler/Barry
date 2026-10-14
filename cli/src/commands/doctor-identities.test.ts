import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { Barry } from "@barry-rocks/sdk";
import { identities, identityRecords } from "@barry-rocks/identities-bag";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
import { fileURLToPath } from "node:url";
import { createIdentity, provisionOwner, seedIdentityRow } from "../../test/helpers/identities.js";
import { resetAdapterStore } from "../adapters/installed.js";
import { reportIdentityProblems } from "./doctor-identities.js";
let actorId: number;
beforeAll(async () => {
  Barry.use(identities);
  actorId = provisionOwner();
  writeFileSync(join(process.env.BARRY_HOME!, "app-support", "bags.snapshot.json"), JSON.stringify({ bags: { unused: { type: "remote", url: "https://example.test/mcp" } } }));
  const store = loadAdapters({ file: barryAdaptersPath() });
  await store.add(fileURLToPath(new URL("../../../adapters/sessions/claude/", import.meta.url)));
  resetAdapterStore();
});
afterAll(() => { Barry.reset(); resetAdapterStore(); process.exitCode = 0; });
async function seed(name: string, fields: Record<string, unknown>) {
  const created = await createIdentity({ name });
  const path = join(created.dir!, "identity.yaml");
  writeFileSync(path, stringify({ name, ...fields }));
  return path;
}
it("migrates bux before bgoode, warns, and changes nothing on a second fix", async () => {
  const bux = await seed("bux", { default_coding_agent: "claude", default_model: "claude-opus-5", allow_native_tools: true });
  const bgoode = await seed("bgoode", { inherits: "bux", default_coding_agent: "claude" });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await reportIdentityProblems(false);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("uses retired keys"));
  expect(readFileSync(bux, "utf8")).toContain("default_model");
  await reportIdentityProblems(true);
  expect(parse(readFileSync(bux, "utf8"))).toEqual({ id: expect.any(Number), name: "bux", adapters: { "claude-code": { default: true, model: "claude-opus-5" } } });
  expect(parse(readFileSync(bgoode, "utf8"))).toEqual({ id: expect.any(Number), name: "bgoode", inherits: "bux" });
  expect((await identityRecords.find("bgoode")).record.metadata.adapters).toEqual((await identityRecords.find("bux")).record.metadata.adapters);
  const before = [readFileSync(bux, "utf8"), readFileSync(bgoode, "utf8")];
  await reportIdentityProblems(true);
  expect([readFileSync(bux, "utf8"), readFileSync(bgoode, "utf8")]).toEqual(before);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("had no effect"));
  warning.mockRestore(); log.mockRestore();
});
it("preserves an existing adapters block and leaves conversion problems untouched", async () => {
  const valid = await seed("already", { adapters: { "claude-code": { model: "kept" } }, default_model_provider: "ollama" });
  const invalid = await seed("problem", { default_model_provider: "ollama" });
  const before = readFileSync(invalid, "utf8");
  await reportIdentityProblems(true);
  expect(parse(readFileSync(valid, "utf8"))).toEqual({ id: expect.any(Number), name: "already", adapters: { "claude-code": { default: true, model: "kept" } } });
  expect(readFileSync(invalid, "utf8")).toBe(before);
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
});
it("reports numeric row names without renaming them", async () => {
  const row = seedIdentityRow({ actorId, name: "007" });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await reportIdentityProblems(true);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("'007' is digits only and shadows row id 7"));
  expect((await identityRecords.row(row.id))?.name).toBe("007");
  expect(process.exitCode).toBe(1);
  log.mockRestore();
  process.exitCode = 0;
});
