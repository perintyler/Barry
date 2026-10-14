Run `node --import tsx cli/scripts/verify-nodes.ts` from the repository root with dependencies installed and Node 26.9 or later. OpenSSL must be available.

The script creates three disposable Barry homes from generated legacy SQLite fixtures, migrates each into the store-generation layout (checking identity partitioning, orphan archives, FTS, checksum adoption and that the originals are untouched), and then links them the way two machines would be linked:

- the owner home runs its real workflows service behind an HTTPS loopback edge (what a private hosting tunnel provides), and invites a worker with `barry workers invite`;
- the worker home joins with `barry workers join` and runs its own workflows service, which claims the owner's activities over `POST /api/worker`.

It checks that linking is one-way (the owner keeps only a hashed credential and no outgoing record), that a remote activity is attributed to the worker id the owner assigned, that a worker credential opens `/api/worker` and nothing else, that rotation keeps the old credential for its grace period, that a second machine joining with the same token takes over the worker's session, that a fixture bag's remotable job started through `job@1` is refused on input that breaks its contract and otherwise runs on the worker whose labels it requires (under Node's permission model, bounded to no files), and that revocation refuses the worker's next call and aborts the activity it is running.

Each run prints the location of a JSON report and keeps scratch databases and service logs beside it. It stops its services when finished. Installed Barry homes, services and vaults are not used. It does not exercise separate machines, a real tunnel provider, or model execution.

The distributed hardening scenarios additionally exercise:

| Scenario | Evidence |
| --- | --- |
| Foreground worker | Health endpoint succeeds; console and owner API return 404 with `BARRY_WORKFLOW_WORKER_ONLY=1`. This is the process mode used for Linux worker services. |
| Rotation boundary | The owner's injected clock accepts the old credential at 4m59s and refuses it at 5m01s. |
| Legacy-compatible invitation | The real CLI emits an unscoped nonexpiring v1 token; the frozen master strict decoder accepts it and its credential authenticates against the real HTTPS owner. |
| Unused invite expiry | An explicit `--expires-in 86400` invite emits v2; wire authentication refuses the unused token at its 24-hour expiry; listing retains pending state and audit history. |
| Job scope | A worker advertising the installed fixture job cannot claim it outside `--jobs`; diagnostics include `WORKER_JOB_SCOPE_EXCLUDED` and worker status shows its scope. |
| Worker killed mid-step | A destination commits then holds its response; killing the claiming worker and advancing past its recorded lease retries on the other worker with the same `BARRY_JOB_KEY`, producing exactly one destination effect. |
| Owner edge outage | The HTTPS edge closes, injected owner time advances beyond advertisement expiry, transport failures cause worker backoff, and returning the same edge restores claims without restarting workers or retiring their sessions. |
| Owner restart | Two outstanding, committed effects survive owner SIGKILL; recovered work completes with stable effect keys and one logical destination effect each. Recovered-claim heartbeat revalidation is also directly tested in `sdk/src/workflows/hardening.test.ts`. |
| Worker clock skew | Workers five minutes ahead and behind complete work; recorded attempt timestamps use the injected owner clock and their initial claim-validation heartbeats are accepted. |
| Placement | Named deny bounds leave the step queued with `NODE_BOUND_EXCLUDED` and no attempt. A separate run admitted through a bound trait also keeps its only eligible worker excluded by the recorded grant; unit tests additionally inspect per-worker diagnostics. |
| Capacity and payload | Capacity one holding an effect has no second attempt; a start over 256 KiB returns HTTP 413 `PayloadTooLarge` without admission. |
| Contract pinning | Changing the job input schema under the same version refuses owner startup and leaves the original contract unchanged in the owner's database. |

Fault time is injected through `BARRY_WORKFLOW_TEST_CLOCK` and `BARRY_WORKFLOW_CLOCK_OFFSET_MS`, honored only under `NODE_ENV=test`. Tests advance to recorded boundaries and poll for resulting state; they do not sleep through lease, advertisement, rotation or invite expiry. The local fixture destination deduplicates an effect and its receipt together in one request handler; this demonstrates the destination obligation, rather than claiming exactly-once transport.
