# Secrets

How to give an agent a credential it can use without ever letting the model see
it. Secrets in Barry live in an encrypted vault, are bound to an identity, and
are resolved per turn: the agent's tools receive the resolved value, never the
master password or the client credentials.

This guide covers the everyday path. For the daemon's security boundary,
provisioning a new machine, and backups, see the
[vault bag README](../bags/vault/README.md).

## The model in one paragraph

Each identity has a vault: an encrypted store served by a daemon that runs as its
own OS user (`_barryvault`). You put a secret in the vault, then declare it in the
identity's `identity.yaml` so a session can use it. When a session starts, Barry
reads the declared secrets and hands each tool only the values that tool needs.
A session whose required credentials are missing or unreadable is refused at
launch rather than started without them.

Three things never reach the agent: the vault master password, the vault client
credentials, and any secret the identity did not declare.

## Where a secret can come from

A declaration names one of three sources:

| Source | `in:` | Use it for |
|---|---|---|
| Vault | `vault` | Anything secret. The default and recommended home. |
| Env file | `.env` | A value kept in the identity's own `.env` file. |
| Keychain | `keychain` | An item already in the macOS login Keychain. |

Vault is the expected home for secrets. `.env` and `keychain` exist for values
you already keep elsewhere. (An inline constant source also exists, but it is for
non-secrets only, since the value sits in plain text in the manifest.)

## Store a secret in the vault

Vault commands belong to an identity, so you run them through that identity's own
command (for example `bonanza`), not through bare `barry`.

An identity created with an email already has a vault:

```sh
barry identity create bonanza --email you@example.com
```

To add a vault to an identity that does not have one yet:

```sh
bonanza vault provision --email you@example.com
```

Then add, inspect, and remove items:

```sh
bonanza vault status
bonanza vault add API_KEY <value>
bonanza vault list
bonanza vault remove API_KEY
```

## Declare it so a session can use it

Putting a value in the vault does not expose it to anything on its own. Declare
it in the identity's `identity.yaml` under `secrets:`. Each declaration maps an
environment variable name to a vault item and the field to read (`password` is
the usual one; a vault item also has `username`, `uri`, and `notes`):

```yaml
# identity.yaml
secrets:
  API_KEY:
    in: vault
    item: API_KEY
    field: password
```

A `.env`-sourced secret reads from the identity's own `.env`:

```yaml
secrets:
  API_KEY:
    in: .env
```

A Keychain-sourced secret names the login Keychain item:

```yaml
secrets:
  API_KEY:
    in: keychain
    item: my-service
    account: my-account
```

Barry resolves these per turn. If several required secrets cannot be read, the
launch reports all of them at once rather than one per attempt.

## Harness credentials

The vault is also the default source for the credentials a harness needs. Each
harness bag declares its credential environment variables as vault items in its
`bag.yaml`. An identity may override any of them with its own definition (vault,
`.env`, or Keychain), and that identity definition wins.

If a required credential has no definition, or its source will not read, the
session is refused at the gate, and the message names the variable to fix. This
is deliberate: a session authenticates only through declared sources, never
through an undeclared login or ambient key.

## Different keys per identity

Because secrets are bound to an identity, two identities can hold different
values for the same variable without logging in and out of anything. Give each
identity its own vault item and its own declaration, and `barry use <identity>`
(or running the identity's own command) selects which one a session gets.

## Sharing one vault across identities

An identity can name a shared vault instead of carrying its own:

```yaml
# identity.yaml
vault: personal
```

```sh
bonanza vault assign personal --email you@example.com
bgoode  vault assign personal                 # the same vault, now shared
```

Items are keyed by name within a vault, so two identities that both declare
`API_KEY` resolve the same item: setting it under one changes what the other
reads. Writes to a shared vault refuse an overwrite unless you pass `--force`,
and `vault remove` checks every sharing identity before removing. When two
identities need different values for the same variable, prefix the item name
(for example `bonanza/API_KEY`) and point each declaration at its own item.

## Moving secrets to another vault

A vault is zero-knowledge, so a new account starts empty and the server cannot
copy items between accounts. Carry them across the client:

```sh
old vault export --out secrets.json           # written 0600, plaintext on purpose
new vault provision --email new@example.com
new vault import --file secrets.json          # skips names that already exist
rm secrets.json
```

The export is cleartext because an encrypted copy would need a key, and a key
kept beside the file on the same machine protects nothing. Delete it once the
import is done.

## What you must not lose

Each identity's vault has a single **master password**, stored in the macOS login
Keychain, and it is unrecoverable. There is no reset path, no server-side copy,
and no vendor to appeal to. If backups are encrypted with
[age](https://github.com/FiloSottile/age), the age private key is a second
unrecoverable dependency. Keep a copy of both off the machine. A backup you
cannot decrypt is not a backup; verify one by actually decrypting an item from
it (`<identity> vault restore <backup> --dry-run`), not by counting rows.

## Honest limits

- The separate `_barryvault` user protects the store's integrity, the daemon's
  memory, and its code. It does **not** keep a secret from an agent running as
  you once that secret has been resolved into a session: resolution hands the
  session its declared values by convention. Treat a declared secret as readable
  by the session you handed it to.
- A bag service that opens a vault can decrypt every item in that vault, not only
  the ones it declared. Give a service its own vault when that matters.

For the full boundary analysis and the reasoning behind these limits, read the
[vault bag README](../bags/vault/README.md).
