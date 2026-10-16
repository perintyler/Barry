import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => {
  const declared = { id: "fixture", label: "Fixture", credential: null, models: [{ id: "one", label: "One", kind: "completion" }] };
  const loadCode = vi.fn(async () => { throw new Error("factory must stay unloaded"); });
  const selectedFactories = vi.fn(async () => { throw new Error("provider must stay unloaded"); });
  return { declared, loadCode, selectedFactories };
});
vi.mock("./harness-flags.js", () => ({ installedAdapterStore: async () => ({ installed: () => [{ vendorCode: { vendors: [fixture.declared] } }], loadVendorCode: fixture.loadCode }) }));
vi.mock("./shipped-vendors.js", () => ({ shippedVendorRows: async () => [], selectedVendorFactories: fixture.selectedFactories }));
import { modelVendorsForRouting } from "./models-install.js";
it("reads routing declarations without loading adapter or provider execution factories", async () => {
  expect(await modelVendorsForRouting()).toEqual([fixture.declared]);
  expect(fixture.loadCode).not.toHaveBeenCalled();
  expect(fixture.selectedFactories).not.toHaveBeenCalled();
});
