# Workflows

The workflows bag supplies Barry's runs console, signed tool controls, declared SQLite store and authenticated peer bridge. The independent [runtime](../../sdk/README.md) owns durable execution.

## Try it without touching your Barry instance

With Node 26 active:

```sh
pnpm --dir bags/workflows preview
```

Open the printed URL and sign in with `local-preview`. Preview creates an isolated scratch store, runs real child-process examples and never enrolls peers. Its scratch database is retained for inspection.

The console has URL-backed ID-prefix/status/type/time filters, keyset run pages, pinned artifacts/principals/revisions, queue eligibility reasons, separate physical-attempt tables, lazy payloads, byte-bounded filtered event history, event/step links and worker capabilities. Start, signal, cancel and compatible resume preserve retry metadata across reloads without saving sensitive drafts. Keyboard tabs, labelled dialogs, narrow layouts, XSS text rendering, late-response guards and a real accessibility audit have browser tests. A disconnected view retains its last known state.

Browser login is explicitly the shared-secret `local-operator`, not an individual identity login.

## Barry configuration

Enable the builtin bag and use `barry service status` to find `workflows.runtime`. Barry assigns the port; `BARRY_SECRET` is required. The builtin `echo` v1 accepts:

```json
{"message":"Hello","delayMs":0,"waitForSignal":false}
```

Signal name: `continue`. Starts return HTTP 202 before interpretation. Preserve start/signal IDs when an acknowledgement is lost. Cancel/resume tools require a stable request ID and the inspected revision. A terminal run never resumes.

Restricted tools fail closed without engine-verified identity propagation. Declare `BARRY_WORKFLOW_ACTOR_KEY` (at least 32 characters) in the installation secret bindings used by engine and service, and `BARRY_WORKFLOW_POLICY` to an absolute JSON policy file:

```json
{
  "alice": {
    "types": ["echo"],
    "operations": ["start", "list", "get", "history", "signal", "cancel", "resume"],
    "payloadRead": false
  }
}
```

The engine signs short-lived operation/request-bound assertions only after normal identity and bound checks. The service checks current policy on each request and enforces principal visibility. Payload permission is independent; summaries and receipts do not include input/successful output. Dispatch/heartbeat recheck current initiating-identity permission. Revocation prevents future authority but cannot undo a sent effect. Application children receive neither signing key nor service secret.

Privileged Barry tool activities and remote scoped-effect delegation are **not enabled**. Do not add a generic arbitrary-tool activity or pass service credentials in inputs.

## Immutable definitions

`BARRY_WORKFLOW_MODULE` now names an absolute **JSON manifest**, not an executable module:

```json
{
  "workflows": [{"path":"/srv/workflows/greet.mjs","type":"greet","version":"1"}],
  "activities": [{"path":"/srv/workflows/greet-activity.mjs","type":"greet@1","version":"1"}]
}
```

Bundle trusted authored code with the runtime's `/build` API and dependency-free `/dsl` entry. No application code is imported into the owner. Keep artifacts required by open runs/backups. In-place digest changes are refused.

Other machines run this owner's activities as workers. On the owner, `barry workers invite <name>` prints a join token (it carries the owner's https address from `hosting.yaml` and a worker credential, shown once); on the worker, `barry workers join <token>`, then restart its `workflows.runtime`. Linking is one-way: the owner stores only a hashed credential, the worker stores the owner's address and the credential. Every invited worker is trusted to run any activity type it advertises. `barry workers revoke <name>` refuses the worker's next call and aborts what it is running; `rotate` issues a new token with five minutes' grace. No workflow request can enroll a worker. Capacity defaults to four (`BARRY_WORKFLOW_CAPACITY`, maximum 100); owner-lane maximum is 16. Changes require service restart.

Workers call `POST /api/worker` over HTTPS with `Authorization: Bearer barry_wk_…` and a body of `{ "request": … }`. The owner derives the worker id from the credential, never from the body, and refuses a worker credential on every other route. Expose `workflows.runtime` on a private tunnel: a public route also serves the runs console and its sign-in page. A copied token is the same worker: a second machine joining with it takes over the session, and the displaced process stays fenced until it restarts. V2 negotiates owner epoch/session/features and artifact compatibility; old v1 workers may deliver existing results but cannot claim new isolated work.

## Operations and validation

`/live` reports process responsiveness; `/ready` and `/health` include scheduler/storage readiness. Draining refuses new admissions/claims but retains cancellation, reads and result/heartbeat service. Shutdown has a 30-second worker drain and a 35-second hard exit. A storage fault is not an authored workflow failure; a shared backoff probe prevents per-run retry storms.

The service is currently the trusted-code portable profile. Hardened OS memory containment is unavailable and fails closed. Owner-local durability is not replication/failover. Set `BARRY_WORKFLOW_ARCHIVE_DIR` explicitly to enable verified daily archives and covered-terminal pruning after 30 days; snapshot deletion stays operator-managed. Recovery requires external owner fencing. See the [runbook](../../sdk/docs/workflows-runbook.md).

```sh
pnpm exec vitest run sdk/src/workflows bags/workflows/src sdk/src/auth/workflow-actor.test.ts sdk/src/nodes
pnpm --dir sdk typecheck
pnpm --dir bags/workflows typecheck
pnpm --dir bags/workflows exec playwright test
pnpm exec tsx bags/workflows/src/load-probe.ts 60
```

Playwright defaults to installed Chrome locally. Set `WORKFLOW_BROWSER_CHANNEL=chromium` after installing its pinned browser for CI. The dedicated CI lane runs peer/browser tests and supports an explicit one-hour probe; use the local probe CLI for overnight runs. Harness configuration is not evidence that those long runs have passed.

The actor key is resolved on each signed request from its installation reference. Unauthored signing keeps identity workflow tools disabled; authored missing values fail closed. Shell values are ignored. Rotation takes effect on the next engine signing and service verification request.

For a private-file binding, add this reference to `barryConfigDir()/barry.yaml` and keep the value in the private `barryEnvPath()` file:

```yaml
secrets:
  BARRY_WORKFLOW_ACTOR_KEY:
    in: .env
```

A Keychain or vault reference may replace the file reference. Both processes use the installation binding; the key is not a workflow service `env` value or a forwarded identity credential.

## Local soak probes

From the repository root, `pnpm test:soak` runs the workflow load probe for 600 seconds. `pnpm test:soak:overnight` runs it for 28,800 seconds (eight hours). Both exercise the local probe; neither invokes hosted CI or establishes a passed long-duration run merely by existing. Preserve the process output and exit status when reporting a completed probe.
