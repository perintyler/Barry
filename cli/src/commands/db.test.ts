import { describe, expect, it } from "vitest";
import { vaultSkipReason } from "./db.js";

/**
 * The vault is the machine's, reached with the shell's credentials. A backup
 * of a contributor or test instance copied the real vault's secrets into that
 * instance's scratch directory.
 */
describe("which backups include the vault", () => {
  it("leaves it out of an instance BARRY_HOME names, and says how to include it", () => {
    expect(vaultSkipReason({ BARRY_HOME: "/tmp/contributor" }, {})).toMatch(/BARRY_HOME.*--vault/);
  });

  it("includes it when --vault asks, or for the installed instance", () => {
    expect(vaultSkipReason({ BARRY_HOME: "/tmp/contributor" }, { vault: true })).toBeNull();
    expect(vaultSkipReason({}, {})).toBeNull();
  });
});
