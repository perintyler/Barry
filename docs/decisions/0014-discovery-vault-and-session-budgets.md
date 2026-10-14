# ADR 0014: discovery, vault access, and session budget invariants

Status: accepted

## Context

Duplicated default grants and vault connection builders can drift. A single bag
with broken tools must remain diagnosable without rejecting unrelated registry
entries. Vault transport failures must not become legacy cryptographic parameters.
Session residency and provider execution constrain different resources. Historical
source explanations are preserved below rather than presented as new measurements.

## Decision

Use one session vocabulary and independent resident/execution budgets, with
synchronous resident reservations. Derive default bag and trait grants from the
root identity. Preserve tool-load errors on individual bags and retain tool
provenance in metadata. Open named vaults through one credential-and-login flow,
require explicit trusted endpoints, and interpret legacy salt only from a
successful explicit null response. Keep the current invariant beside each
implementation and retain historical rationale here.

## Consequences

Broken bags remain visible to diagnostics without disrupting unrelated loading.
Default grants have one source. Vault outages remain transport/server errors rather
than appearing as corrupt encrypted data. Resting sessions consume residency but
not provider execution capacity. This change moves comments without changing
executable tokens or runtime behavior.

## Historical rationale

### bags/sessions/api/src/db.ts

```typescript
/**
 * Barry server database layer.
 *
 * Thin adapter over the session and config stores.
 *
 * This file used to note that "Sessions and PlannedSessions are now unified —
 * every session IS a planned session." That was true, and it was the argument
 * for deleting the second vocabulary rather than documenting it: one `sessions`
 * table, one record, one set of names.
 */
```

### bags/sessions/api/src/execution-admission.ts

```typescript
/**
 * Execution admission control: two independent budgets.
 *
 * RESIDENT budget bounds how many sessions this process holds in memory —
 * `startSession`'s ten-session limit used to be checked with an `await` gap
 * between the check and `activeSessions.set(...)`, so concurrent starts
 * could all pass the same stale count (a classic TOCTOU). `ResidentBudget`
 * closes that by making the reservation itself synchronous: JS has no
 * preemption inside a synchronous call, so N concurrent `reserve()` calls
 * cannot all observe capacity that only one of them gets to keep.
 *
 * EXECUTING budget bounds how many turns are actively streaming through a
 * provider at once — a session resting between turns (`status: "waiting"`)
 * holds a resident slot but not an execution lease. The two are
 * independent: a cold start needs a resident reservation and (for its first
 * turn) a lease; a resume needs only a lease.
 */
```

### sdk/src/vault/account.ts

```typescript
/**
 * Opening a vault: the ONE way any code gets at vault items.
 *
 * A vault is addressed by name. Everything else is derivable: the account's
 * credentials are filed in the login Keychain under `vault-<name>-*`, the
 * endpoint is the host's one daemon (or `VAULT_URL`), and the KDF salt is
 * fetched from the server at login. That is what lets two identities share a
 * vault — a name can be written twice, where a connection blob duplicated into
 * two files drifts.
 *
 * This replaces the five builders that used to live in the credentials
 * package (buildVaultResolver, connectVault, checkVaultHealth,
 * buildVaultSession, openVaultByName — four copies of read-three-secrets-
 * and-login, each wrapping the session differently). There is one flow now:
 * read the Keychain, log in, return a session. Failures throw — a vault that
 * cannot open is an answer, not a null.
 */
```

### sdk/src/vault/client.ts

```typescript
/**
   * `serverUrl` is `unix:///absolute/path/to.sock` — the transport the vault
   * daemon serves — or an http(s) URL that `assertTrustedVaultUrl` accepts
   * (loopback, or an allowlisted remote store). Nothing about the request
   * bodies, auth, or crypto differs between transports; only how bytes reach
   * the server does.
   *
   * Required, with no fallback default. This used to default to
   * `http://localhost:3923`, a URL nothing has served since the daemon moved
   * to a socket-only transport — every real call site already passes its own
   * `vaultConfig.serverUrl`, so the default was reachable only by a caller
   * that forgot to pass one, and would have silently pointed it at a dead
   * port instead of failing at construction.
   *
   * This class does not read `VAULT_URL` itself, but its callers do: the CLI's
   * provisioning path (`cli/src/commands/identity.ts`) and the named-vault
   * default in `credentials/index.ts`. So a stray `export VAULT_URL=...` CAN
   * reach here — which is why every URL is checked by
   * `assertTrustedVaultUrl` before a single byte is sent.
   */
```

### sdk/src/vault/client.ts

```typescript
/**
   * The account's KDF salt, or null for a legacy account created without one.
   *
   * Only a literal `200 {salt: null}` means "legacy". This used to return null
   * for ANY non-OK answer too, and `deriveKeys` then quietly fell back to the
   * email-only legacy salt — so a daemon error on this call surfaced much later
   * as "MAC verification failed", an outage reading as a corrupt vault.
   */
```

### sdk/src/bags/builtin.ts

```typescript
/**
 * What the base identity at the repository root packs and grants.
 *
 * Its `traits:` are what a session with no identity, or one that selects
 * nothing, is granted; its `bags:` are what every session loads. Both used to
 * be constants in code (`DEFAULT_TRAITS`, the CLI's `ALWAYS_ON_BAGS`) that
 * drifted from the shipped identity that restated them. Empty when there is no
 * builtin directory, which `builtinBagsDir` already reports.
 */
```

### sdk/src/bags/loader.ts

```typescript
/**
 * Last tool-load failure reported per bag, so each is warned about once.
 *
 * The failure arrived when tool metadata moved from manifests into code:
 * `loadBag` builds and imports every bag's tools, and it used to throw when
 * that failed. `loadBags` is a Promise.all, so one bag with an unresolvable
 * import rejected every load it was part of — the registry snapshot,
 * `bag doctor`, the identity sync — while callers written to skip a broken
 * bag (see session-runtime's `skipped`) never got the chance. The bag now
 * loads with `toolsError` set instead, the same degrade an invalid manifest
 * gets, and `barry bag doctor` counts it.
 */
```

### sdk/src/tools/tool-meta.ts

```typescript
/**
   * The bag that contributed this tool.
   *
   * Both collection passes already know it; it used to be dropped on the way
   * into the flat map, which left consumers unable to tell a builtin tool from
   * a user bag's. Optional because a cached entry written by an older build
   * (or a hand-built fixture) may predate the field.
   */
```
