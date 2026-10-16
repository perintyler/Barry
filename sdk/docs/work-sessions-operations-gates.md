# P7 fault matrix and main-owned extensions

This branch is an unqualified proposal from diagnostic v18. No P7 gate is closed.
All tests listed as authored below are **unexecuted** pending an explicit shared
lane lease, pinned Node26.11.1 and isolated dependencies. An observed-current gap
assertion is never a passed required-target recovery gate.

## Acceptance matrix

| Requirement / inventory finding | Authored evidence or exact required drill | Status / limitation |
| --- | --- | --- |
| P7.4/G1 nested/arbitrary inventory, BR1/BR2 | `work-ops.test.ts`: nested stores/WAL/spools/pins, missing worker root, unsafe files, credentials by reference; `work-ops-backup.test.ts`: production `backupManagedStores` in private generation home | Authored; no automatic installed configuration discovery or accepted-reference closure |
| BR5 missing/corrupt `agentArtifact` and runtime chunks | Exact byte/hash/member rejection and unsafe-path tests; remove each pinned runtime/profile/source/output/receipt member in a real coordinated bundle and invoke production restore | Byte tests authored; full bundle refusal drill pending main capture extension |
| G2/G3 split generation and accurate RPO | Capture after owner admission/before destination; restore old owner with newer executor, Sessions, issuer and both brokers separately; each must refuse before any effect, preserve orphan receipt and name mismatch | All filesystem reports remain incomplete/null RPO; positive split-generation detection and production restore acceptance pending core bindings |
| G4 reboot/host change | Journal restart test retains unknown launch/occupancy and prevents a new stage input; API observer must additionally compare current host/boot to retained settlement proof | Journal test authored, metadata-only; native reboot/host proof drill pending. Proposed S1 host tests reviewed, not copied |
| G9 ACK loss / v14 late receipt | `sdk/src/workflows/work-ops-recovery.test.ts` persists same receipt across restart and repeats delivery before ACK, excludes new stage input; diagnostics report pending receipts and owner/resource reservations | Authored journal contract test; native owner/host shutdown/upgrade with both actual brokers remains pending |
| G5 real older-schema upgrade | `work-ops-upgrade.test.ts` creates historical v4 DDL from commit8542c1dbf with valid retained receipt and unknown-launch rows, then opens current journal and checks delivery/custody/no new stage. Remaining drills: actual old writers, v3, Sessions013–026, runtime and accepted-work, retained old runtime, newer-schema refusal | Historical-schema test authored; full in-flight binary/installation upgrade remains pending. S1's drop-tables/current-DDL journal test is not proof of a historical writer. Its populated Sessions021–026 test is a candidate for main review, not reused |
| WAL loss/corruption | `work-ops-diagnostics.test.ts`: actual WAL with committed row, sealed online backup, unchanged source bytes/no new source sidecars, corrupt database digest refusal | Authored; real production managed backup path also authored separately; power-loss/native acceptance pending |
| ENOSPC/SQLITE_FULL at admission, receipt, settlement and spool rename | Disposable filesystem/quota or VFS injection at each actual write. No ACK before durable commit; same operation resumes or remains visibly unknown; no receipt/custody deletion | Design only; fault-control extension required. Do not fill the shared host disk |
| Clock jump ±1h, sleep/reconnect | Hold one native segment and same request/effect IDs; inject independent wall/monotonic clocks and same/changed boot; assert no new input, preserved custody, explicit deadline outcome and schedule occurrence identity | Design only; fake timers alone do not qualify native suspend behavior |
| G6/G7 retention / retirement | Fail archive while open work, unknown receipt, failed projection and backup pin exist; run restartable reference-aware cleanup; each dependency retained; actual 10k workload checks bounded growth | Design only; no production cleanup/retirement implementation in this scope |
| P7.2/P7.3 matched budgets and soaks | Baseline-matched full transport/harness workloads; separately leased 10k completion, 1h mixed and 8h restart/reconnect runs, recording CPU/RSS/WAL/CAS/spool/queue/receipt growth and reservation counts | Not launched; each needs a separate explicit lease and approved fault harness |
| P7.5/G10 standalone operations | Repository CLI runs without workflow service; sealed diagnostic roles cover executor, Sessions, runtime and both brokers; runbook names durable paths and pressure/recovery actions | Authored; installed registration and queue/age/readiness/freshness contract pending |
| P7.6/G8 custody/credentials | No payloads/credential values in reports; reference-only credentials; isolated fixture credentials; backup/spool/log scan with unique dummy canary credential plus permission/symlink tests | Reference tests authored; full canary/security/installation drill pending |
| P7.7 | Actual browser/API/CLI failure-state journeys and multi-node restrictions | Main/P5/P6 integration gate, not claimed by these local helpers |

