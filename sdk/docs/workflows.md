# Durable workflows

Standalone TypeScript runtime for a fixed local owner and distributed activity workers. The isolated artifact ABI currently supports Node 26. Dependencies: Zod, esbuild, tsx and Node's SQLite. No Barry imports.

How Barry links other machines as workers and runs bag jobs on them is in [distributed work](distributed-work.md).

## Production composition

Use `ProcessExecutor`, `inspectArtifact`, `connectOwnerV2` and `owner.pump()`. The owner loads declarative metadata, never application modules. Generators are written with the DSL in `src/workflows/dsl.ts` and bundled with `buildArtifact` from `src/workflows/build-artifact.ts`; neither is a package entry, so only the SDK's own code and tests use them. The builder refuses overwrites and external imports. Bundles export `definitions` and/or `activities`.

```ts
import { WorkflowOwner, ActivityWorker, ProcessExecutor, inspectArtifact,
  connectOwnerV2, dispatchWorkerRequest } from "@barry-rocks/sdk/internal/workflows";

const evaluator = new ProcessExecutor({ profile: "portable", maxChildren: 2 });
const executor = new ProcessExecutor({ profile: "portable", maxChildren: 4, heapMiB: 256 });
const workflow = inspectArtifact("/absolute/greet.mjs", "greet", "1");
const effect = inspectArtifact("/absolute/greet-activity.mjs", "greet@1", "1", false);
const owner = new WorkflowOwner({
  id: "owner-a", path: "/absolute/jobs.db", artifacts: [workflow],
  activityArtifacts: { "greet@1": effect.digest }, executor: evaluator,
});
const worker = new ActivityWorker({
  capacity: 4, artifacts: { "greet@1": effect.digest },
  activities: { "greet@1": executor.activity(effect) },
  connections: [connectOwnerV2(owner.id, async request =>
    dispatchWorkerRequest(owner, "worker-a", request))],
});
owner.start({ id: "greeting-001", type: "greet", version: "1", input: "Ada" });
const timer = setInterval(() => {
  void owner.pump().catch(console.error);
  void worker.tick().catch(console.error);
}, 250);
// Shutdown: clearInterval(timer); await worker.drain(); await executor.close();
// await owner.drain(); owner.close();
```

A false worker drain means transport/execution did not quiesce: terminate the process without deliberately closing storage beneath pending callbacks. Network adapters must enforce their own RPC deadlines. Bind the worker identity to authenticated transport, never a claimed request field.

The older `definitions`/in-process activity adapter remains for deterministic tests and explicitly trusted embeddings. It cannot preempt loops. Production and preview use isolated execution.

## Authoring and execution

Workflow definitions are synchronous generators. Use `activity`, `sleep`, `signal`, recorded `now`/`random`, and `all` (at most 100 leaves, preserving declaration order). Catch failures around yields for compensation. Throw `ActivityFailure` from an activity for a nonretryable failure; other exceptions follow the authored retry policy.

Bundle dependencies into a closed ESM artifact. Workflow inspection rejects ambient clock/random, process and network APIs; every fresh evaluator replays recorded definitions/outcomes. A mismatch blocks rather than rewrites history. The child imports the exact verified bytes. Type/version digests are immutable; incompatible code needs a new version. Activity names such as `resize@2` pin a separate exact digest on owner and worker.

Start/signal/result responses mean durable acceptance, not completed interpretation. A run may be running with no commands yet. Durable due rows survive process loss. Evaluators propose outside transactions; the owner rechecks revision, reservation, status and deadlines before committing.

The portable profile uses two-second evaluator watchdogs, a 128 MiB V8 heap target, fresh children, bounded IPC and logs. Activities use independent children and their attempt deadline (256 MiB heap target in the service). Child slots remain occupied through observed exit. Evaluators can read only their bootstrap/artifact and cannot access the network; activities additionally have network access. Neither receives filesystem-write, child-process or native-addon permission. Minimal environments exclude Barry credentials.

These are trusted-code defenses, **not hostile-code containment or a hard whole-process memory cap**. Native allocation/host OOM is not contained by V8 limits. The `hardened` profile fails closed: a tested OS resource adapter is not implemented.

Activity context includes stable `idempotencyKey`, attempt, owner/run IDs and AbortSignal. Apply the key transactionally at the destination. Physical attempts may overlap after lease expiry. Cancellation, block, session replacement, restore and timeout fence acceptance; they cannot undo external effects. Worker results are retried in bounded memory, not a durable worker journal.

Hard node/label/digest requirements never weaken. Preferences fall back after two seconds. Advertisements expire after 15 seconds and refresh within five seconds. Independent owner lanes, global physical capacity, persisted candidate cursors, request receipts, idle/error backoff and a pre-execution heartbeat prevent cross-owner overcommit and stale receipt execution.

## Durable operation and limits

SQLite WAL/FULL commits state, history and wake-ups together. A separate SQLite lifetime lock refuses another owner opening the same canonical path; it is released on process death. Hard-linked stores are refused. Use local storage, not shared/network filesystems. Owner wall-clock deadlines remain authoritative across restarts; clock changes affect them.

Forward-only checksummed migrations are shared with Barry's declared-store copy. Unknown schemas/owners are refused. Legacy unpinned runs block; an operator can call `verifyLegacyArtifact(id, revision)` to double-replay and pin an installed artifact, then explicitly resume. This is recorded verification of a replay prefix, not a proof of all future behavior.

Initial cumulative bounds:

- 1,000 open runs, 10,000 unresolved commands, 1,000 leaves/signals per run, 100 leaves per group.
- 256 KiB canonical UTF-8 per payload; 1 MiB aggregate group payload/control envelope; 2 MiB internal record; 32 MiB replay.
- 64 MiB reserved retained bytes per run and 1 GiB owner reservation budget, including conservative outcomes/retry metadata. These constraints can reject work well below the count ceilings.
- Actual store/WAL high water at 80%, recovery below 70%, plus free-space reserve at admission. Closed-run reservations shrink to retained data plus control-receipt allowance.
- 100 registered workers, 16 owner lanes per worker, four default physical slots; 64 operator receipts per run.
- V2 job pages: 50 default/100 maximum, filter/principal-bound keysets; commands and attempts paginated independently. Public HTTP summaries omit input and successful output.
- Lifetime run-ID tombstones: quota 1,000,000; IDs are never silently reused.

Start/signal IDs reject conflicting retries. Cancel/resume receipts are checked before revision preconditions. V2 completion distinguishes accepted, alreadyAccepted, stale and conflict. Claim receipts last through attempt deadline plus a one-minute recovery margin; every recovered task is revalidated before execution.

`prune(cutoff)` performs one bounded terminal-only batch and preserves tombstones; `retentionHold` prevents collection. `WorkflowMaintenance` offers opt-in daily verified snapshots and 30-day pruning only for exact terminal revisions present in the verified archive. It never deletes archive snapshots. Configure operator policy before enabling it; never prune open replay state. Archive history is not an event-sourced rebuild contract.

Use `snapshotWorkflows` and `restoreWorkflows` for verified full-store/artifact recovery in a maintenance child. Restore refuses existing destinations, rotates epoch, fences old sessions/tokens and pauses open runs. Old owners must be externally fenced. A snapshot loses acknowledged work after capture; destination idempotency must cover run lifetime plus backup age and recovery delay. Details and commands remain plaintext on disk.

See [operations and release gates](workflows-runbook.md).
