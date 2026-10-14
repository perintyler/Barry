# ADR 0036: CLI launch and persistence rationale

## Context

Launch configuration, mounted MCP servers, tool grants and model routing represent different decisions. CLI success messages also need authoritative persisted state and declared build output. Historical explanations obscured these current boundaries.

## Decision

State the invariant beside each operation. Preserve complete original comments below. Resolve no capability grant from a mounted-server count; require explicit bounds to survive failed startup; re-read identity bags before confirming writes; report local-model reliability from model routing. Isolated uninstalls remove only owned service labels, and route publication refuses partial invalid plans.

## Consequences

The source is shorter without changing executable output or removing its decision record. Historical descriptions below are evidence, rather than present-state verification.

## Preserved comments

### Original comment 1: cli/src/commands/start.ts

```ts
/**
 * How a no-traits-selected server list should be described to the user.
 *
 * The banner used to hardcode "(always-on only)" on every empty-selection
 * branch. That was true before the namespace split: the config really was just
 * `ALWAYS_ON_SERVERS`. It is not true now. `generateMcpConfig("http")` writes a
 * single server (`barry`), so the always-on seed contributes ONE key, and every
 * other entry is a namespace granted by the identity's own bags — which the
 * capability picker does not control. Telling someone who selected nothing that
 * they have "always-on only" asserts a security property the code does not
 * deliver: unchecking every trait, and `--none`, do not shrink this list.
 *
 * Under `bag_grant: session` (the default) that security property IS now
 * delivered for TOOLS: the server is still mounted, but its tools are filtered
 * out because no trait grants them. The label therefore has to separate the two
 * axes it used to conflate. Saying "from your barry's bags" alone would now
 * overclaim in the opposite direction — implying a grant that was withheld —
 * which is the same defect with the sign flipped.
 *
 * Derived from the config rather than hardcoded, so it cannot drift from the
 * list it labels the way the fixed string did.
 */
```

### Original comment 2: cli/src/commands/start.ts

```ts
  // `--read` is `--all` under the `readonly` bound. It used to select a shipped
  // composite trait, `read`, whose bag list went stale whenever a bag was
  // added; now it is whatever `--all` grants, restricted.
```

### Original comment 3: cli/src/commands/start.ts

```ts
      // A rejected body used to be swallowed here, so a session could start
      // silently unbounded after `--bound` appeared to succeed. Surface it, and
      // refuse to continue unbounded when a bound was explicitly requested.
```

### Original comment 4: cli/src/commands/start.ts

```ts
      // Resuming — show the picker with the previous session's traits already
      // checked, so they can be accepted with Enter or adjusted. Resume used to
      // skip the picker entirely, which left no way to change capabilities
      // without starting a fresh session.
```

### Original comment 5: cli/src/commands/start.ts

```ts
      // --none: skip trait selection. NOT the same as "no servers" — identity
      // bags still grant their namespaces, so this list is usually not empty.
```

### Original comment 6: cli/src/commands/start.ts

```ts
      // Every packed bag's own trait: what the identity packs, all of it. It
      // used to start every MCP server and select no trait, so the session's
      // grant was only the defaults.
```

### Original comment 7: cli/src/commands/start.ts

```ts
  // Say the unflattering thing before the session starts, not after the user
  // finds out. A small local model often answers in prose instead of calling
  // tools — it reports edits and commands it never ran — and that reads as the
  // agent working until someone checks the disk. Unconditional disclosure
  // rather than a probe: the behavior is intermittent, so a green probe would
  // not mean the next turn behaves.
  // Was `sessionProvider === "ollama"`: ollama is a model provider now, not an
  // agent id, so the check is on the resolved MODEL's routing instead. Any
  // qwen/llama id claude routes to Ollama gets the same disclosure a
  // dedicated ollama agent used to give unconditionally.
```

### Original comment 8: cli/src/commands/start.ts

```ts
  // Every registered bag, loaded ONCE for the three catalog calls below
  // (skills, instructions, slash commands). The catalogs used to fetch this
  // themselves and leant on the loader's process-wide memoization to avoid
  // three loads; holding it here makes the single load explicit instead.
  // Best-effort: a registry that will not load must not block a launch — the
  // three blocks below each degrade on their own.
```

### Original comment 9: cli/src/commands/vault.ts

```ts
    // The session's email, not the account ref's: a named vault's config
    // carries "", so an export of one used to record an empty account email —
    // the one field a restore needs to find the account again. The session
    // read it from Keychain at login.
```

### Original comment 10: cli/src/commands/bag.ts

```ts
/**
 * Re-read the identity and fail loudly if `bags` does not say what we just
 * wrote. Success used to be printed from the write we attempted, which is how a
 * write to the wrong store reported success every time.
 */
```

### Original comment 11: cli/src/commands/bag.ts

```ts
/**
 * Audit every barry's bag list against the state a bag needs to actually
 * work, and optionally repair it.
 *
 * Each check corresponds to a way a bag can be "enabled" while delivering
 * nothing. Trait drift is the one that motivated this command: `identities.
 * metadata.bags` used to be written by four code paths and only one of them
 * registered traits, so a bag added from the macOS app produced sessions with
 * none of its tools — visible nowhere except by comparing the manifest against
 * the traits table.
 */

```

### Original comment 12: cli/src/apps/app-build.ts

```ts
/**
 * Build one app and confirm it produced a bundle.
 *
 * A build that exits zero but leaves no bundle is reported as a failure rather
 * than skipped. The installer used to skip a missing binary with a warning,
 * which meant a broken build looked identical to an app nobody had built yet —
 * and the app silently stayed at its previous version.
 */
```

### Original comment 13: cli/src/commands/uninstall.ts

```ts
/**
 * Which LaunchAgents this uninstall may remove.
 *
 * An instance under `BARRY_HOME` owns only the labels carrying its own
 * instance id; the sweep used to remove every `rocks.barry.*` agent, so
 * uninstalling a dev instance unloaded the installed instance's services.
 * When that instance's record cannot be read, it owns no agents here, and the
 * registration step below removes what it can still name. The machine's own
 * instance keeps the broad sweep, which is what clears pre-instance
 * `com.barry.*` agents.
 */
```

### Original comment 14: cli/src/services/hosting/publish.ts

```ts
/**
 * Publish a plan. Refuses one with errors: publishing the valid half of a
 * broken policy would tear down whatever the broken half used to route.
 *
 * Unchanged routes keep their generation and are not rewritten, so restarting
 * the service management does not make every provider re-apply.
 */
```

