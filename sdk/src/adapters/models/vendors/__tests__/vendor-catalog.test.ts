import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registeredVendorRows } from "../vendor-catalog.js";
import type { BagRegistry } from "../../../../bags/types.js";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "bag-catalog-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const vendor = (id: string) => ({ id, label: id, credential: null, models: [{ id: "model", label: "Model", kind: "completion" }] });
function catalog(name: string, vendors: unknown[]): BagRegistry {
  const path = join(directory, name);
  mkdirSync(path);
  writeFileSync(join(path, "bag.yaml"), JSON.stringify({ name, description: "Catalog only", vendors }));
  return { [name]: { type: "local", path } };
}

describe("installed bag catalogs", () => {
  it("reads only registered declarations and resolves compatibility across bags regardless of order", () => {
    const first = catalog("first", [{ ...vendor("first"), compatible: [{ with: "second", baseUrl: "https://second.test" }] }]);
    const second = catalog("second", [vendor("second")]);
    catalog("unregistered", [{ invalid: true }]);
    expect(registeredVendorRows({ ...first, ...second }).map((row) => row.id)).toEqual(["first", "second"]);
    expect(registeredVendorRows({ ...second, ...first }).map((row) => row.id)).toEqual(["second", "first"]);
    expect(() => registeredVendorRows(first)).toThrow(/which the catalog does not list/);
  });
  it("refuses duplicate vendor ownership across installed bags", () => {
    const first = catalog("first", [vendor("same")]);
    const second = catalog("second", [vendor("same")]);
    expect(() => registeredVendorRows({ ...first, ...second })).toThrow(/vendor "same" twice/);
  });
  it("keeps strict field validation and never silently drops malformed catalog YAML", () => {
    const registry = catalog("bad", [{ ...vendor("bad"), modles: [] }]);
    expect(() => registeredVendorRows(registry)).toThrow(/modles/);
    writeFileSync(join(directory, "bad/bag.yaml"), "name: bad\nvendors: [");
    expect(() => registeredVendorRows(registry)).toThrow();
  });
  it("honors disabled registrations before reading their files", () => {
    const registry = catalog("disabled", [{ invalid: true }]);
    const source = registry.disabled;
    expect(registeredVendorRows({ disabled: { ...source, disabled: true } })).toEqual([]);
  });
});
