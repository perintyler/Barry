# ADR 0027: Regression evidence boundaries

Status: accepted as comment-only clarification.

Builtin path resolution requires cwd-independent lookup; the focused SDK test
is the automated oracle. The old manual command below is historical guidance,
not evidence of a fresh run. SQLite regression coverage requires independently
opened runtime connections to share one linked library while a writer remains
active. These comments describe test scope; executable test code is unchanged.

## Original CLI rationale

```text
  // NOTE: relative-path resolution for local builtin bags is not tested here.
  // The gate hands a stored path to resolveBuiltinPath, the one function that
  // turns a builtin row's path into a real one, and that is unit-tested in
  // sdk/src/bags/__tests__/builtin.test.ts — including the legacy
  // `../../../../bags/x` form. The failure it guards (2026-09-11: `barry pack
  // point-guard` reported a real, on-disk bag as missing because its relative
  // path was checked against process.cwd()) is verified end-to-end by:
  //   cd /tmp && barry pack todos   # any builtin bag; cwd deliberately elsewhere
  //   # expected: proceeds past the existence check
```

## Original SQLite rationale

```text
    // This used to open a separately linked node:sqlite connection, whose close
    // unlinked the live better-sqlite3 writer's WAL even in this same process.
```
