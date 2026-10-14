# ADR 0016: vault daemon boundaries

Status: accepted

## Context

Vault login limiting, backup consistency, item ownership and bearer credentials
protect different boundaries. Historical source explanations mixed those decisions
with the current invariants. Preserve the rationale without presenting historical
observations as newly verified deployment facts.

## Decision

Count failed authentication attempts rather than successful opens. Snapshot through
the daemon's live database connection without broadening raw-file permissions.
Reject empty item updates and report missing or foreign-account IDs as absent.
Keep the daemon's dedicated user and permission-controlled Unix socket. Separate
MCP bearer credentials from the JWT signing key through an explicit token or HKDF.
Keep concise invariants in source and retain the complete historical explanations below.

## Consequences

Successful logins do not consume failure budgets. Backups see committed WAL data
through the owning connection. Item updates report actual effects and credential
roles remain separate. This pass changes comments only, including no database,
process, credential or socket operations.

## Historical source rationale

### bags/vault/server/src/app.ts

```text
// Only FAILED authentications count. The limiter used to increment on every
// allowed request, before credentials were even checked, and key on `req.ip`
// — which is undefined over the unix socket, so every caller on the machine
// shared one bucket of 5 per minute. Five successful vault opens in a minute
// locked the whole host out, and the 429 surfaced downstream as a session
// quietly missing its secrets.
//
```

### bags/vault/server/src/app.ts

```text
/**
 * Snapshot the vault and stream it back.
 *
 * The backup used to run `VACUUM INTO` from the backup user's own process,
 * reading /usr/local/var/barry-vault/vault.db directly. That broke — the file
 * is 0600 _barryvault — and the obvious repair (widen the mode) is worse than
 * it looks. SQLite recreates -wal/-shm at the daemon's umask on every
 * checkpoint, so the permission has to be re-granted forever; and a file-level
 * read of a WAL database that misses the -wal does not fail, it silently
 * returns a SUBSET. Measured on a scratch db shaped like this one: 4,959 of
 * 5,001 rows, opening cleanly and passing an integrity check. A backup that is
 * quietly short is worse than one that is loudly absent.
 *
 * Running VACUUM INTO here fixes both. getDb() is the same long-lived handle
 * that set journal_mode=WAL and serves every write, so the snapshot sees the
 * WAL by construction, and the backup user never needs to read the raw file —
 * which keeps the separate-UID boundary this whole bag exists for.
 */
```

### bags/vault/server/src/app.ts

```text
  // A body naming no field used to run a touch-only UPDATE and answer ok:
  // success for a write that changed nothing.
```

### bags/vault/server/src/app.ts

```text
  // Zero rows means the id does not exist or belongs to another account. Both
  // used to answer ok, so a typo'd id or a cross-account write read as done.
```

### bags/vault/server/src/index.ts

```text
/**
 * Vault service entrypoint for the bag.
 *
 * The request handling is unchanged from the app this bag supersedes — the same
 * express app, the same REST surface, the same MCP endpoint. What changes is
 * WHERE it listens and WHO it runs as:
 *
 *   - as `_barryvault`, not as the user (see bag.yaml `user:`), which is the
 *     only thing that stops an agent session reading what the vault holds;
 *   - on a 0660 unix socket, whose permissions the kernel enforces at connect().
 *
 * Socket only. The loopback TCP listener that used to live here was always
 * transitional — meant to keep the OLD container-based service's clients
 * working during the cutover — and every
 * generated plist has set VAULT_DISABLE_TCP=1 since the day this daemon
 * first ran, so it never actually bound the port in production. Both real
 * clients (`sdk/src/vault`, the CLI) resolve the socket unconditionally now,
 * so the branch that would have re-opened TCP is gone rather than defaulted
 * off — a reinstall from an older bundle cannot reopen an edge the code no
 * longer has.
 */
```

### bags/vault/src/mcp-token.ts

```text
/**
 * The bearer token that gates the daemon's `/mcp` endpoint.
 *
 * `VAULT_MCP_TOKEN` when set. Otherwise DERIVED from the daemon signing key — never
 * equal to it. The fallback used to be JWT_SECRET itself, which made two
 * secrets with different jobs interchangeable: whoever held the MCP bearer
 * could sign session JWTs for ANY account, and the MCP path is the one that
 * holds decrypted item keys. HKDF is one-way, so the derived bearer still
 * fails closed when no dedicated token is configured, without handing its
 * holder the signing key.
 *
 * An operator who needs the derived value computes it from the signing key with
 * `deriveMcpToken`; setting VAULT_MCP_TOKEN explicitly is the better answer.
 */
```
