/**
 * An identity as `Barry` hands one out, for a fake identities subject to
 * answer with. Plain data, so a suite that mocks the filesystem or the
 * identities bag can use it without loading the real store.
 */
import type { Identity } from "@barry-rocks/sdk";

export function identityFixture(name: string, fields: Partial<Identity> = {}): Identity {
  return {
    id: 1, token: `fixture-identity-${name}`, name, displayName: null, bags: [], traits: [], bounds: [],
    adapters: {}, envKeys: [], vaultEmail: null,
    isDefault: false, createdAt: null, lastUsedAt: null, ...fields,
  };
}
