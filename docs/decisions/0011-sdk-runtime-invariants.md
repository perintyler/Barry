# ADR 0011: SDK runtime invariants

## Context

Operational source comments mixed controlling rules with regression history. The exact earlier comments below retain that history as evidence, including claims that described the earlier implementation.

## Decision

Keep each current invariant at its source and preserve the complete earlier rationale here. Shared storage backends and other later behavior changes must update the current invariant rather than rewriting this historical record.

## Consequences

Reviewers can find the original failure analysis without reading it on every source visit. The linked tests remain the executable evidence.

## sdk/src/adapters/harnesses/version-guard.ts

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

## sdk/src/adapters/models/vendors/catalog.ts

```text
/**
 * Vendor catalogs as data, carried by registered bag manifests.
 *
 * The catalog used to be TypeScript next to the vendor call code, so knowing
 * what models exist meant importing every vendor's HTTP calls. As data, a
 * picker, a doc, or a test reads the catalog without touching an
 * implementation; the call code attaches afterwards (`assembleVendors`) and
 * only a composition root does that.
 *
 * The invariants that guarded `defineVendor` live here now: each model id
 * appears once per vendor, at most one model of a kind claims each role — two
 * `default` completion models would make the choice depend on file order.
 * A catalog that breaks one is refused at parse, not discovered at call.
 */
```

## sdk/src/bags/__tests__/shipped-namespaces.test.ts

```text
/**
 * Every namespace a shipped trait grants is carried by a REAL tool.
 *
 * The sibling assertion in shipped-builtins.test.ts ("every granted namespace
 * has a provider") derives its `provided` set from bag.yaml alone, and for a
 * local bag it assumed the bag NAME was the namespace — the same assumption the
 * auto-traits fallback used to make. Bag name and code namespace therefore could
 * not disagree in that test, so it passed cleanly while `sessions` granted a
 * hollow `sessions` namespace that none of its 27 tools carried (they all stamp
 * `session`) and the real namespace was granted by nobody. Verified: reverting
 * the fix left that test green.
 *
 * This one opens the tool modules and reads what `defineTool` actually stamps.
 * That is the only way the two can be seen to disagree.
 *
 * Scope is deliberately in-repo builtins: out-of-repo bags (~/repos/bags) are a
 * different checkout that may be absent in CI, matching the precedent in
 * shipped-builtins.test.ts for `.skills/` bags.
 */
```

## sdk/src/bags/__tests__/snapshot-fixture.ts

```text
/**
 * Register bags for a test in the registry snapshot (BARRY_BAGS_SNAPSHOT),
 * the file every synchronous reader actually reads, in the shape the CLI's
 * writer produces. Tests used to write a YAML registry that production code
 * no longer reads.
 */
```

## sdk/src/bags/build.ts

```text
/**
 * Bag builder — bundles local bags to plain JavaScript.
 *
 * WHY THIS EXISTS
 * ---------------
 * The MCP server used to `await import()` a bag's raw TypeScript at runtime.
 * That only worked because Node type-strips, which forbids enums, parameter
 * properties, namespaces and `import =`, and refuses entirely under
 * node_modules. Worse, dev (tsx) transforms all of that while prod (plain Node)
 * does not, so a bag could work locally and silently vanish in production.
 *
 * Bundling to plain JS removes the whole class of problem: `.js` specifiers
 * resolve natively, any TypeScript syntax is legal, and an npm-installed bag
 * under node_modules loads fine.
 *
 * Output lives in a cache directory (see paths.ts) because it is fully
 * regenerable. Callers must therefore treat a missing build as "rebuild", never
 * as "bag is gone" — see ensureBagsBuilt.
 */
```

## sdk/src/bags/builtin.ts

