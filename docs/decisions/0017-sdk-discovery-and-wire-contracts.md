# ADR 0017: SDK discovery and wire contracts

Status: accepted

## Context

Action catalogs, builtin discovery and service-address resolution have distinct
owners. Bundled tools can contain multiple SDK copies, so module identity cannot
serve as a wire discriminator. Historical explanations belong with the decisions.

## Decision

Resolve skills through the action catalog and retain the direct parser subpath.
Reuse the caller-owned loaded bag set across turns. Discover nested bag manifests
from the filesystem and reject duplicate manifest names. Resolve service addresses
only from the selected instance registry. Keep the MCP result marker in the global
symbol registry, independent of package names, with an explicit wire version.

## Consequences

Discovery avoids duplicate per-turn handshakes and stale aggregate manifests.
Absent service registrations fail rather than route to another instance. Bundled
SDK copies recognize MCP error results across package renames. This change moves
comments only and preserves the full historical rationale below.

## Historical source rationale

### sdk/src/actions/index.ts

```text
// `parseSkillFile`, `listAllSkills` and `findSkill` used to be re-exported here
// and had no consumer anywhere — the SKILL.md surface is reached through the
// actions catalog now, which reads a SKILL.md dir AS an action. The module
// itself stays (71 third-party SKILL.md files live under .skills/, and remote
// bags ship their own), and so does its `./skill-catalog` subpath for any bag
// bundle that wants the parser directly.
```

### sdk/src/actions/plugin-mount.ts

```text
  // Bags are RECEIVED. This runs on every session turn, so the caller must
  // hold ONE loaded set per process and pass it — re-loading here would mean
  // an MCP handshake per turn per remote bag with `resources: true`. That
  // memoization used to live behind loadBagRegistrySnapshot(); it now lives
  // at the caller, which is where the process lifetime actually is.
```

### sdk/src/bags/bag-resources.ts

```text
/**
 * Where a bag service listens, from this instance's service registry.
 *
 * Throws, naming the service, when the registry does not list it. There is no
 * fallback address: a fallback is some other instance's port (prod's, from a
 * contributor instance), which is how traffic used to leak between them. A
 * process that wants another instance sets BARRY_HOME.
 */
```

### sdk/src/bags/builtin.ts

```text
/**
 * Every bag under `root`: each folder holding a `bag.yaml`, keyed by the name
 * its manifest declares, with its path relative to `root`.
 *
 * A folder is registered because it is there, not because a list names it:
 * the collection manifest that used to list them went stale whenever a bag was
 * added. A bag inside a bag (filesystem's locks, sessions' extensions) is
 * found the same way. Two folders declaring one name is an authoring error.
 */
```

### sdk/src/tools/define-tool.ts

```text
// Bundled bags may contain another copy of this module, so identity has to
// come from the global symbol registry rather than from module identity.
//
// The key deliberately does NOT contain the package name. It used to
// ("@barry-rocks/tools/mcp-result"), which made renaming the package a silent
// wire break: a bag bundled against the old name mints a key the host does not
// recognize, `isMcpResult` returns false, and `register.ts` re-serializes the
// result as a plain text blob -- turning `isError: true` into a success with
// nothing thrown or logged. The name is a packaging detail; the wire contract
// should not move when it changes. `.v1` is the handle for changing this
// shape on purpose later.
```
