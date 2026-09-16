# Barry local install Brewfile
# Default dependencies for Barry's supported macOS runtime and common workflows.
#
# Usage:
#   brew bundle              # Install all dependencies
#   brew bundle check        # Check if all dependencies are installed
#   brew bundle cleanup      # Remove dependencies not listed here

# ─── Core Runtime Tools ──────────────────────────────────
brew "node"                  # Homebrew Node; currently satisfies .node-version (26.x)
brew "pnpm"                  # Workspace package manager
brew "jq"                    # Required by drift checks and QA scripts
cask "claude-code"               # Claude provider CLI
cask "codex"                 # Codex provider CLI
# OpenCode: installed via pnpm (pnpm add -g opencode-ai), not brew

# ─── Local Services ──────────────────────────────────────
# Postgres CLIENT tools only (psql, pg_dump) for `barry psql` and
# `barry db backup`. The SERVER runs in the OrbStack container, never on the
# host — `scripts/install` only ever reaches it with `docker exec
# barry-postgres`, so a host server would be installed, started and unused.
#
# Unversioned on purpose. pg_dump refuses a server NEWER than itself
# ("aborting because of server version mismatch"), so a pin silently becomes a
# backup outage the day the container image moves ahead of it. A newer client
# against an older server is fine, which is the direction an unpinned formula
# keeps you in. This entry previously read postgresql@16 while the container
# served 16 and the host binaries were 18 — the pin had been wrong for months
# without anyone noticing, because nothing here reads it.
brew "postgresql"            # psql + pg_dump; the server lives in the container
brew "go"                    # Required to build the local Caddy binary
cask "orbstack"              # Runs the Postgres container (see docs/datastore.md)
brew "cloudflared"           # Cloudflare Tunnel connector for prod ingress

# ─── Common Workflow Tools ───────────────────────────────
brew "gh"                    # Used by Barry's GitHub and PR workflows
brew "swiftlint"             # Lints the macOS Swift packages
