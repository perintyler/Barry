import { afterEach, describe, it, expect } from "vitest";

import { getActiveIdentity, getPersistedActiveIdentity } from "../src/lib/current-user.js";

// Where the pointer goes when the identity it names is deleted is the
// operation's decision now (`identities.remove`, tested in the identities bag).

/**
 * A per-identity command (`bux …`) exports BARRY_IDENTITY. Every command that
 * asks "which identity am I acting on?" has to see it, or `bux show` would
 * describe the persisted default instead — reporting confidently on the wrong
 * identity, which is the failure mode this whole feature exists to remove.
 */
describe("getActiveIdentity", () => {
  const original = process.env.BARRY_IDENTITY;
  const user = { settings: { defaultBarry: "stored" } } as never;

  afterEach(() => {
    if (original === undefined) delete process.env.BARRY_IDENTITY;
    else process.env.BARRY_IDENTITY = original;
  });

  it("returns the stored default when nothing overrides it", () => {
    delete process.env.BARRY_IDENTITY;
    expect(getActiveIdentity(user)).toBe("stored");
  });

  it("prefers BARRY_IDENTITY", () => {
    process.env.BARRY_IDENTITY = "from-command";
    expect(getActiveIdentity(user)).toBe("from-command");
  });

  it("ignores a blank override", () => {
    process.env.BARRY_IDENTITY = "   ";
    expect(getActiveIdentity(user)).toBe("stored");
  });

  // `barry use` reports and changes the stored pointer, so it must see through
  // the override — otherwise `bux use --list` would claim bux is the global
  // default when it is not.
  it("getPersistedActiveIdentity ignores the override entirely", () => {
    process.env.BARRY_IDENTITY = "from-command";
    expect(getPersistedActiveIdentity(user)).toBe("stored");
  });
});
