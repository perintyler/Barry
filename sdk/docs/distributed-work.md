# Distributed work: workers and jobs

Barry spreads work across machines in one way: other installations act as **workers** of this installation's workflows owner. They claim work items, run them, and return outcomes. Nothing else crosses between machines: no sessions, identities, store copies or tool calls. The unit of work a bag declares is a **job**, and a job that meets the rules below can run on a worker.

## The model

- **Owner:** an installation's `workflows.runtime`. It keeps workflow history and decides which worker may take each step.
- **Worker:** any installation that joined the owner. Its own `workflows.runtime` claims steps from the owner over HTTPS, runs them, heartbeats while they run, and reports the outcome.
- **The wire:** one route, `POST /api/worker` on the owner, carrying the worker protocol (hello, advertise, claim, heartbeat, decline, complete). The owner identifies the worker from its credential, never from the request body.
- **Every installation is also its own worker:** steps an owner can run itself never leave the machine.

Delivery is at least once. A worker that crashes or loses its lease has its step retried, possibly elsewhere.

## Linking machines

On the owner:

    barry workers invite mac              # prints a join token, shown once

On the worker:

    barry workers join barry_wj2.…        # then: barry service restart workflows.runtime

- **What linking stores:** it's one-way. The owner keeps only a hashed `barry_wk_` credential and the worker's assigned id. The worker keeps the owner's https address and that credential.
- **Where the address comes from:** the token carries the owner's address from `hosting.yaml`, and `invite` refuses a route behind an interactive login gate. Publish `workflows.runtime` on a private tunnel: a public route also serves the jobs console and its sign-in page.
- **What a worker credential opens:** only `POST /api/worker`. Every other route answers 401.
- `barry workers rotate <name>` issues a new token; the old credential keeps working for five minutes.
- `barry workers revoke <name>` refuses the worker's next call and aborts what it is running.
- `barry workers leave <owner>` stops this machine working for an owner.
- `barry workers list` shows both sides.
- **A copied token is the same worker.** A second machine joining with it takes over the session, and the displaced process stays fenced until it restarts.

Invite only machines you operate. Unused invites expire after 24 hours; `barry workers invite mac --jobs sessions:summarize-session@1` restricts what that worker may claim. `barry workers list --json` includes enrollment and credential audit rows. See [distributed trust](distributed-trust.md) for credential authority, scope enforcement and version 1 compatibility.

## Jobs

A bag declares jobs beside its actions and schedules:

```yaml
jobs:
  reaper:
    description: Close sessions whose OS process is gone
    runs:
      using: node                 # Barry's pinned Node; TypeScript runs as-is
      main: src/reaper.ts
      secrets: [ BARRY_SECRET ]
      env:
        - BARRY_REAPER_DRY_RUN=0
    timeout: 10m
  name-session:
    runs:
      using: process              # exec form, no shell
      command: [ uv, run, jobs/name_session.py ]
  triage-failure:
    runs:
      using: action               # an agent does it: this bag's action, or bag:name
      action: triage-failure
```

A job has two parts:

- **A contract:** `input_schema`, `output_schema`, `requires` (`tools`, `secrets`, `bins`, `labels`), `preflight`, `validate`, `timeout` and `bounds`. These fields mean the same as on an action.
- **What runs it:** `runs.using`, one of `node`, `process` or `action`.

How a job runs:

- **Input and output:** input arrives as JSON on stdin. Stdout is parsed as JSON only when the job declares an `output_schema`; otherwise it is kept as free text.
- `BARRY_JOB_KEY` is the run's idempotency key, stable across retries. `BARRY_JOB_ATTEMPT` counts attempts.
- **Action jobs:** a `using: action` job takes its schemas from the action, which must be a `context: none` agent action.

How jobs are started:

- **From a schedule:** `job: reaper`.
- **From an action:** a `job:` body.
- **From the SDK:** `jobs.run("bag:name", inputs, { key })`. The run's state comes from `get()`, its result from `output()`, and `cancel()` stops it.
- **Over HTTP:** `POST /api/v1/jobs/{ref}/runs`.

Every run is a one-off in the scheduler. That makes it durable before the caller is answered, deduplicated by `key`, and recorded as an action run with trigger `job`. Job runs share a concurrency budget of 8, separate from other one-offs.

**Authority.** A run started for a session (`callerSessionId`, or `run_action` over MCP) acts for that session:

- it gets none of the job's declared secrets;
- a job that declares secrets is refused for it;
- a code job also needs the session's own policy to allow a raw process: Bash, and no bound.

