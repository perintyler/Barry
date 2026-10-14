import { expect, it } from "vitest";
import { resolveHarnessNames } from "../index.js";
const traits = new Set(["direct", "claude:native-network", "pi:native-shell"]);
it("resolves explicit and bare names against the running bag", () => {
  expect(resolveHarnessNames(["direct", "native-shell", "native-shell"], traits, { bag: "pi", bags: ["pi", "claude"] }, "trait")).toEqual({ names: ["direct", "pi:native-shell"], ungranted: [] });
  expect(resolveHarnessNames(["native-network"], traits, { bag: "pi", bags: ["pi", "claude"] }, "trait")).toEqual({ names: [], ungranted: ["native-network"] });
  expect(resolveHarnessNames(["claude:native-network"], traits, { bags: [] }, "trait").names).toEqual(["claude:native-network"]);
});
it("still refuses unknown names", () => {
  expect(() => resolveHarnessNames(["typo"], traits, { bag: "pi", bags: ["claude"] }, "trait")).toThrow(/unknown selected trait/);
});

it("uses the same name convention for bounds", () => {
  expect(resolveHarnessNames(["native-shell"], traits, { bag: "pi", bags: [] }, "bound").names).toEqual(["pi:native-shell"]);
  expect(() => resolveHarnessNames(["typo"], traits, { bags: [] }, "bound")).toThrow("unknown selected bound typo");
});
