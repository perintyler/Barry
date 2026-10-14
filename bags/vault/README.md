# Vault bag

Barry's encrypted secret store, running as its own user behind a unix socket.

This bag replaced the container-based vault app. The daemon runs as
`_barryvault` and is what real clients talk to; the old container is gone.

## Why this exists

The vault is the one service on this machine that must not be readable by the
sessions it serves. Same UID is same trust, and on macOS there is no general
same-user sandbox — so a vault running as you is readable by anything else
running as you. Verified on this machine, all from an ordinary agent session
with no elevation:

| Attempt | Result |
|---|---|
| `docker inspect barry-vault` | every secret in plaintext, including the master password |
| `security find-generic-password -w` | returned the master password silently, exit 0 |
| reading the service's 0600 plist | readable — it is owned by the same user |
| keychain partition list | restricts, never grants; cannot fix the above |
| Secure Enclave | unsupported from a daemon; the one unattended config is a silent oracle |

The keychain case is the sharpest: the item's ACL trusts `/usr/bin/security`, so
*any* process that runs that binary satisfies it. That is a confused deputy, and
it is the pattern Silverfort documented against Claude Code's own OAuth token.

A container is a boundary against the network, not against the user who can
reach the Docker socket. **A different UID is the only thing that actually
closes this**, which is what `user: _barryvault` in `bag.yaml` declares.

What it does not stop: anything that reaches root. That is the boundary's edge,
and it is honest about it.

### What the separate user does not protect

The table above is about the DAEMON's own secrets, and for those the UID fix
holds. It does not extend to the credentials clients use to open a vault:

- Each identity's master password, client id and client secret live in the
  **user's** login Keychain (service `barry`, accounts `vault-<name>-*`), written
  without an ACL — so the same `security find-generic-password -w` from the table
  still returns them, silently, to any process running as the user. The master
  password alone is enough to log in (`/api/auth/token`) and decrypt.
- The invoking user is in `_barryvault` by design (see Transports), so the
  user's processes — including agent sessions — can reach the API.

So today the separate UID protects the store's integrity, the daemon's memory
and the server code; it does **not** keep secrets from an agent running as the
user. The resolution path only hands an agent its mapped values by convention.
Key custody under the daemon UID would be needed to close that gap.
See [the preserved design rationale](../../docs/decisions/0042-vault-key-custody-and-action-records.md).

## Layout

```
bag.yaml               service declaration — user:, socket:, env
src/db.ts              SQLite handle + schema (inline, see below)
src/mcp.ts             MCP endpoint — six vault_* tools
src/ui/app.html        the web UI (see "Web UI" — live remotely, unreachable locally)
server/src/index.ts    entrypoint: resolves paths, installs signal handlers
server/src/app.ts      the express app — REST surface, exported not listened
server/src/listen.ts   the unix-socket listener — the only transport
```

Vault keeps its schema inline in `src/db.ts`. It is an exception to the normal
bag convention: append-only SQL migration files are bundled into generated
catalogs through `sdk/scripts/store-migrations.json`. See [the inline-schema rationale](../../docs/decisions/0042-vault-key-custody-and-action-records.md).

## Transports

`server/src/listen.ts` serves the unix socket, and only the unix socket.

The socket is the point: its permissions are enforced by the kernel at
`connect()`, so `0660` owned by `_barryvault:_barryvault` is a real gate — a
process outside that group cannot reach the vault at all, which a loopback TCP
listener could never guarantee (anything on the machine can reach loopback,
regardless of group).

