# Workflow operations and release gates

This runbook covers fixed-owner, local SQLite, trusted-code portable execution. It does not authorize enrolling peers, deploying a service, changing real credentials, or exercising real effect destinations. Those remain operator actions.

For the additional Work→Sessions stores, runtime/worker custody, standalone sealed-copy diagnostics and fail-closed backup inventory, see [Work and Sessions operations](work-sessions-operations.md). Generic DB backup and an owner-only workflow archive do not establish a complete cross-store installation recovery bundle; the [P7 matrix](work-sessions-operations-gates.md) identifies the remaining gates.

## Before enabling effects

Use Node 26 and a clean frozen dependency install. Run the runtime/HTTP/peer/browser tests and package typechecks. Verify the supported artifact ABI, schema ledger, owner identity and lifetime lock. Unknown schema/owner/digest combinations fail startup; never bypass a ledger checksum to make an old binary run.

Install immutable closed ESM bundles. Workflow code must use recorded commands for nondeterminism. Application executors receive no Barry credentials. The portable profile enforces wall-time termination, framed output/log bounds and Node resource permissions, but does not contain arbitrary native allocation or hostile code. Set `BARRY_WORKFLOW_PROFILE=portable` (the default) or `hardened` for both workflow and activity executors. Hardened requires Linux cgroups v2 and a working systemd user manager; it uses transient user scopes with memory, task and CPU limits. Startup requires a successful bounded systemd scope probe that observes the configured memory, swap, task and CPU limits; a mounted cgroups hierarchy alone is insufficient. macOS owners and workers use portable; hardened is Linux-only. Privileged Barry effect delegation remains disabled. Installed bag job processes use Node permissions and remain portable; selecting hardened does not add OS containment to those job subprocesses.

Choose destination idempotency retention before installation. It must cover maximum run duration (up to 365 days), maximum restorable snapshot age, recovery delay and margin. Prefer permanent logical-effect keys. A retry, process death, timeout or restore can repeat a physical call. Destination data and the deduplication receipt must commit atomically.

## Snapshot and restore

The recovery unit is the complete SQLite database plus every pinned workflow/activity artifact, including builtin registrations. Common work also retains owner-scoped source and input blobs. Supply `--work-artifact-root` when snapshotting those runs; a missing root or blob refuses the snapshot. Verified bundles include dependency evidence and restore the blobs under `work-artifacts/`, preserving namespaces and checksums. History export alone is not sufficient. Prepare a complete JSON artifact manifest in the service manifest shape, with absolute paths and all pinned versions. Protect backup files as plaintext sensitive data.

From the repository, with paths supplied by the operator:

```sh
pnpm exec tsx sdk/src/workflows/maintenance-cli.ts snapshot \
  --owner OWNER_ID --database /srv/workflows/workflows.db \
  --manifest /srv/workflows/all-installed-artifacts.json \
  --destination /srv/workflow-snapshots/unique-new-snapshot
```

The maintenance process uses SQLite `VACUUM INTO`, validates migration/payload/artifact hashes, integrity, foreign keys, attempt fencing and durable wake-ups, and publishes a new directory. It refuses an existing destination. Never copy just the main file while WAL is live. The manifest timestamp is a conservative capture-start boundary, not a zero-RPO claim.

Before restore, stop/fence the old owner and relevant workers. If the old machine is unreachable, revoke its credentials/network/effect authority before activating another owner. A database epoch or the CLI affirmation is not cross-machine fencing.

```sh
pnpm exec tsx sdk/src/workflows/maintenance-cli.ts restore \
  --owner OWNER_ID --snapshot /srv/workflow-snapshots/verified-snapshot \
  --destination /srv/workflows-recovery/new-isolated-directory \
  --old-owner-fenced
```

Restore verifies into a new directory, preserves logical effect keys, rotates epoch, invalidates attempt/evaluation/session state and pauses open runs. Keep networking/effects disabled during rehearsal. Install the bundled artifacts, inspect overdue work and reconcile uncertain effects with the destination ledger. Only then explicitly resume. Ordinary Resume refuses missing/different pinned code. For genuinely unpinned legacy runs, the library's `verifyLegacyArtifact(id, revision)` performs recorded double replay and audit before pinning; it does not automatically enable work.

Acknowledged starts/signals/results and tombstones newer than the snapshot can be lost. Report this RPO to callers; do not automatically resubmit them without reconciliation. Restoring an old snapshot is disaster recovery, not a transparent binary rollback.

## Retention and pressure