## Precise extension requests (main-owned)

1. **Authoritative installed discovery and CLI registration.** Composition roots
   should expose every managed generation, configured process/Sessions worker,
   issuer (including never submitted), catalog, both broker IDs/paths, credential
   custodian references and immutable cross-store bindings. Feed a versioned
   validated result to P7; arbitrary user JSON remains an observation. Add central
   registration only after reviewing `work-ops-cli.ts` exit semantics. See
   `workflow-work-worker.ts`, `workflow-runtime-installation.ts`,
   `sdk/src/workflows/work-agent-profile.ts` and `work-process-host.ts`.
2. **Coordinated capture and custody closure.** Extend main's
   `sdk/src/workflows/work-recovery.ts` and `recovery.ts` format/writer fence to
   include Sessions stores, runtime generations, accepted-work and spools, not
   just the existing executor/issuer/broker roles. Under that fence establish
   owner/generation/installation/worker/attempt/resource bindings, conservative
   capture point, catalog/profile/runtime closure, `agentArtifact`, pins,
   stage output, receipts/late evidence, and external custodian references.
   Missing/extra incompatible stores must refuse before publication. Add
   restore verification of the same closure before any mapping/service startup.
   P7 intentionally does not mint a parallel shared recovery format.
3. **Mixed-generation and host-change recovery.** Preserve original stores and
   unknown reservation state. Main's restore/fencing/activation path must reject
   unsupported store cuts and retain post-capture/orphan receipts; any future
   operator decision requires bound evidence, actor/reason/residual risk and
   append-only audit. Current `WorkflowDestinations` native proof and API
   `workflow-process-recovery.ts` checks must stay intact. A manual DB update or
   old PID signal is not an implementation proposal.
4. **Versioned side stores / upgrade protocol.** Review S1's proposed
   `workflow-runtime-registry.ts` and `workflow-work-sessions.ts` versions with
   main; require populated historical fixtures, transactional migration,
   unknown-version refusal, retained old runtime routing and documented drain
   state. Journal older-schema tests must verify valid records, not just DDL.
5. **Observability and fault controls.** Main-owned stores should provide bounded,
   versioned read-only queries for queued/receipt ages, occupancy, drain/admission,
   storage growth, freshness and model health without constructing a service or
   advancing a delivery cursor. Add scoped disposable commit/spool fault points
   and separate wall/monotonic/host identity injection for acceptance tests.
6. **Retention and lifecycle.** Implement reference-aware, audited, restartable
   retirement covering backup lifetimes and all accepted custody. Retain unknown
   executions and both brokers until positive settlement. No source-side deletion
   is proposed here; indefinite pins and unbounded growth remain visible gaps.

## Operations branch overlap disposition

Preserved S1 proposal `acd37ff97fe3132ab6cf28bcdd72edd6fd82c951` descends from
review v16 `ad868efce5c333201946166b89abbd016fc4fe67`, not this v18 test tree.
Its exact DB diff was inspected: added nested allowlists and evidence-tree
copying, recursive backup reporting, nested restore names and RESTORE.md changes.
Those changes improve coverage but do not establish a cross-store frozen cut,
arbitrary worker discovery, external keys, full retained authority homes or
accepted-reference completeness. Main disposition is required before any reuse.
No DB CLI production changes or S1 tests were copied in this proposal.

S1 host/boot tests exercise proof refusal and retained blocking (useful), while
export/method-name absence tests describe gaps rather than target acceptance.
Its journal upgrade fixture initializes current schema, removes newer tables and
restamps `user_version`; this does not prove an actual historical writer upgrade.
Its populated Sessions021–026 migration fixture is useful bounded row/trigger
evidence, but uses in-memory SQLite and no native continuation. Propose it for
main review alongside disposable WAL/history expansion; do not inherit its
Node26.9 results. Key custody and side-store production edits remain main-owned.

