# Work and Sessions operations (P7 proposal, unqualified)

This supplements [workflow operations](workflows-runbook.md). Source baseline is
`6193627a9a3f18bee380ba4ae6dbb15c3ec97840`. The helpers below are repository entry
points, not installed `barry` commands. Main owns registration and integration.
They neither capture nor restore data. Every inventory/file verification reports
`complete: false`, `restoreReady: false`, and no established recovery point.

## Inventory before maintenance

Obtain resolved paths from provisioning/configuration and the active store
pointer. Do not guess the owner's database from the artifact directory. Scope
roots to durable stores and custody directories; avoid recursively searching a
whole home or materialized runtime package trees. Such a scan raced cleanup and
prevented the v14 fixture reaching Stop. An inaccessible, changing or oversized
root is an inventory issue, never an absent dependency.

| State | Where to find it | Custody and handling |
| --- | --- | --- |
| Active generation and identity/node mapping | `app-support/stores/active.json`, resolved generation's `node/` and `identities/` | Preserve pointer, node installation ID, identity mapping, all managed stores and original generation. Reading a pointer does not fence writers. |
| Owner and lifetime lock | resolved `node/workflows/workflows.db`, `.owner-lock` | Lock files are evidence, not proof of a live owner or cessation. Never delete them to gain ownership. |
| Sessions and action projections | identity `sessions/sessions.db`, `actions/actions.db`; configured `BARRY_WORKFLOW_ACTION_PROJECTIONS` paths | Preserve authorities, settlements, input fences, pending outcomes/projections, even when a logical result is terminal. |
| Embedded common executor and host broker | `data/workflows/work-executor.db`, `work-resources.db` | Bind installation, worker and owners; retain unknown occupancy and undelivered receipts. |
| Issuers | `data/workflows/work-operator-issuer.db`, `data/sessions/work-admission-issuer.db`, `data/cli/work-operator-issuer.db`, configured external issuers | Include prepared but never submitted admissions, not just owner-known issuers. |
| Runtime registry and immutable closure | `data/sessions/workflow-runtimes/generations.db`, `artifacts/` including `.executor-retained/` | Qualified and refused generations and accepted record hashes matter; current catalog alone is insufficient. Registry is unversioned at the pin. |
| Registration and execution evidence | same runtime root's `registration-spool/`, `execution-spool/` (`binding.json`, `result.json`) | Contains retained code/probe/output evidence. Treat as sensitive; do not print payloads. |
| Sessions authority homes | `data/sessions/workflow-authorities/<session>/` | Preserve private Barry/Pi/temp homes and references for open work; no retirement command is supplied. |
| Arbitrary Sessions worker | `BARRY_WORKFLOW_SESSIONS_WORKER` configuration's `directory`: `executor.sqlite`, `worker-lock.sqlite`, `authority/accepted-work.sqlite`, per-session authority homes | Accepted-work DB is unversioned at pin. Directory can be outside Barry home. Record owner ID and common artifact binding. |
| Independent common process hosts | configured host `directory/work-executor.db`, its lifetime lock and `artifact_root` | Each host has its own journal; embedded journal remains independently retained. |
| Work CAS, profiles and catalogs | `data/workflows/work-artifacts` (`.owner`, `.executor-retained`), configured catalogs and their artifact roots | Verify accepted profiles, `agentArtifact`, runtime closure chunks, stage outputs/logs, receipts and late evidence, including retained pins after public names disappear. |
| Endpoint broker | accepted/deployed catalog `endpoint_broker.path` and ID | Separate from host broker even on one machine; preserve reservations and owner/attempt/resource bindings in both. |
| Credentials/configuration | delegation key-ring path, worker `credential_file`, actor key, vault bootstrap references, node/service configuration | Inventory by reference and named custodian only. No values, env dumps or secret hashes in reports. Keep encrypted custody separately. Vault DB alone is not bootstrap recovery. |
| SQLite sidecars | each database's `-wal`, `-shm`, `-journal` | Never treat a copied main file with missing WAL as a valid capture. Presence is observed without opening SQLite. |

Create a private version-1 inventory with explicit roots. Each root has a unique
`id`, absolute canonical `path`, `role`, `owner`, and `bindings` naming connected
inventory IDs/owner-worker-broker identities. Allowed roles are `managed`, `data`,
`worker`, `runtime`, `artifact`, `spool`, `catalog`, `projection`, `lock`.
Credentials have `id`, `path`, `owner`, and are never opened. Roots must be
disjoint canonical absolute paths; overlap refuses instead of double-counting
storage. Avoid roots enclosing credentials: the helper refuses these rather than
copying a secret implicitly.

```json
{
  "version": 1,
  "roots": [{ "id": "worker", "path": "/private/disposable/worker", "role": "worker", "owner": "installation-id", "bindings": ["owner", "host-broker", "endpoint-broker"] }],
  "credentials": [{ "id": "worker-bearer", "path": "/private/disposable/keys/worker", "owner": "installation-id" }]
}
```

Under an explicit execution lease, with pinned Node26.11.1 first on PATH and
pnpm12.8.1 in the isolated checkout:

```sh
pnpm exec tsx cli/src/commands/work-ops-cli.ts inventory /absolute/inventory.json
pnpm exec tsx cli/src/commands/work-ops-cli.ts verify-files /absolute/sealed-bundle /absolute/members.json
pnpm exec tsx cli/src/commands/work-ops-cli.ts diagnose-sealed executor /absolute/sealed-executor.db TRUSTED_SHA256
```