Automatic scheduling is opt-in: set `BARRY_WORKFLOW_ARCHIVE_DIR` to an absolute private archive directory to enable daily verified workflow snapshots and 30-day terminal-detail pruning. No live configuration was changed. Every pruned run must match the exact terminal revision/status in the latest verified snapshot; a wall-clock jump cannot make an unarchived run eligible. Archive failure suspends pruning and retries after a minute. A restart creates a new verified snapshot before resuming pruning. Inspect scheduler state at authenticated `/api/metadata`.

Snapshot files are **not automatically deleted**. Budget their storage and retain at least 30 daily workflow snapshots; do not change Barry's global backup policy implicitly. Keep artifacts for the entire backup lifetime. Legal/operator holds use `retentionHold`. Barry's generic database-only backup catalog does not yet bundle these executables: use the workflow snapshot path for recovery.

`prune(cutoff)` is restartable and deletes at most 64 rows per child table from one terminal run per call. It never collects open/blocked runs. It preserves a permanent principal-scoped start tombstone and returns archived summaries for identical starts; conflicting ID reuse remains an error. Pruning removes details, not external effects. Snapshot restoration is the recovery path for deliberately pruned details, subject to the stated RPO/fencing rules.

The owner has cumulative count, replay, logical-byte, receipt and actual-file/free-space bounds. Active runs reserve control space; terminal runs charge retained records rather than a blanket 1 MiB each. Migration 006 recalculates existing accounting in bounded turns, preserving all records and gating new admission until complete. Disk admission also preserves shared repair headroom. Revoked or expired attempts keep physical occupancy until the executor reports cessation; lease expiry alone cannot free a worker slot. Legacy job contracts without pinned node bounds remain owner-local; publish a new job version with explicit bounds to enable remote placement. Capacity refusal does not erase admitted work. Physical high water can persist after pruning because SQLite retains free pages: compact only through an explicitly offline maintenance procedure after snapshot verification. Do not delete open histories or tombstones to free space.

## Readiness, errors and shutdown

`/live` is process responsiveness. `/ready` and compatible `/health` include scheduler/storage readiness. Missing workers do not mean a dead service. Queue diagnostics distinguish incompatible artifacts/capabilities, no advertisements, capacity, retry backoff, signals, timers and blocks.

HTTP errors have code/message/request ID/retryable fields. Busy/storage failures are 503; no raw SQL reaches the browser. Storage failures roll back instead of creating business failures. A shared exponential storage probe controls retry pressure; corruption requires operator recovery. Preserve the original logical request ID across ambiguous responses. Cancel/resume receipts precede revision checks; inspect a 409 before issuing a genuinely new request.

An uncertain commit discards the connection before subsequent receipt reads/retries; the lifetime owner lock remains held. Legacy byte accounting checkpoints 64 rows per scheduler turn and survives restart. `/ready` reports `migrating` and new starts/signals/claims/resumes stay gated until accounting completes; inspection remains available. Index/counter schema migrations still require an upgrade maintenance window.

The browser keeps owner-scoped operation IDs, target/revision metadata and body fingerprints in session storage across reloads. It never automatically saves arbitrary input/signal drafts. Re-enter the exact original payload to retry an ambiguous start/signal; changed data cannot reuse that request identity. Cancel/resume recovery checks receipts before resubmitting. Forgetting browser metadata does not undo a request or external effect.

Authenticated local operators can inspect `/api/audit` for policy-denial aggregates. Records contain verified actor, operation, reason, hashed target, count and the last response request ID, not credentials or payloads. They are retained for 30 days, capped at 2,047 detailed minute buckets plus an overflow aggregate. This bounded operational audit is not a full forensic log.

Shutdown rejects new admissions/claims, continues maintenance and result delivery for up to 30 seconds, then kills remaining executors. The process has a 35-second hard deadline. An incomplete drain exits without deliberately closing storage beneath unresolved callbacks. SIGKILL remains at-least-once recovery, not graceful drain. Owner deadlines use wall time; time jumps and suspend/wake affect elapsed behavior. `/api/metadata` reports wall-versus-monotonic divergences of at least one second; readiness/watchdogs use monotonic elapsed time. Diagnostics do not undo deadline transitions already committed.

## Distributed fault matrix

The [nodes verifier](../../cli/scripts/verify-nodes.ts) runs these faults against separate disposable owner/worker processes behind a loopback HTTPS edge. Its [scenario inventory](../../cli/scripts/verify-nodes.md) describes the fixtures. The expected results below are assertions made by the check, not a claim that an operator's production deployment has passed them.

