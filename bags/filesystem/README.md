# filesystem

The file tools every session gets: `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`,
`Grep`, `LS` and `open`, as `mcp__filesystem__*`. A session must be granted the
filesystem trait or its tools; packing a bag does not grant access.
`Glob` and `Grep` run ripgrep, which `bag.yaml` declares; missing `rg` is an error.

## Entry points

- `src/tools.ts`: the tools (`tools.ts` re-exports it).
- `tracker/`: a sub-bag holding the record of every file change sessions make,
  with deferred tools that read it back (`list_changes`, `get_change`,
  `search_changes`, …). The MCP engine writes it for these tools, and the
  sessions bag's `change-tracker` hook for a harness's own edits. Its tools
  carry the `filesystem` namespace, so it adds none.
- [`locks/`](locks/README.md): coordination between sessions editing one
  checkout. Deliberately left out of this bag's `bags:` list, which would fold
  the `locks` namespace into the `filesystem` trait and give its tools to
  every session.

## What the engine adds

The rules around a write live in the engine, which wraps these tools for every
Barry session (`bags/mcp/src/tool-runtime.ts`). `Edit`, `Write` and `MultiEdit`
require an `intent`, which claims the file through locks. `Edit` and
`MultiEdit`, and `Write` over an existing file, fail unless the session read the
file with this bag's `Read` since it last changed
(`bags/mcp/src/read-tracking.ts`); the harness's own Read does not count.