A run with no caller acts with its bag's authority. Over HTTP the caller is self-asserted behind `BARRY_SECRET`, so naming one only narrows a run. MCP is the enforced path.

**Bounds, by kind.** See [bounds](bounds.md) for the bound vocabulary.

| Kind | Under a bound |
| --- | --- |
| `process` | Refused: Barry cannot confine an arbitrary program. |
| `node` | Runs under Node's permission model: `files.allowOnly` paths become `--allow-fs-read`/`--allow-fs-write`, and child processes, workers and addons are never granted. `main` must be one self-contained `.mjs` or `.js` file. A network restriction or `files.deny` is refused, because Node cannot express it. |
| `action` | The agent's session carries the bound, like any action. |

A bounded job cannot declare `preflight` or `validate`: they run as shell commands outside the bound.

## Jobs on other machines

A job can run on a worker when all of these hold:

- it is versioned (`version: 1`), so it is addressed as `bag:name@1`;
- it runs with `using: node`;
- it declares no secrets;
- it is bounded to `files: { allowOnly: [] }`, so it touches no files at all.

Its `main` file is then the whole bundle. Owner and worker pin it by digest, and both must have the same bag version installed.

Each `workflows.runtime` registers the installed jobs it finds:

- **On the owner side,** it pins each job's contract. The owner database keeps the contract even after the bag stops registering it, and refuses a contract that changes under the same version.
- **On the worker side,** it offers the jobs whose `requires.bins` are on PATH and whose `requires.labels` match the worker's labels. Those labels are `os`, `arch` and `BARRY_WORKFLOW_LABELS` (for example `model=local`), set per installation under `services.workflows.runtime.env` in `barry.yaml`.

`barry workers status` lists what this machine offers, and why anything is not offered.

The built-in `job@1` workflow runs one job as one step:

    POST /api/runs  { "id": "…", "type": "job", "version": "1",
                      "input": { "job": "sessions:summarize-session@1", "input": { … } } }

- **At start:** the owner checks the input against the pinned contract before any run exists, and refuses with `InvalidInput` or `UnknownJob`.
- **The attempt timeout** is the job's `timeout`.
- **Output** that breaks the contract fails the step without a retry, recorded as `JobOutputRejected`.
- **Remote job processes** get only the network, the step key in `BARRY_JOB_KEY`, and their input.

**Placement.** A step can carry `placement.nodes: { allow, deny }`. The owner also applies the `nodes` bound of a run's grant. `local` names the owner, and other entries name invited workers by name or id. A worker the bound excludes is never offered the step (`NODE_BOUND_EXCLUDED`).

**First use.** `sessions:summarize-session@1` is the summarizer's model call. With `BARRY_SUMMARY_ON=auto` (the default), each `summarize-sessions` sweep runs the model on a worker whenever one offers the job, and on this machine otherwise. The prompt is built and the summary saved locally. The run id is the session plus its message watermark, so a sweep that stops waiting or restarts reconnects to the same run.

## Backups and restore

`barry db backup` snapshots every store in the active store generation into `stores/<id>/`:

- `peers.db`, which holds the installation id, the identity folder mapping, workers and owners;
- every identity's stores;
- the workflows database, with its pinned job contracts.

`barry db restore <dir>` snapshots the current stores and verifies the backup before stopping the running user services. With them stopped, it prepares and activates a new generation, keeps the previous one, and restarts the same services; system services keep running. Restored workflow runs come back blocked (`RecoveryPaused`) until resumed. Workflow and job code isn't in a backup: it comes from the installed bags.

`barry db rollback` snapshots the current stores and activates a validated copy of the generation the active one replaced; writes since that switch stay in its folder and snapshot, and services restart on the installed code.

`barry db recover` explicitly finishes an interrupted switch; successful restore, rollback and recovery prune older generations, retaining the active generation and its rollback target, and `barry db prune` prunes on demand.

## Unsupported work

See the [support policy and reasons](../../docs/support.md#unsupported-and-why) for the supported platform boundary.

- **Workers you do not operate.** Job scopes now restrict claims, but untrusted workers still need result verification and per-person grants; scopes do not make worker results trustworthy.
- **Remote action jobs.** These would need the caller's grant carried to the worker and prompts pinned by digest.
- **Remote jobs with files or a restricted network.** Node's permission model cannot express those bounds, so such jobs run only where they are started.

See also: [workflows](workflows.md) for the owner and worker runtime, the [workflows bag README](../../bags/workflows/README.md) for operating it, and the [schedules bag README](../../bags/schedules/README.md) for one-offs and job runs.
