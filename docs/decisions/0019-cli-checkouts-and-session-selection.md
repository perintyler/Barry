# ADR 0019: CLI checkouts and session selection

Status: accepted

## Context

Fetched bag checkouts can contain unique uncommitted work. Scaffolding must keep
package names distinct from import subpaths. Cursor approvals are project-local.
Hook delivery needs a single claimant, and session selection should not infer
another project's identity from the current directory.

## Decision

Reuse durable ordinary bag checkouts and preserve dirty files. Scaffold one SDK
package using the appropriate link or npm range and explicit import subpaths.
Avoid global-sounding MCP disablement claims for project-local approvals. Wait
then atomically claim queued prompts through the session store. Ask the user to
choose a session when no explicit resume ID is supplied. Move full historical
rationale here and retain concise invariants in source.

## Consequences

Checkout reuse protects local work. Package manifests remain valid and approvals
are described at their actual scope. Competing hooks cannot claim the same prompt,
and resume selection remains explicit. This changes comments only; the historical
live-store observations below are not new reproductions of the storage incident.

## Historical source rationale

### cli/src/bags/git-source.ts

```text
/**
 * Fetching bags declared by repo.
 *
 * A bag composes children with `bags:`; when an entry names a `repo`, this is
 * what puts that child on disk. It replaces the git submodules that used to do
 * the job outside Barry's view — `.gitmodules` pinned the commit, `bags:`
 * composed the namespaces, and nothing connected the two, so every child still
 * needed its own `barry install`.
 *
 * Clones are ORDINARY CHECKOUTS in a durable location, not cache entries:
 *
 *   - Durable, because a clone can hold the only copy of uncommitted work.
 *     ~/Library/Caches/Barry is documented as deletable by macOS at any time
 *     (see paths.ts), which is right for regenerable build output and wrong for
 *     a working tree.
 *   - Ordinary, because the point of replacing submodules is that you can `cd`
 *     into one, commit, and push. A detached HEAD that resets under you is the
 *     thing being removed, so nothing here ever discards local work: an
 *     existing directory is verified and reused, never re-cloned over, and a
 *     dirty tree is left exactly as it is.
 */
```

### cli/src/bags/scaffold.ts

```text
  // Both templates name the same package now. They used to differ -- external
  // bags got the `bags-sdk` facade, in-repo bags got `tools` directly -- but
  // the facade and the toolkit are one package, so there is one name. The
  // templates still differ in HOW they depend on it: npm bags get a published
  // caret range, local bags get a `link:` into this workspace.
  // Two names, deliberately: a dependency KEY is a package name, an import
  // specifier may be a subpath. The merge made them differ for the first time,
  // and conflating them writes a package.json naming a package that does not
  // exist — pnpm rejects it with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND on the
  // scaffolded bag, far from here.
```

### cli/src/commands/cursor.ts

```text
  // There is deliberately no `mcp disable` pass here. It used to run one, and
  // reported "disabled: barry" every time, but Cursor stores MCP approvals per
  // project (~/.cursor/projects/<slug>/mcp-approvals.json) keyed by the cwd of
  // the command — so it only ever disabled Barry for whichever directory the
  // user happened to run setup from, while printing a global-sounding claim.
  // `barry session start --cursor` is unaffected either way: it runs in its own
  // temp project with its own mcp.json and --approve-mcps.
```

### cli/src/commands/hook-record.ts

```text
/**
 * Hold for a message queued against this session, or null when none arrives.
 *
 * Wait, then claim — through the session store itself. The wait only says a
 * message exists; the claim (`pop`) is what removes it, so two hooks racing
 * at the same turn-end cannot both deliver it. This used to ask the API for
 * `/prompts/wait`, a route the API does not have: every hold ended in a 404,
 * and nothing queued for a tracked session was ever delivered.
 */
```

### cli/src/commands/resume.ts

```text
/**
 * Ask which session to resume.
 *
 * The ONE way `barry session resume` picks a session when given no id, for every
 * agent. It used to be the opencode path's private helper while the native path
 * (claude/cursor/codex) inferred one from the working directory via
 * `getMostRecentSession(process.cwd())` — which attached a DIFFERENT project's
 * session id and traits whenever the cwd was a parent of where sessions actually
 * ran. Measured on the live store: from `~/repos` it picked a `~/repos/barry`
 * session; from `~/repos/bags` it picked one under `external coding actions/`.
 *
 * Inference is gone; the user chooses. Returns undefined only when there is
 * nothing to choose from, so callers can start fresh instead of failing.
 */
```
