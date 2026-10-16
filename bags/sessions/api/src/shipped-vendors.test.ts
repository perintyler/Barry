import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { barryModelVendorsPath } from "@barry-rocks/sdk/services";
import { selectedVendorFactories, shippedVendorRows } from "./shipped-vendors.js";

describe("shipped-vendors", () => {
  const homes: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("returns registered vendor rows", async () => {
    const rows = await shippedVendorRows();
    expect(Array.isArray(rows)).toBe(true);
  });

  it("names a selected provider that cannot load, so boot can log it", async () => {
    const home = mkdtempSync(join(tmpdir(), "barry-sessions-providers-"));
    homes.push(home);
    vi.stubEnv("BARRY_HOME", home);
    const file = barryModelVendorsPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify([{ packageName: "@example/missing-provider", path: join(home, "missing-provider"), version: "1.0.0", contractVersion: 1, factoryExport: "factories" }]));

    const { refused } = await selectedVendorFactories();
    expect([...refused.keys()]).toEqual(["@example/missing-provider"]);
    expect(refused.get("@example/missing-provider")?.[0]).toContain("is unavailable");
  });
});
