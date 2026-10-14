import { expect, it } from "vitest";
import { resolveSessionPolicy } from "./policy.js";
it("refuses an unresolved explicit restriction instead of silently launching without it", async () => {
  for (const source of [
    { identity: { traits: ["missing-restriction"] } },
    { session: ["missing-restriction"] },
  ]) {
    await expect(
      resolveSessionPolicy({
        ...source,
        traits: {},
        boundByName: async () => undefined,
      }),
    ).rejects.toThrow("unknown selected trait");
  }
  // Missing optional installation defaults provide no grants or restrictions.
  await expect(
    resolveSessionPolicy({
      defaults: ["uninstalled-default"],
      traits: {},
      boundByName: async () => undefined,
    }),
  ).resolves.toMatchObject({ bound: null });
});