```text
/**
 * The directory the builtin bags live in, or null when this code is not
 * running from an installation that has one.
 *
 * `BARRY_BUILTIN_DIR` overrides it. Tests point it at a fixture, or at an
 * EMPTY directory to mean "no builtins". The bag builder pins it into every
 * bundle, because bundled code no longer sits inside the repo, so walking up
 * from it finds nothing.
 *
 * An override naming a directory that does not exist is LOUD. It used to mean
 * "no builtins" silently, and that is how four cached bundles, pinned to
 * `harness/` before the directory was renamed, went on detecting zero builtin
 * bags with nothing to say so: broken and healthy looked identical.
 */
```

## sdk/src/bags/registry.ts

```text
/**
 * The bag registry as synchronous readers see it: the snapshot generated from
 * config.db, the one authority for installed bags.
 *
 * Readers that cannot await (Commander registration, tab completion, per-hook
 * dispatch) read the snapshot file; `sdk`'s bag-registry.ts writes it on
 * every change, and the CLI and `barry up` regenerate it when it is missing.
 * There is no fallback. A YAML file used to stand in when the snapshot was
 * missing, and it was a stale pre-migration subset (69 bags against 119), so
 * every bag registered since vanished with no error. A missing, empty or
 * unreadable snapshot is now an error that says how to rebuild it.
 */
```

## sdk/src/http/index.ts

```text
/**
 * Say which failure actually happened.
 *
 * Every rejection from `fetch` used to become "unreachable (is the daemon
 * running?)" — including the caller's OWN timeout abort. That message names a
 * cause it has not checked, so a slow-but-healthy backend reported as a
 * missing one, and the fix it suggested was wrong. It cost a real debugging
 * session: the server was up, answering /api/tags, with the model loaded,
 * while every call "proved" it was down.
 *
 * A wrapper may not assert a cause it did not verify. An AbortError is a
 * timeout — we set the only signal involved, so it cannot be anything else. A
 * connection error is genuinely unreachable. Anything else is reported as
 * itself rather than guessed at.
 *
 * Shared by every vendor caller, because two copies of a wrong diagnostic
 * mislead independently.
 */
```

## sdk/src/ids.ts

```text
/**
 * The names Barry's integration layer is built from.
 *
 * Two axes that used to share the word "provider": a HARNESS runs the agent
 * loop (claude-code, codex, cursor, opencode), a VENDOR serves tokens
 * (anthropic, openai, zai, ollama, typesafe). Every id here is an open string,
 * because harnesses are installed and vendors are data — a closed union would
 * make adding either a change to this file.
 */
```

## sdk/src/schedules/schedule-manifest.ts

```text
/**
     * One run: at this time (an ISO-8601 timestamp; include an offset), or
     * `login` — once per verified operating-system login session. `login` is the home of a
     * one-shot like "clear what a dirty shutdown left behind", which used to
     * be declared as a service that exited, and so showed as a dead one.
     */
```

## sdk/src/services/instance-env.ts

```text
/**
 * The instance's secrets file: `<app support>/env`, mode 0600, `KEY=VALUE` lines.
 *
 * No process loads it wholesale. Service management reads it to hand each service
 * only the keys that service declares, and the CLI reads the few values it
 * needs by name (`instanceEnvValue("BARRY_SECRET")`). Loading everything into
 * every process is how an agent session used to inherit every secret on the
 * machine.
 */
```

## sdk/src/services/listen.ts

