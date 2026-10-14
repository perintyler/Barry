# ADR 0026: Codex stdio MCP environment indirection

Status: implemented on Step 15; final gates pending.

## Context

Step 15 requires stdio MCP secrets in `BARRY_CODEX_MCP_*` environment variables.
Codex's [configuration reference](https://developers.openai.com/codex/config-reference/)
documents `env_vars` as an inherited-name whitelist, with no documented child-key
renaming. Forwarding original names directly would conflate servers using the same
key with different values.

## Decision

Generate a private Node launcher for each stdio server with configured environment
entries. TOML names the absolute Barry Node, launcher, original command/arguments,
and prefixed environment references. The launcher removes inherited Barry MCP
references, restores that server's original keys, and spawns without a shell.
No configured environment values appear in TOML or the launcher.

UTF-8 hex encoding avoids server/key sanitizer collisions. SHA-256 filenames avoid
filesystem component-length limits. The shared writer enforces 0600 files in a
0700 owned parent. Servers without configured environment keep their direct command.

The launcher inherits stdio, forwards SIGINT/SIGTERM/SIGHUP, and propagates child
exit codes or terminating signals. Missing referenced values refuse startup before
launching the child; launch errors use a generic message.

## Consequences and verification

This adds one process. It changes secret placement, not sandboxing: the trusted
Codex parent still holds values in its environment. Configured command arguments
remain unchanged and must themselves avoid embedding secrets.

Actual-child tests cover secret absence from generated files, colliding server
names, distinct original-key values, stdin/stdout/stderr, exit status, missing-value
refusal, private file permissions, and handled termination. Pinned Codex 0.160.1 also completes a real MCP initialization with these
references through the opt-in live regression. Full gates and the other Step 15
mode checks remain required before landing.