That gate bounds reach to the GROUP, and the group includes the user:
[provisioning](#provisioning-a-new-machine) adds `$(id -un)` to `_barryvault`, deliberately — the backup
reads the database as the user, and `run/` needs group traverse. So the socket
keeps other local users out; it does not keep the user's own agent sessions off
the API. `curl --unix-socket …/vault.sock http://localhost/health` answers from
an ordinary session.

This bag briefly carried a transitional TCP listener for clients that still
resolved `http://localhost:3923`, gated by `VAULT_DISABLE_TCP`. Every generated
plist set that to `1` from day one — the port was only ever meant for the OLD
container-based service — and both real clients
(`sdk/src/vault`, the CLI) resolve the socket unconditionally now, so the
listener and the env var that gated it were removed from the code rather than
left defaulted off. A reinstall from an older bundle cannot reopen an edge the
code no longer has.

## Web UI

`GET /` serves `src/ui/app.html` over the socket, where no browser can reach it
— there is no tunnel, proxy or port-forward to the local daemon. Do not read
that as dead code: **the same UI is live at `vault.barry.rocks`**, served by the
original `barry-vault` Cloudflare Worker (D1 database `barry-vault`) that this
bag replaced. The migration commit (`40533315`) deleted the Worker's code and
`wrangler.jsonc` from git but never tore the deployment down; it still runs that
pre-migration code behind a Cloudflare Access app and holds its own, separate
data. It is scheduled for decommissioning — migrate by hash comparison, rotate
what it held, then delete — and the UI is to be republished through a private
tunnel instead. Both are recorded in the multi-vault plan,
since removed from this tree (Phases 1e and 1f); until they land, keep `app.html`.

## The live service

The LaunchDaemon is the live service: `_barryvault` owns
`/usr/local/var/barry-vault/vault.db` and clients reach it over the socket
(`sdk/src/vault/client.ts`). It backs secret resolution for every identity,
and an outage here is invisible until a session cannot resolve a credential, so
a change here is verified by resolving a real credential, never by `/health`
alone, which answers without opening the database.

## Verifying the boundary

After setup, read the instance id from `instance.json` and substitute it below.
The daemon must run as `_barryvault`, the installed entry must be unwritable by
an ordinary user, and the plist must contain no credentials:

```bash
barry service status vault.api
ps -o user= -p <daemon-pid>                              # _barryvault
test -w /usr/local/libexec/barry/<instance-id>/vault.api/server.mjs  # must fail
test -w /usr/local/libexec/barry/<instance-id>/runtime/node-v<version>-darwin-arm64/bin/node  # must fail
launchctl print system/rocks.barry.<instance-id>.vault.api          # no credential values
security find-generic-password -s barry-vault-master -w # not found
```

If the legacy plist carried credentials, rotate the reported names after
cutover: `launchctl print` exposed their values to every local user.

The daemon never runs the user's Node: a user who can replace the interpreter
controls what runs as the account, however root-owned the code is. It runs
nodejs.org's macOS build, pinned with its SHA-256 in
`cli/src/services/runtime.ts` and installed root-owned beside the code. That
build links only system libraries.

The `security` line proves less than it looks. `barry-vault-master` is the
daemon's own retired item, so "not found" shows only that the DAEMON's password
left the user's Keychain. The identity credentials did not: `security
find-generic-password -s barry -a vault-<identity>-master-password` finds an item
for every provisioned identity (checked 2026-09-25 for `bux` and `bgoode`,
metadata only). See "What the separate user does not protect" above — do not
read a pass on this list as "agents cannot reach the secrets".

## Using it from Barry

Vault commands belong to an identity, so they run under its command
(`bgoode vault …`); `barry` itself has no `vault` group. Creating an identity
with an email provisions its Vault account and stores the client credentials in
Keychain; `<identity> vault provision --email <email>` does the same for one
that already exists. An item is used by declaring it in the identity's
`identity.yaml` under `secrets:` with `in: vault`; Barry resolves declarations
per turn, and the agent receives the resolved value, never the master password
or client credentials.

**The vault is the default credential source for harnesses.** Each harness
bag declares its credential env vars as vault items (`credentials:` in its
`bag.yaml`); an identity may override any of them with its own definition
(vault, `.env`, or inline), and the session gate refuses a session whose
required credentials have no definition or will not read. The one client entry
point is `openVault(name)` in `@barry-rocks/sdk/internal/vault` — it reads the
Keychain, logs in, and returns a session; everything else (the five builders
that used to wrap it) is gone.

```bash
bgoode vault status
bgoode vault add API_KEY <value>
bgoode vault remove API_KEY
```

```yaml
# identity.yaml
secrets:
  API_KEY:
    in: vault
    item: API_KEY
    field: password
```

### Sharing a vault between identities

An identity can NAME a vault instead of carrying its connection details, and
several identities may name the same one:

```yaml
# identity.yaml
vault: personal
```

```bash
bgoode vault assign personal --email you@example.com
bux vault assign personal                       # same vault, shared
bgoode vault list --vault personal              # reach a vault no identity names
```

The inline block is still read and is never rewritten, so an identity
configured before this keeps working untouched.

`--name` means the IDENTITY, as it always has; `--vault` means the vault.
Passing both is refused rather than ranked — they can disagree, and picking a
winner would act on a vault you did not name.

Sharing changes what a write means. Items are keyed by name within an account,
so two identities both wanting `API_KEY` want the SAME item: setting it in one
replaces the value the other resolves at session start. The write commands
refuse an overwrite in a shared vault unless you pass `--force`, and `vault
remove` checks every sharing identity's mappings rather than only the one you
named. Prefix items (`bux/API_KEY`) when two identities need different values
for the same variable — `SecretSource` already addresses the item separately
from the env key.

### Service access

A bag service can declare vault-sourced env and names the vault it may open:

```yaml
services:
  api:
    vault: hq
    env:
      LINEAR_API_KEY: { source: vault, item: LINEAR_API_KEY, field: password }
```

Resolved by the service at STARTUP, never written into the plist — that is what
keeps a rotated secret working without a reinstall. `vault:` is required rather
than defaulted: a service falling back to an ambient identity's vault would read
credentials nobody granted it.

**A service key currently opens the whole account.** The API key returns the
account's wrapped symmetric key, so a service can decrypt every item in the
vault it opens, not only the ones it declared. Give a service its own vault
when that matters. Narrowing this needs per-item content keys — a crypto
change, not a scope table: item NAMES are encrypted client-side, so the server
has nothing to match on, and a server-side filter would not bind a client that
already holds the account key.

#### Why a service secret does not fix this

The instinct is to gate service access behind another credential. It does not
help, and the reason is worth writing down so nobody re-derives it.

Authenticating already takes three secrets: `clientId`, `clientSecret`, AND the
master password. The API key alone yields a JWT and the account's *encrypted*
key — useless without `deriveKeys(masterPassword, email, salt)` to unwrap it.
Access is also already gated by the unix socket, which the kernel enforces at
`connect()`. A fourth secret locks a door that has two locks.

The problem is not authentication. It is that **an account has exactly one
encryption key**: a service either holds it and everything decrypts, or does not
and nothing does. No credential check changes that arithmetic — the server can
faithfully refuse to *serve* an item the service still holds the key to open.
That is a filter, not a lock.

#### The three options, in cost order

1. **A vault per service — available now, no new code.** `vault: hq-api` in the
   manifest, provisioned as its own account. Real isolation by the mechanism
   that already exists: a different key. Costs a second account to back up and
   a second unrecoverable master password. This is why `vault:` is required
   rather than defaulted.

2. **Per-item content keys — the actual scoping.** Each item gets its own key,
   wrapped for the account; a service key carries only the wrappings it is
   entitled to. Cryptographically enforced, and survives a compromised server.

3. **Server-side scope on `item_id`.** Item NAMES are ciphertext so the server
   cannot match them, but `id` is a plaintext server-generated UUID, so
   `service_key_scopes(api_key_id, item_id)` is enforceable. Scope on `item_id`,
   **never `item_name`** — a name column matches nothing and is a guard that
   silently never fires.

Do 2 and 3 together. **Not 3 alone**: a filter that looks like a boundary is
worse than a documented gap, because people trust it.

#### What doing it costs

Existing items are encrypted under the single account key, so per-item keys mean
re-wrapping ~20 items across 3 accounts. Small in volume, high in consequence:

- Needs the master password, which is **unrecoverable**.
- Snapshot first, and verify the snapshot by **decrypting a real item** — row
  counts prove the file survived, not that you still hold the key.
- `cli/src/commands/vault-restore.ts` independently reimplements the unwrap
  sequence and **would diverge silently**. Update it in the same change, or
  restore breaks in a way that only shows up the day you need it.
- Land the dual-format READ path before anything writes the new format, so no
  item is ever unreadable by a deployed client.

#### A test note for whoever picks this up

`cli/src/commands/vault-commands.test.ts` once mocked the credentials module
wholesale, which is how a stale belief about `getVaultConfig` survived long
enough to fail three tests against correct code. It now mocks only
`buildVaultSession` — which must not reach a real vault from a test process —
and uses the real `getVaultConfig`.

Moving a barry to its own Vault account means carrying the secrets across: the
vault is zero-knowledge, so a new account starts empty and the server cannot
copy items between accounts.

```bash
old vault export --out secrets.json            # written 0600
new vault provision --email new@example.com
new vault import --file secrets.json           # skips names that exist
rm secrets.json
```

That export is cleartext on purpose — an encrypted one needs a key, and a key
stored beside the file on the same machine protects nothing. Delete it once the
import is done.

The top-level `barry env` group is a different command: this instance's secrets file.

## Provisioning a new machine

Build the vault and prepare its definition as the instance owner, then review
and apply the privileged pass:

```bash
pnpm --filter @barry-rocks/vault-bag build
barry setup
sudo barry setup --system --dry-run
sudo barry setup --system
```

The system pass creates `_barryvault` if missing, adds the owner to its group,
and installs root-owned code in `/usr/local/libexec/barry/<instance-id>/vault.api`.
It also installs the pinned Node in
`/usr/local/libexec/barry/<instance-id>/runtime/`. It has no network:
`barry setup` downloads the tarball into the owner's cache, and the system pass
refuses unless the tarball matches the pinned SHA-256. Before it stops anything,
it loads the staged code's native modules with the staged Node as
`_barryvault`.
Group membership reaches new login sessions only. The machine instance retains
`/usr/local/var/barry-vault`; a `BARRY_HOME` instance uses
`/usr/local/var/barry-vault-<instance-id>`. Alternate-instance clients need
`VAULT_URL` or `VAULT_SOCKET_PATH` set to that instance's socket.

Configure private credentials and preserve signing state as described below
before starting a migrated database. Setup never embeds credentials in a plist.

## Operating

The vault runs independently of `barry up` and `barry down`.

```bash
barry service status vault.api
sudo barry service restart vault.api
sudo tail -f /usr/local/var/barry-vault/logs/vault.api.err.log
```

Use `sudo barry service stop vault.api` to stop it, `disable` to suppress boot
startup, or `remove` to unregister it. Explicit `sudo barry setup --system`
installs a removed system service again.

## Shipping a code change to the daemon

```bash
pnpm --filter @barry-rocks/vault-bag build
sudo barry setup --system --dry-run
sudo barry setup --system
<identity> vault status
```

Setup stages the whole built entry directory, including native dependencies and
UI, removes write bits, swaps it into place, and restarts the daemon. Health must
pass before the legacy plist is removed. A switch failure restores the loaded
legacy daemon or the previous code and running instance label. Verify a real
credential resolution after deployment; `/health` does not open the database.

The previous bundle remains at
`/usr/local/libexec/barry/<instance-id>/vault.api.previous`. For a later manual
rollback, stop the service, move the failed directory aside, restore `.previous`
to `vault.api`, and start it with `sudo barry service start vault.api`. Keep the
legacy `/usr/local/libexec/barry-vault` directory until the new daemon has been
verified over time. Code rollback assumes the database schema remains compatible.

## Configure the daemon

Create `/usr/local/var/barry-vault/private` owned by `_barryvault`, mode 0700.
Install `barry.yaml` and `.env` there, owned by `_barryvault`, mode 0600.
For a `VAULT_DB_PATH` override, the private directory is beside that database.
The daemon reads these references at every start:

```yaml
secrets:
  VAULT_REGISTRATION_SECRET: { in: .env }
  VAULT_BACKUP_SECRET: { in: .env }
  # Optional direct daemon MCP credentials:
  VAULT_MCP_TOKEN: { in: .env }
  VAULT_MASTER_PASSWORD: { in: .env }
  VAULT_CLIENT_SECRET: { in: .env }
mcp:
  email: operator@example.com
  client_id: vault.account-id
```

Omit optional MCP references when direct daemon MCP is unused. Populate only
the declared names in the private `.env`. Keychain references use the shared
`in: keychain` contract and must be readable by the service account. Bootstrap
cannot use `in: vault`: opening the vault would depend on its own startup.
An authored missing credential fails startup. An absent configuration leaves
registration and backup closed; shell credentials never supply them. Email
and client ID belong in the ordinary `mcp` configuration, not secret lists.

The installation's provisioning, backup and restore clients use their own
explicit `VAULT_REGISTRATION_SECRET` and `VAULT_BACKUP_SECRET` references with
matching credential values. Complete installation/rotation automation remains
part of the finalization plan. Restore resolves its backup credential before
stopping the daemon and always performs its database-reading liveness probe.
Curl receives credential headers through stdin, without command-line values.

## Preserve signing state

Before first startup of a migrated database, copy its existing signing key to
`private/token-signing-key`, owned by `_barryvault`, mode 0600. Retain a key
already there; replacing it invalidates issued tokens. A fresh daemon creates
its key atomically. Restore this file together with its corresponding database.
Neither signing state nor configured credentials are embedded in the plist.
Restart after credential changes; plist regeneration is unnecessary.

`vault.db` must be `0640` owned `_barryvault:_barryvault`, and the directory
`0750`. Both halves are needed and they do different jobs: `0750` on the
directory grants the `_barryvault` GROUP traverse, which lets `barry db backup`
reach the path, and `0640` on the file is what lets it actually read what it
reached. This paragraph previously said the file was `0600` and credited the
directory mode with making it reachable — traverse is not read, and a `0600`
file cannot be backed up by anyone but `_barryvault`.

That is not academic. The daemon creates the database through SQLite at its own
umask, which yields `0600`, so the group bit is lost every time the file is
recreated — observed on 2026-09-19, six days into a backup outage. The symptom
is the nightly job reporting

    vault.db SKIPPED — ... EACCES: permission denied

Restore it with:

    sudo chmod 640 /usr/local/var/barry-vault/vault.db

`barry db backup` reports this as a loud SKIPPED line rather than silently
omitting the vault, and the `backup-freshness` watchdog (in the barry-devops bag)
alerts if backups stop landing altogether.

The JWT signing key is read at daemon startup from
`/usr/local/var/barry-vault/private/token-signing-key`, beside the database in
a daemon-owned 0700 directory; the key is 0600. A fresh installation creates it
atomically. When migrating an existing installation, carry over the previous
bag-owned key before starting the daemon. Never replace an existing key to fix
a startup failure: it signs already-issued tokens. Include it with the database
in recovery procedures. A `VAULT_DB_PATH` override locates the private directory
beside that database. The daemon ignores ambient `JWT_SECRET` values.

Daemon credentials are selected from references in `private/barry.yaml` and
read at startup from the declared private file or service-account Keychain.
The plist contains process configuration without credential values. Restart
after credential changes. Direct MCP email/client ID are ordinary configuration;
its credential references are optional when direct MCP is unused. See the
[daemon configuration guide](README.md#configure-the-daemon).

## Backups, and why they are the risky part

`barry db backup` includes the Vault; the nightly `backup` job runs it at 03:30
and prunes past `BARRY_BACKUP_RETAIN_DAYS` (default 14).

The database runs in WAL mode, so copying `vault.db` alone loses recent writes and
copying the set mid-write can capture a torn database. The backup uses
`VACUUM INTO` for one consistent snapshot, then integrity-checks it and **rejects
a snapshot containing no accounts** — the characteristic failure here is a
valid-looking empty file, not a loud error. A Vault failure degrades to `SKIPPED`
rather than aborting the rest of the backup, and the job escalates that as an
alert rather than reporting a clean run.

Set `BARRY_VAULT_AGE_RECIPIENT` and backups are wrapped with
[age](https://github.com/FiloSottile/age) as `vault.db.age`. Recipient-based
encryption means writing a backup needs no private key, so scheduled runs never
hold decryption material. If the variable is set but `age` is missing the backup
**fails rather than silently writing plaintext**. With R2 credentials the job also
ships an encrypted copy off-machine, and **refuses to upload if it cannot
encrypt**.

### Verify a backup by decrypting it, not by counting rows

`PRAGMA integrity_check` and matching row counts prove the *file* survived. They
say nothing about whether you still hold the key that opens it, and that is the
half that actually fails. A backup passes only when a real item decrypts out of
it.
`<identity> vault restore <backup>/vault.db.age --dry-run` does exactly that and
changes nothing: it decrypts the file, integrity-checks it, and decrypts one real
item with the identity's master password.

### The master password is the real dependency

A backup is useless without two unrecoverable secrets: the **master password**
(Keychain, service `barry`, account `vault-<identity>-master-password`) and the
**age private key** (`vault-backup-key.txt` in `~/Library/Application Support/Barry`).

**There is one master password per identity, and picking the wrong one looks like
a corrupt backup rather than a wrong password** — you get `MAC verification
failed`. Find the right one by the account that actually holds the items:

```bash
sqlite3 vault.db "SELECT a.email, count(i.id) FROM accounts a \
  LEFT JOIN items i ON i.account_id = a.id GROUP BY a.id ORDER BY 2 DESC;"
```

`BARRY_VAULT_MASTER_PASSWORD` in the instance env is **not** reliably the right one — on
this machine it opens an account holding zero items, so a restore driven from it
decrypts nothing and reads as total data loss.

Both secrets currently live on this machine, so one disk failure takes the Vault
and both keys at once. **Keep a copy of each off the machine.** Until then the
backups are decorative. There is no reset path, no server-side copy, and no
vendor to appeal to: that is what zero-knowledge means.

Client and cryptography live in `sdk/src/vault/`.
