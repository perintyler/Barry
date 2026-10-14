# Entities, operations, and ownership

Modules name the subject they operate on. Small definitions can stay in a file. Resource acquisition belongs to an explicit operation; its caller owns the resulting close handle. CLI commands and built-in tool handlers adapt these operations to their interfaces.

| Subject | Entity and operations | State owner and dependency boundary |
| --- | --- | --- |
| Bags | Named capability packages; parse manifests, compose catalogs, load, build, inspect dependencies | Caller supplies a catalog for standalone operations. Installed discovery is application configuration; registration operations live in cli/src/bags/registration.ts |
| Tools | Named operations with input/output contracts; define, register, invoke, truncate results | Handler owns its domain behavior. Authorization is evaluated before invocation |
| Traits | Named capability selections; select defaults, identity and session traits, expand includes and harness branches, compute grants | Caller supplies traits and tool metadata. Packed bags grant nothing unless identity configuration opts in |
| Bounds | Restrictions; merge denials and allowlists, evaluate execution context, refuse prohibited calls | Caller supplies restrictions and named-bound lookup. Bounds never grant tools |
| Identities | Stable key, name, and reusable configuration; normalize configuration | SDK owns normalization. Identities bag owns persisted identity records and its schema. Identities inherit normalized traits and bounds from their parents |
| Instructions | Named guidance; parse, select, assemble prompt bodies and indexes | Caller supplies bags and selection. Instructions own their size budgets |
| Actions | Named work definitions; parse, validate, discover, materialize action commands | Actions bag owns persistent action runs. Shared definition and materialization operations live in SDK |
| Sessions | Durable interaction versus live harness handle; configure, resume, check ownership, launch, route a turn | SDK owns shared harness configuration and launch operations. Sessions bag owns records/history and process reaping |
| Apps | Protocol, attachments, requests, rulings, client connections | Explicit clients own sockets; application registry comes from service discovery. Keep protocol v1 compatible |
| Adapters | Harness, model, decision and embedding contracts and routing | Nested under adapters. Concrete implementations remain separate packages and load on explicit use; installed adapter preparation lives in cli/src/adapters/installed.ts |
| Environment | Declarations and resolved values; validate, read, select exposure | Caller supplies identity definitions and backends. No wholesale ambient secret inheritance |
| Vault | Account references, credentials, cryptography and access | Explicit account operations own remote sessions. Vault daemon retains its separate OS user and authentication |
| Stores | Handles, schema migration, snapshot, restore, backup | Subject owns schema. Generic machinery has no core-configuration migration dependency |
| Workflows | Durable runs, deterministic evaluation, pinned artifacts and activity execution | Explicit owner/worker objects own databases, timers, and isolated computation children. Preserve signed actor authority and drain budgets |
| Nodes | Installation id, identity folders, invited workers and joined owners | Linking is one-way: an owner stores hashed worker credentials, a worker stores the owner address and its credential. Workers reach owners only through the workflows worker endpoint; see [distributed work](distributed-work.md) |
| Services | Instance, service declaration, registration, policy and process observations | Explicit manager owns operation records. launchd owns persistent service processes. Configuration owns its own migrations |
| MCP | Construct a bag server; explicitly start application serving, then close | Entry point owns OS signals. Application owns listeners, transports, connection pools and timers |
| HTTP | Transport requests and failure classification | Explicit calls own timeout cleanup; service listeners have an explicit close handle |
| Barry | Installed application composition | This boundary discovers defaults, installed bags, concrete adapters and OS integration |
| CLI | System or bound identity command surface | System entry clears ambient identity overrides. Generated entry validates persisted identity and instance binding before dispatch |

The dependency direction is subject operations → subject contracts and supporting operations. Subject modules do not import CLI commands to acquire installation defaults. The Barry composition root may use installed configuration and built-in implementations. Generic stores do not own service configuration schema. Harness adapters receive effective `SessionConfig` values and own harness behavior; persistent service management does not own detached session harnesses or workflow computation children.

Example standalone composition:

```ts
import { parseManifestObject } from '@barry-rocks/sdk/bags';
import { Traits } from '@barry-rocks/sdk/internal/traits';
import { mergeBounds } from '@barry-rocks/sdk/bounds';

const bag = parseManifestObject({ name: 'notes', description: 'Notes' });
const selected = Traits.select({ identity: { traits: ['reader'], bags: [bag.name] } });
const bound = mergeBounds(null, { deniedAccess: ['write'] });
```

Neither parsing a bag nor selecting a trait installs, starts, or connects to anything. To use a complete installed application, invoke an application operation explicitly. Service management works with persistent applications stopped.