| Scenario and implementation | Expected result | Operator action when the corresponding failure occurs |
| --- | --- | --- |
| [Worker killed mid-step](../../cli/scripts/verify-nodes.ts#L370) | The recorded lease expires; another worker retries with the same logical effect key. Two fixture requests produce one destination effect. | Inspect attempt/lease history and the destination receipt before manually retrying an uncertain effect. Restore worker availability; preserve destination deduplication. |
| [Owner restarted with outstanding claims](../../cli/scripts/verify-nodes.ts#L405) | Both recovered runs complete with stable effect keys and one destination effect each. [Recovered-claim tests](../src/workflows/hardening.test.ts) separately enforce heartbeat revalidation before execution. | Reopen the same durable owner only after fencing the old process. For snapshot recovery, follow the restore procedure above and reconcile the destination before resuming. |
| [Owner edge outage](../../cli/scripts/verify-nodes.ts#L391) | After advertisement expiry, diagnostics show `WORKER_OFFLINE`; workers back off and resume claims when the edge returns without restarting or retiring their sessions. | Check the private route and connectivity. Restore the edge and inspect worker reconnect logs before issuing replacement credentials. |
| [Worker clock skew](../../cli/scripts/verify-nodes.ts#L425) | Workers five minutes ahead and behind complete their work; attempt timestamps and deadlines use the owner's clock. | Correct host time and inspect owner deadline transitions. Worker skew evidence does not guarantee that owner clock jumps leave deadlines unchanged. |
| [Rotation grace boundary](../../cli/scripts/verify-nodes.ts#L291) | The owner's injected clock accepts the old credential at 4m59s and rejects it at 5m01s. | Transfer the new join command privately and apply it before grace expires. If authentication fails, inspect enrollment/audit state and request a fresh credential. |
| [Placement deny](../../cli/scripts/verify-nodes.ts#L441) and [run-grant node bound](../../cli/scripts/verify-nodes.ts#L446) | The excluded worker gets no attempt; queue diagnostics include `NODE_BOUND_EXCLUDED`. | Compare the recorded run grant and placement with the intended eligible workers. Keep the restriction until an authorized placement change is made. |
| [Contract pinning](../../cli/scripts/verify-nodes.ts#L464) | Changing input schema under the same job version refuses owner startup and preserves the original pinned contract. | Restore the matching artifact/contract or publish a new version. Do not edit the pinned database contract to bypass the refusal. |
| [Capacity and payload bounds](../../cli/scripts/verify-nodes.ts#L452) | A capacity-one worker holding a step has no second attempt and reports `CAPACITY_FULL`; input above 256 KiB receives HTTP 413 `PayloadTooLarge` without creating a run. | Wait for capacity or provision an eligible worker; reduce the input before resubmitting. A refused admission has no run to resume. |

Run from the repository root with supported Node, built packages, installed dependencies and OpenSSL:

```sh
node --import tsx cli/scripts/verify-nodes.ts
```

Retain the printed scratch directory, including `report.json`, per-process logs and databases, along with the command output, revision, platform and Node version. The report names each completed scenario; a `verification` failure means later scenarios were not demonstrated. The verifier stops its fixture services and never enrolls the installed home. Treat captured databases as private evidence and remove credentials before sharing.

These checks do not cover a real tunnel or physical-machine onboarding. For sustained separate-process traffic, the [network load probe](../../bags/workflows/src/network-load-probe.ts) and guarded [soak workflow](../../.github/workflows/soak.yml) retain their own workload reports; short runs do not substitute for one-hour/overnight receipts. Filesystem/commit/OOM faults, owner clock jumps and full disaster recovery with a real transactional destination still require their corresponding acceptance evidence. See the [verification boundaries](../../docs/verification.md) and [unsupported claims](../../docs/support.md#unsupported-and-why).

## Rollout and evidence

Run tests on the exact integrated tree, then snapshot/restore into isolated storage, then a canary against the transactional test destination. Real effect rollout requires operator approval. Roll back a binary only if it supports the already-written schema; otherwise forward-fix. Preserve the prior store/WAL and executable artifacts.

The dedicated CI workflow runs contract, real HTTPS/MCP and browser tests. Manual CI inputs support a 3,600-second release probe; run `pnpm exec tsx bags/workflows/src/load-probe.ts 28800` locally for an uninterrupted overnight probe. The probe uses two owners/two workers, child-process execution, 32 open runs, eight activity slots, 1 KiB payloads and explicitly disposable 30-second terminal retention. It is not a peer-network throughput benchmark. Reports include revision/diff digest, Node/SQLite/OS/hardware, counts, error classes, supervisor memory and p99 read/heartbeat/scheduler timings. Browser traces are retained on failure.

Short passing probes are not soak certification. The first production release still requires the one-hour and overnight runs, extended filesystem/commit/OOM/partition/clock-jump fault matrix, full recovery-with-destination reconciliation, and an accepted supported-workload report. Historical v1 validation is not evidence for newly added guarantees.
