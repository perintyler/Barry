# ADR 0023: harness version compatibility

Status: accepted

## Context

A major-only guard groups all pre-1.0 minor releases together and all monthly calendar releases within a year. The review identified both as wider than the adapter compatibility claim. Stable semantic major releases retain their existing minor/patch tolerance.

## Decision

Compare major/minor for a verified pre-1.0 or four-digit calendar build. Compare major for other semantic builds. Refusal reports the observed build, verified build and applicable version boundary. Preserve the exported function name for existing consumers. Bundled modes, explicit operator override, executable resolution and version caching retain their behavior.

## Consequences

A new Codex minor or Cursor month requires an updated verified build before launch. Patch/day differences remain accepted within the family, but do not establish newly verified guarantees. Missing or unreadable versions remain reported by doctor/preflight; this check does not invent an observed version. Live checks still must establish adapter guarantees on the pinned builds.

## Historical source rationale

The original major-only reasoning is preserved as context; the decision above replaces its compatibility rule.

```text
/**
 * Refuse to start a harness whose installed major version is not the one its
 * modes were verified on.
 *
 * `verifiedOn` used to be read only by `barry adapter` and the conformance
 * check, so nothing stopped a launch on a build the adapter cannot drive: an
 * interactive shell that put `~/.opencode/bin` (1.18.34, no `--standalone`)
 * ahead of Homebrew's 2.0.24 started a binary the opencode adapter could not
 * talk to. The check runs the same `versionArgs` and `versionPattern` doctor
 * does, on the binary the session would start, and compares major versions:
 * a patch or minor drift is doctor's to report, not a reason to refuse.
 *
 * It refuses only on a version it actually read. A binary that is missing, or
 * whose output names no version, starts as before, because doctor and the
 * launch preflight already report both and a check that guessed would refuse
 * harnesses that work.
 *
 * A version is read once per build: it is cached by the binary's real path,
 * modification time and size, so a launch on an unchanged binary costs a stat.
 * Running `--version` takes from 0.1s (claude) to 3s (cursor-agent).
 */
```
