# Documentation

Barry's documentation. Start with the [quick start](quick-start.md); reach for the
rest when you need it.

## Getting started

- [Quick start](quick-start.md): a layered guide to Barry's model (bags, traits,
  bounds, identities, sessions) and your first fifteen minutes, with a glossary.
- [Primitives](primitives.md): the reference for bags, traits, bounds,
  identities, sessions, actions, schedules, and instructions.
- [Install](install.md): the linked-checkout and release channels, system
  services, footprint, and removal.
- [Secrets](secrets.md): storing credentials in the vault and giving an agent a
  secret it can use without the model ever seeing it.

## Operating

- [Support](support.md): supported platforms, versions, channels, and data
  retention.
- [Workers](workers.md): linking a second machine so Barry can distribute jobs.
- [Verification](verification.md): what the real-OS checks cover and what they
  cannot.

## Design

- [Protocols](protocols.md): the wire protocols Barry speaks (ACP, AG-UI, MCP)
  and which direction each runs.
- [Decisions](decisions/README.md): the architecture decision records. Each one
  captures a single decision and is cited from the code it governs.

See also the per-area documentation that lives beside the code: the
[SDK docs](../sdk/docs) (bags, bounds, host, workflows, distributed trust) and the
[adapters](../adapters/README.md).