Inventory is a bounded filesystem observation (100,000 entries, depth64), not
authoritative discovery. It records no contents, timestamps-as-RPO, or inferred
cessation. Broad roots can consume time and expose path names; keep output private.
Symlinks, hardlinks and special files refuse; a failed root may have partial
observations and always carries an issue.

The member file is a CLI-local format, distinct from the SDK recovery manifest:

```json
{ "version": 1, "scope": "local-file-verification", "members": [{ "path": "agentArtifact", "bytes": 8, "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS" }] }
```

Use independently recorded exact byte counts and SHA256 hashes. Missing or
changed members refuse; traversal, duplicate names and links refuse. Hashes are
not signatures or proof of capture consistency. Unlisted dependencies cannot be
verified. This command does not certify an installation backup or publish a
completeness marker. Exit1 means refusal/failed member checks; exit2 means the
inventory/byte observation finished but recovery completeness remains blocked.
Only sealed diagnostics can exit0, meaning the supported queries ran.

## Standalone pressure and receipt diagnosis

Keep live source bytes and sidecars untouched. Supply an already sealed SQLite
online-backup/VACUUM copy and its trusted digest. The helper rejects every adjacent
sidecar and inspects only a new private scratch copy, checking hash and SQLite
integrity first. It never instantiates an owner, executor, broker or Sessions
service. Scratch cleanup deletes only its newly created directory.

`diagnose-sealed` roles: `executor` reports installation, physical custody by owner,
pending deliveries (including receipts missing delivery rows), late evidence and
claim-inbox counts; `broker` reports broker ID and reservation/token/cost totals
by owner/resource/pool/state (run it for both host and endpoint brokers); `sessions`
reports unsettled segments by owner/phase; `runtime` reports generation counts.
Supported pinned schema versions are executor5, broker1, Sessions26, runtime0.
Unknown/missing tables or versions yield explicit issues instead of empty health.

Counts describe the supplied copy, not current service health. There is no
supported queue-age, receipt-age, free-space forecast, endpoint health or backup
freshness contract here; report those as unknown until main supplies bound
observations. A null ACK or zero delivery visits is retained pending custody, not
proof the owner received a receipt. Never release reservations based on a logical
result, timeout, absent PID or host/boot change.

## Backup and disposable restore

1. Record all inventory roots, credential custodians, versions and exact source
   revision. Resolve required generations/artifacts from accepted records, not
   mutable current registration. A missing accepted artifact blocks recovery.
2. Use the coordinated SDK snapshot procedure in the workflow runbook only for
   its documented common-work scope. Generic DB backup and sequential online
   backups do not establish one cut across Sessions, runtime registry,
   accepted-work, issuer, journals and both brokers. Stop here with a named
   blocker when full inventory cannot be captured consistently.
3. Preserve originals, backup and post-capture evidence separately. Record the
   conservative capture boundary and possible acknowledged work loss afterward.
   File mtimes, command finish time and hash-verification time are not an RPO.
4. Restore only into a new isolated fixture with private credentials, networking
   and model/effect inputs disabled. Verify shared recovery manifests with the
   existing SDK verifier plus every external dependency. Local member checks do
   not replace that verifier. A mixed generation or missing side store must stay
   visibly blocked; never manually map a newer side store to an older owner.
5. Inspect paused admission, exact retained receipt/authority/fence/reservation
   bindings, old-key lookup, outputs and no additional provider/effect input.
   Retain post-snapshot receipts for reconciliation. Lack of an old key is not
   proof it was never admitted. Leave restored generations paused; activation
   belongs to main's separately reviewed procedure and is outside this handoff.

On another host/boot, stored PIDs are diagnostic metadata only. Preserve unknown
segments and capacity. Seek the main-owned, evidence-bound recovery protocol;
do not write cessation rows, clear fences, signal recorded PIDs, or invent an
operator release to make the restore proceed.

## Upgrade, drain and rollback

Record binary/runtime hashes, supported schema versions, current inventory and
active/blocked work before the window. Preserve accepted runtime generations,
catalog/profile bytes, issuer keys by custodian reference and both brokers.
Request a supported admission drain through the owning service; verify drain
state and retained receipt delivery independently. No blanket service stop or
upgrade authorization follows from this document. Unknown drain/physical state
blocks binary/schema replacement rather than erasing evidence.

Rehearse on populated historical SQLite schemas with in-flight, blocked and
undelivered rows. Compare row/reference hashes and immutable-trigger behavior
before/after each migration. Older binaries must refuse newer schemas. At this
pin the unversioned runtime and accepted-work stores prevent that guarantee;
do not substitute editing `user_version` on a current empty DB for an old-schema
test. Main owns the version/migration fix. Rollback never repoints uncertain old
work to a new executor generation, repeats model input or downgrades a store.

## Storage pressure, retention and retirement

If ENOSPC or ambiguous commit occurs, preserve original error, exact paths and
original request/receipt IDs. An ACK requires a durable receipt/owner commit;
retry observation/delivery with the same identity. Reconnect or sleep does not
grant another launch. Correct the underlying storage/time fault through the
operator maintenance process and retain the evidence for reconciliation.

Forecast from measured DB/WAL/CAS/spool sizes and observed growth only. Reserve
repair headroom. Archive failure suspends dependent deletion. No helper here
deletes retained pins, accepted artifacts, spools, old generations, identities,
tombstones, receipts or broker rows. Retirement remains blocked until main's
reference-aware, audited, restartable policy covers open/unknown work,
undelivered receipts, projections, backup lifetimes and credential overlap.
The target retention durations in the design are not permission to remove files.

See the [fault matrix and core requests](work-sessions-operations-gates.md) for
the remaining implementation and acceptance evidence.
