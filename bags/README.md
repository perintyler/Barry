# bags

Barry's own bags. Every folder here that holds a `bag.yaml` is registered when `barry setup` runs; nothing lists them. A bag inside a bag (filesystem's `locks` and `tracker`, sessions' `extensions/search`) is found the same way.

The base identity is `identity.yaml` at the repository root, named `base`. It grants artifacts, bash, filesystem, instructions and sessions to every session, and declares the bounds Barry ships without applying them. The packed list below follows that file.

## Packed bags

<!-- packed-bags:start -->
- [actions](../bags/actions)
- [artifacts](../bags/artifacts)
- [bash](../bags/bash)
- [decisions](../bags/decisions)
- [embeddings](../bags/embeddings)
- [events](../bags/events)
- [filesystem](../bags/filesystem)
- [identities](../bags/identities)
- [instructions](../bags/instructions)
- [mcp](../bags/mcp)
- [memory](../bags/memory)
- [nodes](../bags/nodes)
- [schedules](../bags/schedules)
- [sessions](../bags/sessions)
- [telemetry](../bags/telemetry)
<!-- packed-bags:end -->

An identity inherits it unless it names another parent:

```yaml
name: my-agent
inherits: base
bags:
  - git
```

Each child owns its data and chooses its credential bindings and any model preferences. Add bags or overrides only where the child differs. Parent restrictions remain effective, and a child's bounds can narrow access further.

`vault` and `workflows` ship here but the base identity does not pack them.

## Workspace package names

Bag packages use `@barry-rocks/<directory>-bag`; adapter packages use the singular kind followed by their adapter name. Composition roots use their role suffix (`-service`, `-api` or `-runtime`). The local monorepo check derives names from paths and rejects collisions. `pnpm workspace:generate` rebuilds the tracked inventory from workspace globs; `pnpm workspace:check` verifies it without changing files.

The SDK and adapters remain linked-only under the owner’s provisional publishing decision. Their manifests are private, and private workspace versions are `0.0.0`; these are not release-stability promises. No package publishing or release tag is enabled by this work.

The root retains the old `@barry-rocks/sessions-bag` name as a workspace alias to `@barry-rocks/sessions-bag` for one release, because the external supervisor still consumes its process-liveness entry. This uses the documented [pnpm workspace alias](https://pnpm.io/workspaces#referencing-workspace-packages-through-aliases). Keep the alias through the next Barry release sync and remove it only after that consumer migrates. Other external checkouts remain untouched.

## First-party bag contract

`pnpm bags:lint` checks the actual workspace manifests. First-party bags use plural `stores`, omit `bag.yaml` release versions, extend the root TypeScript configuration, provide a `typecheck` command and README, and import the TypeScript Vitest base when they have a custom configuration. Executable TypeScript belongs under `src`; root entry files only re-export it. Declared browser assets and hook/script entry points keep their runtime paths.

Each SQL migration history is compiled to `<bag>/src/generated/<history>-migrations.ts`. Store aliases sharing one authored history share its catalog; the artifacts `default` store therefore uses `artifacts-migrations.ts`. The host-owned peers and workflow execution catalogs are explicit SDK composition boundaries: their authored SQL remains in the owning bag, and the SDK that executes those stores consumes the generated catalog. `pnpm stores:check` verifies every catalog against its authored SQL.

The nodes bag owns the `peers` declaration and authored migration history, exposes the installation's worker/owner store view, and tests persistence across fresh SQLite handles without returning credentials. Its runtime registry implementation is shared with the host rather than duplicated. All workspace consumers of the MCP protocol SDK declare the same version.
