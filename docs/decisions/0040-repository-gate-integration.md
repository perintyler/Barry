# ADR 0040: Integrating repository gates with the comment pass

## Context

Step 18 lands the single local static-gate manifest, syntax lint, pinned public workflows and retired projects graph. Step 21 adds citation validation, a strict library console policy and comment corrections. Both changed the earlier command-chain runner and verifier workflow.

## Decision

Keep Step 18's landed gate manifest, formatter scope, recommended syntax lint, test matrix, package graph decision and completed status. Add the citation check to the manifest and local runner, including its actual regression tests. Preserve Step 21's logger policy and source corrections. Delete the retired per-area workflow rather than restoring it for a historical comment edit. Keep tool-guard behavior from the formatted landed source.

## Consequences

All required checks run from one local gate; public workflows invoke it, while private Actions stay disabled. Integration needs its own frozen install and fresh local validation. No edit splits the frozen CLI main or session-runtime paths.

## Preserved original completed-task wording

The completed Step 18 task named the retired package path as historical evidence. Its wording now describes the dissolved database package without treating that old path as a current dependency. The acceptance requirement is unchanged.

```text
- [x] `tsconfig.projects.json` type-checks four of 44 packages while `pnpm -r typecheck` does the rest, and the root `vitest.config.ts` comment cites a dissolved `packages/db`: reference every package in one `tsc -b` graph or delete the projects file (HYG-30).
```

Original source is master `9d38802ea9e26c4aa275f4522bcc80ec87949612`; its implementation and verification remain in the landed Step 18 record.
