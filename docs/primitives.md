# Primitives

The vocabulary Barry is built from. This is the reference; for a guided
introduction read the [quick start](quick-start.md), and for the authoritative
module and ownership map read [`sdk/docs/modules.md`](../sdk/docs/modules.md).

The whole model reduces to one sentence: an **identity** packs **bags**, which
grant **traits** and may apply **bounds**; a **session** runs under that identity
with the resulting capabilities, optionally invoking **actions** and guided by
**instructions**, with **schedules** running work later.

## The capability model

### Bag

A unit of capability: tools, an MCP server, a store, actions, instructions,
schedules, apps, vault items, or jobs, in any combination. A bag with only
declarations needs no code. You install a bag on a machine and pack it onto an
identity. Bags can contain other bags.
See [bags](../sdk/docs/bags.md).

### Trait

A named grant. Packing a bag auto-generates a same-named trait that enables
everything in it; hand-authored traits compose bags and bounds. Traits only ever
grant; they never restrict.

### Bound

A named restriction that takes capability back along independent axes:
`deniedTools`, `deniedAccess`, `files.deny`/`files.allowOnly`,
`bash.deny`/`bash.denyPrograms`, and `network`. Denials union, allowlists
intersect, and a deny always wins. Bounds are enforced, not advisory.
See [bounds](../sdk/docs/bounds.md).

```yaml
# traits grant, bounds take back
traits:
  debug:
    includes: [datadog, slack]
    bounds: [read-only]
bounds:
  read-only:
    bound:
      deniedAccess: [write]
```

## Who and where

### Identity

A named configuration with its own packed bags, vault, defaults, and generated
command. Identities inherit a base identity (`identity.yaml` at the repo root)
and can narrow it. See [`sdk/src/identities`](../sdk/src/identities).

### Session

One run of an agent: a durable record (transcript, history, searchable) plus,
while live, a handle to the harness running it. Sessions are stored and resumable
regardless of which harness produced them. See [`bags/sessions`](../bags/sessions).

## What actually runs

Barry is not a library you import. After `barry setup`, it is a resident system:
launchd owns a set of long-running services (the MCP host, the sessions API, the
identities service, the scheduler, the vault daemon, and others, depending on
what is packed), each bag's store is a SQLite file on disk, and the `barry`
command plus one generated command per identity sit on your `PATH`. A session
reaches those services; the services open the stores. See
[install](install.md) for the footprint and [`sdk/docs/host.md`](../sdk/docs/host.md)
for how a bag's declarations become running behavior.

## Work and guidance

### Action

A named, reusable unit of work with typed inputs and outputs and a clear
lifecycle (start, end, pause, cancel). Barry's take on "skills," but with defined
contracts rather than loose prompts. See [`bags/actions`](../bags/actions).

### Schedule

A deferred invocation of an action: once, at a time, on a cron cadence, or at
login. See [`bags/schedules`](../bags/schedules).

### Instruction

Standing guidance assembled into a session's system prompt. Static text, in
contrast to a prompt contributor, which computes prompt text at session start.
See [`bags/instructions`](../bags/instructions).

## Supporting vocabulary

A few more words you will meet in the code and other docs:

- **Adapter**: code that binds a vendor to Barry. A *session* adapter launches a
  harness (Claude Code, Codex, Cursor, OpenCode, pi, Antigravity) with Barry's
  tools and hooks installed; *completion*, *embedding*, and *decision* adapters
  wrap model calls. See [adapters](../adapters/README.md).
- **Composition root**: a package allowed to import everything it assembles. The
  CLI, the sessions API, the scheduler, and the identities service are
  composition roots; the SDK is deliberately not one.
- **Instance**: one installation on one machine, with its own id, port
  assignments, and service choices, rooted at `BARRY_HOME` or the default macOS
  paths.
- **System One**: the author's name for fast, non-generative decision calls,
  served by a local daemon or a hosted endpoint with model fallbacks. The
  decision adapters implement it. See [adapters](../adapters/README.md).

## Related references

- [Quick start](quick-start.md): the same vocabulary taught in layers, with a
  glossary.
- [Protocols](protocols.md): ACP, AG-UI, and MCP.
- [`sdk/docs/modules.md`](../sdk/docs/modules.md): the full subject and ownership
  table.
