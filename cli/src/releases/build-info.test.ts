import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error Build tooling is standalone JavaScript.
import { bundleBuildInfo } from "../../scripts/build-info.mjs";
import { releaseRoot } from "./release.js";
it("accepts an explicit archive commit and rejects missing or invalid provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-build-info-"));
  try {
    expect(bundleBuildInfo(root, { BARRY_BUILD_COMMIT: "a".repeat(40) })).toMatchObject({ commit: "a".repeat(40), dirty: false, builtAt: expect.any(String) });
    expect(() => bundleBuildInfo(root, {})).toThrow("BARRY_BUILD_COMMIT");
    expect(() => bundleBuildInfo(root, { BARRY_BUILD_COMMIT: "invalid" })).toThrow("BARRY_BUILD_COMMIT");
    expect(bundleBuildInfo(releaseRoot(), { BARRY_BUILD_COMMIT: "invalid" }).commit).toMatch(/^[0-9a-f]{40}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
