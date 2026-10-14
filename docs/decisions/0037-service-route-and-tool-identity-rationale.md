# ADR 0037: Service routes and qualified tool identity

## Context

API mount points, transport addresses and tool membership must describe currently implemented services. Historical removals and observations obscured these boundaries.

## Decision

Keep API mounts tied to their owning service, report the Unix socket used by the vault daemon, and gate tools by namespace-qualified ids rather than ambiguous bare names. Preserve the complete source observations below.

## Consequences

Comments describe current ownership and admission without changing executable output. Historical consumer counts and removed-route descriptions remain evidence here, rather than current acceptance claims.

## Preserved comments

### Original comment 1: bags/sessions/api/src/app.ts

```ts
  // `/settings` (6 routes) and the whole `/repos` tree (10) were mounted here.
  //
  // `/settings` was a generic scoped key-value store whose only callers were its own
  // tests, over a table holding ZERO rows.
  //
  // `/repos` is the better lesson: a live consumer is not proof of life. It looked
  // consumed because `Repos.list()` is called by `repo-branches.ts` — but that call
  // sits in `buildBranchesData`, which serves `GET /repos/branches`, and NOTHING
  // called that. The chain was dead one hop further down than the first check
  // looked. Its registry held one row (this repo), and the branches/diff/git-log/
  // file-contents routes had no caller in this repo, any installed bag, or any UI.
  //
  // The `repos` and `settings` TABLES stay: they are created by the identities bag's
  // baseline migration (`001_baseline.ts`), and editing a baseline would diverge
  // from every database that already ran it.
  // `/media` is gone: it moved to the external file-stream bag, which serves the
  // same files on its own port. It had no remaining consumer here, and it was the
  // one route authorizing paths against session working directories.
```

### Original comment 2: bags/vault/src/mcp.ts

```ts
          // The socket, not a TCP URL: the daemon has served only the unix
          // socket since VAULT_DISABLE_TCP=1 became the generated plist's
          // permanent setting, and this tool used to report a URL nothing
          // was actually listening on.
```

### Original comment 3: bags/mcp/src/session-bound.ts

```ts
  /**
   * The same decision keyed by `namespace:toolName`. This is the one to test
   * against when deciding whether a specific tool may run: granting `system`
   * used to admit `git`'s `status` because only the name survived.
   */
```

