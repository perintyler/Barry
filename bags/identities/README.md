# identities

Who Barry is when it acts, and what each one may reach. This bag owns the
identity store (identities, the actors behind them, and the traits and bounds
they are granted) and serves it as the `identities.identities` service, REST
under `/api/v1/identities`, `/traits` and `/bounds`. It has no MCP tools. The
CLI (`barry identity …`), the sessions API and the MCP engine use it through this
package's exports; the identities app is a client of the service and lives in
its own repository.

## Entry points

- `server/src/index.ts`: the service. A package of its own
  (`@barry-rocks/identities-service`) because it is a composition root: it
  installs the vendor catalog that default models are checked against, which
  the bag must not name.
- `src/identities.ts`, `src/traits.ts`, `src/bounds.ts`: the routes.
- `src/store/`: `identities.db` in this bag's data directory. Migrations are
  imported TypeScript, not read off disk, so an installed package still has them.
- `src/store/identity-files.ts`: file-backed identities, each a directory with an
  `identity.yaml`. The directory is the source of truth and the database row a
  cache. They live under `<app support>/identities/`, or wherever
  `identities.yaml` says (`barry heir` makes one in the current directory).
  Credentials are declared under `secrets` with `in: keychain`, `in: vault`,
  or `in: .env` (`key:` reads an entry kept under another name, e.g.
  `SENTRY_DSN: {in: .env, key: SENTRY_WEB_DSN}`). File references stay attached to their declaring identity;
  only requested names are read, and credential values are never cached in
  identity metadata. Retired `env` maps and `env_file` caches are rejected.
- `audit`: delegates to `barry identity check`, sharing the secret-reference
  and bag-credential diagnostics. It is reachable as
  `barry identities audit [name]` when the identities bag CLI is enabled.

`/health` is liveness only and never opens the database, so a database blip
does not get a working service restarted.