Bags whose SQLite catalog references companion files declare a compiled local capture hook separately from the SQL store declaration:

```yaml
store:
  owned_by: identity
  engine: sqlite
  migrations: ./migrations/catalog
snapshots:
  default:
    entry: ./dist/snapshot.js
```

The module exports `captureSnapshot: StoreSnapshotAdapter`. `loadDeclaredStores` installs it once into the local registry, checks that its entry stays inside the installed bag, and refuses replacing an installed hook without restarting the runtime. Capture returns named file descriptors and writes companion bytes under `<snapshot database>.resources/<name>/<relative path>`. Required resources are declared in the catalog's `store_resource_requirements` table; the captured database must contain `store_snapshot_files(resource,path,bytes,checksum)` with the exact referenced files. SDK validation and local copying verify that index, each byte count and SHA-256, and the complete revision. Snapshot metadata never chooses executable code. `barry db restore` lays resource stores into a new store generation through their restore hook.

`activateStoreGeneration` from `@barry-rocks/sdk/stores` performs a trusted operator handoff between existing, durably prepared directories under `<stores root>/generations/`. Supply the expected outgoing ID, stopped/drained services, a complete candidate-validation callback and an idempotent callback that fences every outgoing writer. It preserves the old directory, records resumable prepared/sealing/sealed/active states, compares the exact original selector checksum before publication and retains per-generation activation receipts. The native SQLite operator lock is shared with legacy store migration and releases on process death. `activeStoreRoot` refuses ordinary resolution while recovery is pending, including after selector publication but before final acknowledgement. `interruptedStoreGeneration(root)` detects an abandoned switch, and `recoverStoreGeneration` finishes it with a no-op seal or rolls back when validation fails before selection. Cached handles still require the supplied storage fences; this lower-level operator API does not build a complete generation, enforce service shutdown itself, restore backup entries or redirect explicitly configured filepaths. Backup preparation and CLI orchestration remain required integration work.

`prepareStoreGeneration({ root, previousId, servicesStopped, build })` copies the whole selected tree into a fresh private generation while holding that same operator lock. Canonical node/identity SQLite stores use consistent snapshots that include committed WAL writes; their WAL/shared-memory files are omitted from the copy. Other regular files, immutable snapshots, ordinary permission bits and empty directories are retained independently. Symlinks and special entries are refused rather than omitted. A trusted optional build callback can overlay verified backup entries in the private copy. After that callback, canonical private SQLite catalogs are checked for integrity/foreign keys, checkpointed and switched to DELETE journaling before the receipt is hashed, so read-only validation cannot add WAL/shared-memory files. Undrained private handles prevent acknowledgement; ordinary file/directory modes are restored after normalization. Immutable SQLite snapshots outside canonical store paths are not rewritten. Source-file identities/timestamps, directory inventory and the exact selector are rechecked before recording success. Completed receipts bind every resulting file hash/size/mode and directory outside the copied tree; `validatePreparedStoreGeneration(root, id)` verifies that complete inventory before activation. The default entry limit is200,000, configurable up to1,000,000, and receipts are limited to64MiB. Failed/killed candidates remain private with failed/preparing records for diagnosis; no partial record validates as prepared. This API never switches the selector or changes the source. Store-specific lease/generation resets, production storage fences, backup orchestration and actual service shutdown enforcement still belong to the restore coordinator.

`previousStoreGeneration(root)` reads the selected generation’s activation receipt, and `prepareStoreGeneration({ source, ... })` can copy that previous generation while retaining the current selector check, recording `source` only when it differs from `previousId`. `pruneStoreGenerations(root, { dryRun })` keeps the active, previous and newer pending generations and removes older trees while retaining activation history.

Bags needing store-specific restore preparation declare `restores: { default: { entry: ./dist/local/restore-adapter.js } }` separately from capture. The compiled local module exports `prepareRestore: StoreRestoreAdapter`, taking a verified snapshot, destination node/identity/store reference and an unoccupied absolute catalog path in the caller's private candidate. `loadDeclaredStores` validates containment, declared store membership, export shape and repeat-loading identity; remote manifests never install executable adapters. `StoreRegistry.prepareRestore` validates the complete snapshot and declared schema before calling the hook, then validates regular catalog files, the resulting schema, SQLite integrity and foreign keys. Plain SQLite stores use an exclusive database copy; stores carrying resources require a local restore hook. The artifacts hook rebuilds immutable records and mutable metadata into a fresh generation, expires old upload leases, drops old pins/cursors and installs exact companion bytes. These operations prepare private candidates only; service drain, complete-generation receipts and outgoing fencing/activation remain the restore coordinator's responsibility.
