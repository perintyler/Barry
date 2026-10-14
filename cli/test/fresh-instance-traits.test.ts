import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * A fresh instance got the shipped bags and none of the shipped bounds:
 * `barry start --read` named a bound that did not exist until someone ran
 * `pnpm --dir sdk seed:bags` by hand. The service management prepares the
 * registry before it starts anything, and `barry setup` runs the same step.
 */
const home = mkdtempSync(join(tmpdir(), "barry-fresh-traits-"));
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
  it("offers every bound the base identity ships without seeding", async () => {
    expect(bounds.shipped().map(bound => bound.name!).length, "the checkout ships bounds").toBeGreaterThan(0);

    await prepareBagRegistry();

    for (const name of bounds.shipped().map(bound => bound.name!)) expect(await bounds.get({ name }), name).toBeDefined();
  });

  it("keeps a bound the machine tuned", async () => {
    await bounds.upsert({ name: "readonly", description: "local", bound: { deniedTools: ["Bash"] } });

    await prepareBagRegistry();

    expect(await bounds.get({ name: "readonly" })).toMatchObject({ deniedAccess: ["write"] });
    expect((await bounds.stored()).find(row => row.name === "readonly")?.bound).toEqual({ deniedTools: ["Bash"] });
  });

  it("re-anchors a builtin whose folder moved, and leaves a user row of the same name alone", async () => {
    // sessions/search moved from sessions/sessions-search to
    // sessions/extensions/search; an existing instance's row named the old one.
    await upsertBag("sessions/search", { type: "local", path: join("sessions", "sessions-search") }, { builtin: true });
    await upsertBag("memory", { type: "local", path: "/elsewhere/memory" });

    await prepareBagRegistry();

    expect((await getBag("sessions/search"))?.source).toMatchObject({ path: shipped.local["sessions/search"] });
    expect((await getBag("memory"))?.source).toMatchObject({ path: "/elsewhere/memory" });
  });
});
