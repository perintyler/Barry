import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Service management prepares the bag registry and snapshot before starting
 * anything, and `barry setup` runs the same step. Shipped global bounds and bag
 * bounds resolve directly from root `identity.yaml` and the bag registry snapshot.
 */
const home = mkdtempSync(join(tmpdir(), "barry-fresh-registry-"));
process.env.BARRY_HOME = home;
delete process.env.BARRY_CONFIG_DB;
delete process.env.BARRY_BAGS_SNAPSHOT;

const { prepareBagRegistry } = await import("../src/services/barry.js");
const { bounds } = await import("@barry-rocks/identities-bag");
const { discoverBuiltinBags } = await import("@barry-rocks/sdk/internal/bags");
const { closeConfigDb } = await import("../src/services/configuration/database.js");
const { getBag, upsertBag } = await import("../src/bags/registration.js");

const shipped = discoverBuiltinBags();

afterAll(() => {
  closeConfigDb();
  rmSync(home, { recursive: true, force: true });
});

describe("preparing a fresh instance's registry", () => {
  it("offers every bound the base identity ships without database seeding", async () => {
    expect(bounds.shipped().map(bound => bound.name!).length, "the checkout ships bounds").toBeGreaterThan(0);

    await prepareBagRegistry();

    for (const name of bounds.shipped().map(bound => bound.name!)) {
      expect(await bounds.get({ name }), name).toBeDefined();
    }
  });

  it("re-anchors a builtin whose folder moved, removes retired builtins, and leaves a user row of the same name alone", async () => {
    await upsertBag("session-vector-search", { type: "local", path: join("sessions", "sessions-search") }, { builtin: true });
    await upsertBag("sessions/search", { type: "local", path: join("sessions", "extensions", "search") }, { builtin: true });
    await upsertBag("memory", { type: "local", path: "/elsewhere/memory" });

    await prepareBagRegistry();

    expect((await getBag("session-vector-search"))?.source).toMatchObject({ path: shipped.local["session-vector-search"] });
    expect(await getBag("sessions/search")).toBeNull();
    expect((await getBag("memory"))?.source).toMatchObject({ path: "/elsewhere/memory" });
  });
});