```text
/**
 * How a Barry service starts listening: on the port its service management assigned,
 * on loopback, and nowhere else.
 *
 * Every server used to pick its own port (a formula, a manifest number, or a
 * literal fallback like `PORT || 4885`) and its own bind address. That made two
 * things invisible: a service that computed a port nobody else would look up,
 * and one bound to every interface (`hq` listened on `*`). One helper makes
 * both impossible, and `pnpm check:service-addresses` flags a server that calls
 * `.listen(` itself instead of using it.
 */
```

## sdk/src/services/logging.ts

```text
/**
 * The logger factory request logging uses.
 *
 * The kit's own emitter (`@barry-rocks/sdk/logging`) by default. It used to be
 * injected because the emitter lived in the logs bag and the service toolkit
 * must not depend on a bag; with the emitter in the kit, a service needs no
 * setup call. `setLoggerFactory` remains so a test can record what is logged.
 */
```

## sdk/src/sessions/session-namespaces.ts

```text
/**
 * Resolving which namespaces a session's tools actually live in.
 *
 * Each namespace becomes its own entry in the session's MCP config, pointing at
 * `/mcp/ns/<namespace>` on the one MCP server. That is what gives the agent real
 * per-bag tool prefixes (`mcp__linear__ticket_get`) instead of collapsing
 * everything onto `mcp__barry__*` — the prefix comes from the config key, so one
 * key means one prefix.
 *
 * The list MUST come from the server. Callers used to derive it from traits
 * alone, but the real tool set also depends on `metadata.selected_namespaces`,
 * the session's barry, and scope filtering — so a trait-derived list
 * under-reports and silently drops tools back onto the `barry` prefix.
 */
```

## sdk/src/stores/migrate.ts

```text
/**
 * Bring a SQLite store up to date, safely when several processes open it at once.
 *
 * Every store used to read `max(version)` from `schema_migrations` outside any
 * lock and then apply what was newer. Two processes opening a fresh store
 * together both saw version 0, both applied 001, and the loser crashed on
 * `UNIQUE constraint failed: schema_migrations.version`. The service management starts
 * an instance's services together, so on a fresh home that is the normal case.
 *
 * Here the version is read and the migrations applied inside one
 * `BEGIN IMMEDIATE` transaction: the second opener waits for the write lock
 * (up to the handle's busy_timeout), then finds the work done.
 *
 * Written against plain SQL (`exec`, `prepare().get/run`) so better-sqlite3 and
 * Node's built-in `node:sqlite` both satisfy it, and the sdk takes on no native
 * dependency.
 */
```

## sdk/src/tools/define-tool.ts

```text
/**
 * A parameter schema from EITHER zod major.
 *
 * The package's peer range is `^3.25.0 || ^4.0.0` so external bags can move to
 * zod 4 at their own pace, but this type used to be `z.ZodRawShape` -- zod 4's,
 * which requires the `_zod` internals a zod 3 schema does not have. Every zod 3
 * bag that called defineTool failed to typecheck, and nothing noticed while
 * those bags still linked a stale copy of the old toolkit. Both majors declare
 * their output type as `_output`, so typing the shape by that member accepts
 * either (see ToolParamSchema); the runtime already handles both (see zod-to-json).
 */
```

## sdk/src/tools/normalize-json-schema.ts

```text
/**
 * Make a tool's JSON Schema independent of the zod major that built it.
 *
 * The wire format a bag publishes used to be decided by whichever zod its
 * AUTHOR installed: the MCP SDK picks a converter per schema at runtime, and
 * v3 and v4 disagree on six points. That made a dependency bump in someone
 * else's repo a silent change to Barry's published contract.
 *
 * This module removes that coupling. Every rule below rewrites a v4-ism back
 * to the v3 spelling that shipped first, so both majors emit the same bytes
 * and the author's choice stops mattering.
 *
 * WHY v3 IS THE TARGET and not v4: the v3 spelling is the one already on the
 * wire. Clients validate against it today, so it is the compatible direction.
 * Nothing here claims v3's output is better JSON Schema.
 *
 * EVERY RULE IS CONDITIONAL ON V4'S EXACT FINGERPRINT. The danger in a
 * normalizer is not missing a case, which a differential test catches — it is
 * a rule broad enough to eat something an author wrote on purpose. So
 * `minimum` is stripped only at the exact safe-integer bound, `pattern` only
 * beside a `format` that implies it, and a union is collapsed only when every
 * branch is a bare type. A hand-written `.min(0)`, a custom `pattern`, or an
 * explicit `.passthrough()` must survive untouched — see the "survives" cases
 * in normalize-json-schema.test.ts, which exist to hold that line.
 */
```
