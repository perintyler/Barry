import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdentityRecord } from "./identities.js";

const fixture = vi.hoisted(() => ({ row: null as IdentityRecord | null, writes: vi.fn() }));
vi.mock("./identities.js", async original => ({
  ...await original<typeof import("./identities.js")>(),
  getIdentity: vi.fn(async () => fixture.row),
  getIdentityByName: vi.fn(async () => fixture.row),
  updateIdentityMetadataInRow: vi.fn(async (_id, value) => {
    fixture.writes();
    fixture.row!.metadata = { ...fixture.row!.metadata, ...value };
  }),
  setIdentityMetadataFieldInRow: vi.fn(async (_id, field) => { delete fixture.row!.metadata[field]; }),
}));
vi.mock("@barry-rocks/sdk/internal/bags", async original => ({
  ...await original<typeof import("@barry-rocks/sdk/internal/bags")>(), bagLoadInputs: () => [],
}));
import { syncIdentityToDbIfChanged } from "./identity-files.js";
let home: string;
let dir: string;
let base: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "identity-stamp-"));
  dir = join(home, "app-support", "identities", "fixture");
  base = join(home, "base");
  mkdirSync(dir, { recursive: true }); mkdirSync(join(base, "bags"), { recursive: true });
  vi.stubEnv("BARRY_HOME", home); vi.stubEnv("BARRY_BUILTIN_DIR", join(base, "bags"));
  writeFileSync(join(base, "identity.yaml"), "name: barry\n");
  writeFileSync(join(dir, "identity.yaml"), "name: fixture\nid: 7\n");
  fixture.row = { id: 7, token: "fixture", actor_id: 1, name: "fixture", metadata: {}, created_at: "", last_used_at: null };
  fixture.writes.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
it("skips YAML synchronization and writes until the leaf or base file changes", async () => {
  expect(await syncIdentityToDbIfChanged(dir, { actorId: 1, expectedId: 7 })).toEqual({ identityId: 7, synced: true });
  const writes = fixture.writes.mock.calls.length;
  expect(await syncIdentityToDbIfChanged(dir, { actorId: 1, expectedId: 7 })).toEqual({ identityId: 7, synced: false });
  expect(fixture.writes).toHaveBeenCalledTimes(writes);
  writeFileSync(join(base, "identity.yaml"), "name: barry\nbounds: [readonly]\n");
  expect((await syncIdentityToDbIfChanged(dir, { actorId: 1, expectedId: 7 })).synced).toBe(true);
  writeFileSync(join(dir, "identity.yaml"), "name: fixture\nid: 7\nbounds: [safe]\n");
  expect((await syncIdentityToDbIfChanged(dir, { actorId: 1, expectedId: 7 })).synced).toBe(true);
});
it("does not trust a cache row whose owner or file binding changed", async () => {
  await syncIdentityToDbIfChanged(dir, { actorId: 1, expectedId: 7 });
  fixture.row!.actor_id = 2;
  await expect(syncIdentityToDbIfChanged(dir, { actorId: 1, expectedId: 7 })).rejects.toThrow("another actor");
  fixture.row!.actor_id = 1;
  writeFileSync(join(dir, "identity.yaml"), "name: fixture\nid: 8\n");
  await expect(syncIdentityToDbIfChanged(dir, { actorId: 1, expectedId: 7 })).rejects.toThrow("no longer matches");
});