v14 retained state had a ceased/uncertain shutdown receipt with null ACK and zero
delivery visits, while owner physical state remained unknown and reservations
held. v18 successor guardian exited before readiness, leaving preparing/null
handle and no cessation proof. These observations are preserved failures, not
permission to release capacity or weaken assertions. Full CLI qualification
remains blocked by the main diagnostic; P7 does not fix guardian lifecycle.

## Preserved proposal review boundaries (S1-P1–P4)

The coordinator's `p7-proposal-review-supplement-2026-10-15.md` points to the
source-only review of S1 proposal `acd37ff97`. Its findings add these explicit
negative/boundary cases. `cli/src/commands/work-ops-boundaries.test.ts` contains
the authored helper cases below; all remain unexecuted. No S1 patch was applied.

| Finding | Authored helper boundary | Required production acceptance and main-owned extension |
| --- | --- | --- |
| S1-P1 actual configured custody omissions | Configure an arbitrary worker directory outside the bag-data tree; create real SQLite files at the exact source-defined `executor.sqlite`, `worker-lock.sqlite`, `authority/accepted-work.sqlite` paths and separate Work CAS. Explicit roots enumerate them; omitting a root can never produce `complete: true`. This is a layout fixture, not worker provisioning or an installed backup test. | Provision the real installed worker with its actual configuration, private credential reference, host and endpoint brokers, catalog and owner CAS. Resolve those paths from composition, admit work, capture through the production backup path and verify every accepted dependency. Include a configured directory inside `data/sessions` with a non-default name and one outside Barry home. Omit each configured store/CAS/broker in turn: refuse before publication with a named dependency. A hand-created authority file under `workflow-authorities` is not evidence for this requirement. |
| S1-P2 evidence enumeration precedes database capture | Enumerate an old artifact member, then commit a real SQLite registry row referencing later missing bytes. The old members still verify, but completeness/readiness and RPO remain blocked. This tests truthful helper limits, not consistent capture. | Add an explicit disposable capture barrier between evidence enumeration and the database snapshot. Commit a new runtime generation/closure or result/spool receipt there using the real writer. Capture must either block that writer until one frozen cut is complete or include the new referenced bytes and binding. Missing references refuse before backup publication. Repeat at each Sessions/accepted-work/executor/issuer/broker boundary. Compare canonical stored references, hashes, authority generation/record hash, owner epoch and receipt revisions; assert no new provider/model/stage input on isolated inspection. Main owns the writer fence, manifest and hook. |
| S1-P3 evidence-root symlink traversal | An evidence root symlink and a symlinked ancestor both refuse before descendant enumeration; neither a private canary path nor its bytes appears in output. Member verification also refuses the aliased backup root. Original canary bytes stay unchanged. | Exercise the actual backup helper with aliases to an unrelated private directory and verify refusal/no copied canary. Under a main-supported mutation barrier, replace a directory after validation and before enumeration/copy; canonical containment and directory identity must remain bound through capture. Static lstat checks alone do not prove the concurrent replacement case. No ownership or capture-race proof is claimed for the P7 observation helper. |
| S1-P4 unvalidated version-zero adoption | A real version-zero registry with incompatible columns yields an unsupported-schema issue in sealed diagnostics; original database bytes/version are untouched. Diagnostics never invoke a store constructor/migration. | For both runtime registry and accepted-work, seed genuine legacy schemas/rows independently of the new constructor. Include missing `authority_hash`, wrong column affinity/nullability, missing uniqueness/foreign keys, a same-named immutable trigger with the wrong body, malformed stored authority/runtime JSON and future versions. Supported legacy fingerprints migrate transactionally with data intact; unsupported fingerprints refuse before stamping a version or changing journal configuration. Capture DB/WAL/SHM hashes and journal mode before/after refusal. Root owns schema validation/migration; editing `user_version` on a newly created current store does not satisfy this case. |

Run the required-target cases only after the corresponding shared extension is
available in a coordinator-reviewed snapshot and a new lease covers its exact
source and commands. A helper test preserving `complete: false` does not close
installed inventory, migration, capture or restore acceptance. Manual `cp -Rn`
merging of side stores or evidence is not a recovery drill and is not authorized.
