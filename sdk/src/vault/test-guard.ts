/**
 * A test process must not open the real vault.
 *
 * The counterpart to the scratch-store guards in the identities bag. A suite
 * that reaches production state passes either way, so the damage is invisible
 * until someone looks — and it was found the hard way: two point-guard tests
 * asserted an OFFLINE path and passed only because the import behind vault
 * access was broken. Repairing that import made them resolve real credentials
 * and call a live API. Nothing failed. The tests still passed, for a different
 * reason than the one they claimed to test.
 *
 * Under VITEST this throws, and the message says what to do: mock the read,
 * which is what a test asserting on credential ABSENCE means. Set
 * BARRY_ALLOW_REAL_VAULT=1 for the rare suite that genuinely exercises the
 * vault round-trip (vault-restore does, against a fixture account it builds).
 *
 * A caller that injects its own `readSecret` AND points at something other
 * than the production socket touches neither the Keychain nor the live vault,
 * so it is let through — that is how openVault's callers are tested against a
 * stand-in daemon. Injecting secrets but aiming at the real socket is still
 * refused: fake credentials against the live daemon would burn its failure
 * counters, and nothing about that is a test.
 */

import { DEFAULT_VAULT_URL } from "./account.js";

const PRODUCTION_VAULT_SOCKET = "unix:///usr/local/var/barry-vault/run/vault.sock";

export function assertVaultAccessAllowedUnderTest(
  fn: string,
  access: { serverUrl?: string; readSecret?: unknown },
): void {
  // The opt-out steers the test harness, so it only takes effect under VITEST.
  // Honouring it from any shell let a production process set it and skip the
  // BARRY_HOME guard below — a test-only switch reachable in production.
  if (process.env.VITEST && process.env.BARRY_ALLOW_REAL_VAULT === "1") return;
  const reachesProduction =
    access.serverUrl === undefined ||
    access.serverUrl === PRODUCTION_VAULT_SOCKET ||
    access.serverUrl === DEFAULT_VAULT_URL;
  if (access.readSecret && !reachesProduction) return;
  if (process.env.VITEST) {
    throw new Error(
      `${fn}() refuses to open a real vault under VITEST. This reads the machine's ` +
        `Keychain and logs into the live vault server, so a test that reaches here is ` +
        `using production credentials -- and will keep passing while it does. Mock the ` +
        `vault access instead (inject readSecret, or point serverUrl at a stand-in). ` +
        `Set BARRY_ALLOW_REAL_VAULT=1 only if exercising the vault round-trip IS the test.`,
    );
  }
  // A contributor or test instance (BARRY_HOME names one) is for trying code,
  // and code under trial should not be holding live credentials by default.
  if (process.env.BARRY_HOME) {
    throw new Error(
      `${fn}() refuses to open the real vault from the instance at BARRY_HOME=${process.env.BARRY_HOME}. ` +
        `Set BARRY_ALLOW_REAL_VAULT=1 if this change needs live credentials.`,
    );
  }
}
