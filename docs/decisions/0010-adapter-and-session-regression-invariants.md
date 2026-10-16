# ADR 0010: Adapter and session regression invariants

## Context

Dated source narratives documented vendor observations and prior failures. Their exact checkpoint wording is retained below as historical evidence, rather than current vendor guarantees.

## Decision

Keep a short controlling invariant in source and link the supporting notes here. No executable behavior changes in this move.

## Consequences

Vendor capability and storage changes must revalidate the linked contracts. Old dates and measurements below describe the original observations.

## Note 001

Source: [adapters/completions/ollama/src/check.ts](../../adapters/completions/ollama/src/check.ts)

Require an actual tool call; daemon health and prose responses do not establish tool-calling capability.

Original rationale:

```text
/**
 * Can this local model actually drive a coding session?
 *
 * "Is the daemon up" is green in exactly the state that needs catching: the
 * daemon healthy, the model pulled, and the session useless because the model
 * answers in prose instead of calling tools. Measured 2026-09-11 (Ollama
 * 0.33.3, 16GB): under the Claude Code system prompt qwen3:4b produced zero
 * tool calls and wrote the tool's output as text — a run that "succeeded"
 * doing nothing. So the probe asserts a tool call comes back.
 *
 * A floor, not a guarantee: one trivial tool is easier than choosing among a
 * session's full set. A pass does not promise a good session; a failure does
 * promise a bad one.
 */
```

## Note 002

Source: [adapters/decisions/systemone/src/index.ts](../../adapters/decisions/systemone/src/index.ts)

SystemOne and Von share the protocol’s 255-choice ceiling.

Original rationale:

```text
/** Vendor limits, from docs.typesafe.ai/models.md (read 2026-09-21). Von
 *  shares them: same protocol, same ceiling on choice cardinality (255). */
```

## Note 003

Source: [adapters/sessions/claude/src/modes.ts](../../adapters/sessions/claude/src/modes.ts)

Parse the vendor version within the full CLI output rather than anchoring to a bare version string.

Original rationale:

```text
// Real output (2026-09-25): "2.1.282 (Claude Code)". Unanchored on
    // purpose — an anchored match breaks the moment the binary prefixes its
    // own name, which is exactly what codex does and what a future claude
    // release may.
```

## Note 004

Source: [adapters/sessions/cursor/src/listing.test.ts](../../adapters/sessions/cursor/src/listing.test.ts)

Use the captured model list for parser and picker agreement tests.

Original rationale:

```text
/**
 * What `cursor agent --list-models` prints, parsed.
 *
 * Recorded from `cursor agent --list-models`, 2026-09-22, 241 models. The
 * model list the picker offers is checked against the same recording where every
 * adapter and the vendor list can be loaded together
 * (cli/test/shipped-adapters/cursor-models.test.ts).
 */
```

## Note 005

Source: [adapters/sessions/cursor/src/modes.ts](../../adapters/sessions/cursor/src/modes.ts)

Cursor uses calendar versions with build suffixes rather than semantic versions.

Original rationale:

```text
// Real output (2026-09-25): "2026.09.23-86fc751" — a calendar version with
    // a build hash. The hash is dropped: it identifies the build within a
    // release, and pinning to it would report a mismatch for a rebuild of the
    // same version. `verifiedOn` therefore names the release, not the build.
```

## Note 006

Source: [adapters/sessions/cursor/src/permissions.ts](../../adapters/sessions/cursor/src/permissions.ts)

Write native deny rules into the workspace; caller denials override any selected native-tool allowance.

Original rationale:

```text
/**
 * Barry's denied tools -> Cursor's `.cursor/cli.json` permission denylist.
 *
 * Cursor reads its denylist from the session workspace and blocks matching
 * calls. The allowance removes selected native tools from this list; caller
 * denials still take them back.
 *
 * Measured 2026-09-15 against cursor-agent 2026.09.10 (see cursor-permissions
 * QA in adapters/README.md): with the denylist in place a denied command comes
 * back `permissionDenied: "Command blocked by permissions configuration"` and
 * never runs, while undenied tools still run normally.
 */
```

## Note 007

Source: [adapters/sessions/opencode/src/mcp-config.ts](../../adapters/sessions/opencode/src/mcp-config.ts)

Use IPv4 loopback because the supported vendor build does not fall back from IPv6 localhost.

Original rationale:

```text
/**
 * A `localhost` url as `127.0.0.1`.
 *
 * opencode 2.0.14 resolves localhost to `::1` and does not fall back, so a
 * server listening on IPv4 alone — Barry's MCP engine is one — hangs until
 * opencode gives up at 30s, and the session runs without Barry's tools
 * (observed 2026-09-29: the same server connected at once as 127.0.0.1).
 */
```

## Note 008

Source: [adapters/sessions/opencode/src/modes.ts](../../adapters/sessions/opencode/src/modes.ts)

The supported v2 CLI and the older package share a binary name; inspect the resolved build.

Original rationale:

```text
/**
 * The build every guarantee was verified against (2026-10-06).
 *
 * opencode ships two lines under two npm packages: `@opencode/cli` is 2.x,
 * and `opencode-ai` is still 1.x, which has no v2 server and none of the
 * flags or config this adapter uses. Both install a binary named `opencode`,
 * so PATH order decides which one a launch gets; `barry adapter doctor`
 * reports the build it actually resolved.
 */
```

## Note 009

Source: [adapters/sessions/opencode/src/server/launch-env.ts](../../adapters/sessions/opencode/src/server/launch-env.ts)

Keep service registry, persisted conversation and credentials session-local; disable project config and use standalone guest mode.

Original rationale:

```text
/**
 * The environment every opencode process Barry starts runs in: the hosted
 * server and the guest TUI alike.
 *
 * Each rule below was checked against 2.0.24 on 2026-10-06 with a fake model
 * and MCP server recording what opencode actually sent. They are one module
 * because every one of them holds in both modes, and a mode that skipped one
 * would reopen what it closes.
 *
 * **E6 — the shared service.** A bare `opencode` joins or spawns a per-user
 * background service (`serve --service`, found through `service.json` in its
 * config dir), and that service keeps only the FIRST launcher's environment:
 * a second TUI given another session's config ran with the first's MCP
 * servers and session id. The hosted server is a `serve` of Barry's own; the
 * guest TUI passes `--standalone`, which runs a private server that exits
 * with it. The private config dir keeps the service registry private too.
 *
 * **Credentials.** opencode 2.x reads a provider key from its own store first
 * (the `credential` table in its data dir), then the environment, then the
 * config's `apiKey` — a key the user once saved in opencode beat the
 * identity's, even with the identity's pinned in config. So each session gets
 * a data dir of Barry's with no stored credentials, and the identity's keys
 * reach opencode only through the environment, under the names opencode
 * reads. Only providers holding one of those keys (and the session model's
 * own) are enabled: opencode otherwise also offers providers it finds in the
 * ambient environment, such as Bedrock on AWS variables.
 *
 * **Project config.** A repo's own `opencode.json` is loaded by default and
 * can add MCP servers, providers and permissions; it is switched off.
 *
 * The data dir is the session's, not a scratch dir: the conversation lives in
 * it, so the session resumes from it after a hosted server is released, and
 * after a guest TUI exits.
 */
```

## Note 010

Source: [adapters/sessions/opencode/src/server/launch-env.ts](../../adapters/sessions/opencode/src/server/launch-env.ts)

Translate identity keys to the vendor’s provider variables; Z.ai requires ZHIPU_API_KEY.

Original rationale:

```text
/**
 * Which providers each identity key opens, and the variable opencode reads it
 * from — from opencode's own catalog (models.dev `env`), 2026-10-06. Z.ai's
 * key is the one that differs: Barry declares `Z_AI_API_KEY`, and opencode's
 * `zai` provider reads `ZHIPU_API_KEY`, so passing the identity's variable
 * through unchanged left that provider with no key at all.
 *
 * Adapter-local knowledge: the SDK names no vendor.
 */
```

## Note 011

Source: [bags/actions/src/tools.ts](../../bags/actions/src/tools.ts)

Reject executor-spawned detached sessions at the execution boundary to prevent recursive fan-out.

Original rationale:

```text
/**
 * True when the calling session is itself an executor-spawned detached run.
 *
 * This predicate is the recursion breaker for the HTTP executor
 * (POST /api/v1/actions/:name/run), which the web app and the phone trigger.
 * The executor tags every session it creates with metadata.source:
 * "action-executor"; without this guard a detached run that triggers another
 * one self-multiplies — verified live on 2026-08-20, when ONE external request
 * became 136 runs (doubling ~45s: agents fan out tool calls in pairs) until the
 * agents were killed. Denying at the boundary is deterministic where prompt
 * guidance is only probabilistic.
 *
 * The `do_action` TOOL this originally also guarded is gone: detachment is the
 * caller's decision, made by spawning a subagent, never a property of the
 * action. The executor endpoint stays, so its guard stays with it.
 */
```

## Note 012

Source: [bags/filesystem/tracker/src/db.ts](../../bags/filesystem/tracker/src/db.ts)

Report the resolved store path instead of a hardcoded backend label.

Original rationale:

```text
/**
 * Exported so the `status` tool can report where changes actually land.
 *
 * It used to answer with a hardcoded backend name that never matched the SQLite
 * file this bag actually reads. A status tool that states its backend from a
 * literal cannot be wrong about it in a way anyone notices, so it reports the
 * resolved path instead.
 */
```

## Note 013

Source: [bags/identities/src/store/identities-sqlite.test.ts](../../bags/identities/src/store/identities-sqlite.test.ts)

Use normalized ISO timestamp shape so migrated and new rows sort consistently.

Original rationale:

```text
// rowToBarry used to call `.toISOString()`, which THROWS on a string.
    // Asserting the shape catches both that crash and a silently un-normalised
    // "2026-09-22 09:17:17" that would sort differently from migrated rows.
```

## Note 014

Source: [bags/identities/src/store/identity-bags.ts](../../bags/identities/src/store/identity-bags.ts)

Bag composition expansion requires the full transitive composition closure, without importing unrelated installed bags.

Original rationale:

```text
/**
   * The bags composition expansion may draw on, keyed by name.
   *
   * `loaded` holds the full transitive closure (the loop above), and
   * `expandComposition` walks nothing but that closure. A map narrower than
   * the closure would omit child bags.
   *
   * This used to be `loadAllBags()`, the full registry, which added nothing
   * the closure lacks but built and imported every installed bag's tool code
   * on every identity sync — about 13s on the author's machine, paid by every
   * identity CLI command. It also always threw while any one bag was broken,
   * and fell back to `loaded` anyway.
   */
```

## Note 015

Source: [bags/mcp/src/application.ts](../../bags/mcp/src/application.ts)

Warn before transport accumulation exhausts the hard cap so reclamation failures remain diagnosable.

Original rationale:

```text
/**
   * Live-transport count that should never be reached in normal operation.
   * Expected steady state is ~45 per agent session (one per namespace), so this
   * is several busy sessions' worth. Crossing it means transports are
   * accumulating faster than they are reclaimed — the signature of the 2026-08-14
   * leak, which surfaced to users as "MCP is down" only once it hit
   * MAX_TRANSPORTS. Warn while there is still headroom.
   */
```

## Note 016

Source: [bags/mcp/src/bag-proxy.test.ts](../../bags/mcp/src/bag-proxy.test.ts)

Zod JSON Schema must include the object properties consumed by tool validation.

Original rationale:

```text
// This assertion is INVERTED from what it was, deliberately.
  //
  // It used to pin `properties` as undefined: zod-to-json-schema was v3-only,
  // every bag pinned 3.x, and a v4 schema converted to nothing -- the test
  // recorded that loss as expected so the day a bag moved to v4 would be
  // noticed. The workspace is on v4 now and the converter handles both, so
  // the loss is no longer the correct behaviour to assert. A v4 schema must
  // reach the model with its parameters intact.
```

## Note 017

Source: [bags/mcp/src/tool-runtime.ts](../../bags/mcp/src/tool-runtime.ts)

Apply deferred-discovery gating only where deferred discovery was actually enabled.

Original rationale:

```text
// AgentId mode only: `metaToolsRegistered` is now exactly
        // `discovery === "barry"`, so reaching this branch means the client
        // handles deferral and nothing should be hidden from tools/list.
        //
        // This used to also catch a barry-mode server that had no deferred
        // tools at init and gained some later — it warned
        // `tool_server.refresh_defers_without_meta_tools` and listed them
        // visibly, because tool_search was never registered. Meta-tools are now
        // unconditional in barry mode, so that state cannot occur and the warn
        // is gone rather than left as a line that can never print.
```

## Note 018

Source: [bags/memory/src/import.ts](../../bags/memory/src/import.ts)

Derive a bounded topic tag before heading annotations so dates and filenames do not become tag identity.

Original rationale:

```text
/**
 * A heading like `Live tool refresh — proven on CC (2026-08-25) — detail in
 * [file](file)` names its topic before the first dash/paren; everything after
 * is annotation. Slugifying the whole line produced 160-char tags that echoed
 * dates and filenames — as a tag, only the topic is worth keeping. Capped at
 * 40 chars on a hyphen boundary as a backstop for dash-less run-ons.
 */
```

## Note 019

Source: [bags/sessions/api/src/routes/actions.ts](../../bags/sessions/api/src/routes/actions.ts)

Reject executor-spawned recursive execution even when it targets the same action.

Original rationale:

```text
// cwd is the action dir for an installed action, not the API's own cwd:
      // relative paths in its prompt (and its validate: block, which also
      // resolves against the action dir) mean the same thing at run time as at
      // authoring time. An ad-hoc action starts where its caller works.
      // The trailer is the soft half of the recursion defense (the hard half
      // is the refusal, in run_action and again above for a caller that is a
      // detached run): without it, a spawned agent can call run_action on its
      // own action — the loop of 2026-08-20, when the tool was do_action.
```

## Note 020

Source: [bags/sessions/hooks/session-tracker/normalize.test.ts](../../bags/sessions/hooks/session-tracker/normalize.test.ts)

Provider detection must use discriminating fields; Claude also sends hook_event_name.

Original rationale:

```text
/**
 * Regression: provider detection keyed on `hook_event_name` being present,
 * but Claude Code sends that field on every hook payload. Every Claude session
 * was therefore labelled 'cursor', which failed the provider_sessions provider
 * CHECK constraint (the constraint predated the cursor provider and did not
 * list it). sessionStart swallows write errors so it can never block the
 * agent, so the insert vanished silently: provider_sessions recorded nothing
 * at all after 2026-07-24, and `barry resume <id>` had no provider session id
 * to resume against for any CLI session.
 */
```

## Note 021

Source: [bags/sessions/hooks/session-tracker/normalize.ts](../../bags/sessions/hooks/session-tracker/normalize.ts)

Provider detection must distinguish Claude from Cursor before writing the provider session ID.

Original rationale:

```text
// hook_event_name is NOT a Cursor signal: Claude Code sends it on every hook
  // payload (SessionStart, Stop, PostToolUse, ...), so keying on it labelled
  // every Claude session 'cursor'. That value then failed the
  // provider_sessions provider CHECK constraint, and because the hook swallows
  // write errors to avoid ever blocking the agent, the insert vanished
  // silently — leaving `barry resume <id>` with no provider session id to
  // resume against for every CLI session after 2026-07-24.
  //
  // The remaining signals are genuinely Cursor-only: cursor_version and
  // conversation_id appear nowhere in Claude's payloads, and BARRY_PROVIDER is
  // set explicitly by the cursor launcher.
```

## Note 022

Source: [bags/sessions/src/bookkeeping-drift.eval.test.ts](../../bags/sessions/src/bookkeeping-drift.eval.test.ts)

Retain the observed false-positive fixture so bookkeeping drift does not classify valid behavior as a fault.

Original rationale:

```text
// The first FALSE POSITIVE the job produced in production (2026-08-26):
    // "Was Approvals feature development; now Wrap-up session." Wrapping up is
    // how work ENDS, not a different task. Earlier attempts to capture this as
    // a synthetic case failed because a condensed version reads as genuinely
    // unrelated; this is the real activity that tripped it.
```

## Note 023

Source: [bags/sessions/src/capture/coverage.test.ts](../../bags/sessions/src/capture/coverage.test.ts)

Coverage must inspect stored payload content; row and line counts alone can hide empty messages.

Original rationale:

```text
/**
 * The failure these counters were blind to until 2026-09-28: rows written with
 * an EMPTY payload. Every existing counter read healthy — `considered=8
 * located=8 persisted=3762 lines=60965/60965 failed=0` — while 99.5% of the
 * stored user rows carried no content, because the reader's `text` field never
 * reached the store's `content` field.
 */
```

## Note 024

Source: [bags/sessions/src/capture/transcript-watcher.ts](../../bags/sessions/src/capture/transcript-watcher.ts)

Expose capture failures explicitly rather than relying on considered-but-not-persisted counters.

Original rationale:

```text
// One unreadable transcript must not end the sweep.
      //
      // This used to say the failure "shows up as a considered session that
      // located or parsed nothing". That is only true when the throw happens
      // BEFORE `locate` succeeds. A session that locates its file and then
      // fails while persisting has already incremented `located`, so the
      // summary counts it as healthy — which is how ten sessions failed every
      // minute behind `considered=11 located=11`.
```

## Note 025

Source: [bags/sessions/src/client/seam.test.ts](../../bags/sessions/src/client/seam.test.ts)

Inspect actual store imports and assert candidate coverage so an empty scan cannot falsely prove routing isolation.

Original rationale:

```text
/**
 * The seam is only worth having if it is airtight: any file that imports a
 * storage-surface name straight from the session STORE has gone around it,
 * skipping the routing to the store that holds the session, and reads or
 * writes the wrong file without an error. This test fails on the import, not
 * the outage.
 *
 * It used to watch a barrel package that re-exported the store. When that
 * package dissolved, this test still passed for a moment -- on two files that
 * only MENTIONED the old name in a comment, which is the "scan found nothing
 * and reported success" shape the candidate-count assertion below exists to
 * catch. It now watches the store modules themselves, which is where the
 * names actually live.
 */
```

## Note 026

Source: [bags/sessions/src/store/messages.ts](../../bags/sessions/src/store/messages.ts)

Match metadata.toolUseId exactly; substring matching can attach a parent result to a child invocation.

Original rationale:

```text
/**
 * Correlate a `tool_result` to its `tool_call` row when no in-process pending
 * entry matched (a different process persisted the call, or the pending map
 * was reset). Matches on `metadata->>'toolUseId'` equality.
 *
 * This used to be `metadata::text LIKE '%<toolUseId>%'` — an unindexed scan,
 * and a correctness bug: a subagent's `tool_call` row carries
 * `metadata.parentToolUseId` set to its PARENT's toolUseId, which is a
 * substring match for that LIKE pattern. Ordered `sequence DESC`, the old
 * fallback could attach a parent's result to the wrong (child) row whenever
 * the child's own call happened to sort first. Equality against the
 * `toolUseId` key alone cannot match a `parentToolUseId` value, and is
 * covered by `idx_messages_tool_use_id` (migration 026).
 */
```

## Note 027

Source: [bags/sessions/src/store/session-date-filters.test.ts](../../bags/sessions/src/store/session-date-filters.test.ts)

Normalize ISO boundaries and include the full named day in an upper-bound filter.

Original rationale:

```text
/**
 * Date-range filtering and LIKE escaping on listSessions.
 *
 * The day-boundary rule is the subtle one: a bare `YYYY-MM-DD` parses to the
 * midnight that *opens* the day, so using it as an upper bound would exclude
 * everything that happened during it. Asking for "sessions on the 25th" has to
 * include the 25th.
 *
 * Now against SQLite, where the rule has a second edge the previous version
 * did not have: `created_at` is TEXT and the comparison is a STRING
 * comparison, so the bound has to be normalised to the same ISO shape the rows
 * carry.
 * `parseDateBoundary` does that with `.toISOString()`. A bound left as the
 * caller typed it ("2026-08-25") would compare lexically against
 * "2026-08-25T09:30:00.000Z" and, for the upper bound, exclude the whole day —
 * the exact bug this suite has always guarded, arriving by a different route.
 */
```

## Note 028

Source: [bags/sessions/src/store/sessions-sqlite-reads.test.ts](../../bags/sessions/src/store/sessions-sqlite-reads.test.ts)

Preserve NULL timestamps; constructing a Date from NULL would invent a real epoch value.

Original rationale:

```text
// `new Date(null)` is 1970-01-01, which reads downstream as a real date —
    // an ended session that never ended, sorted to the beginning of time.
```

## Note 029

Source: [bags/sessions/src/store/sessions-sqlite-reads.test.ts](../../bags/sessions/src/store/sessions-sqlite-reads.test.ts)

A bare createdBefore date includes its entire day rather than excluding that day’s records.

Original rationale:

```text
// A bare date must cover its whole day. `createdBefore: "2026-09-22"`
    // meaning midnight would exclude everything that happened on the 22nd,
    // which is the opposite of what asking for that day means.
```

## Note 030

Source: [bags/sessions/src/store/sessions-sqlite-reads.ts](../../bags/sessions/src/store/sessions-sqlite-reads.ts)

An upper-bound bare date includes the complete day; normalize it to the matching ISO boundary.

Original rationale:

```text
/**
 * Parse a filter boundary into an ISO instant.
 *
 * A bare date has to cover the whole day it names: `createdBefore: "2026-08-25"`
 * meaning "up to midnight that morning" would exclude everything that happened
 * on the 25th, which is the opposite of what asking for that day means.
 */
```

## Note 031

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Select consecutive samples by position; each caller applies cadence-aware staleness separately.

Original rationale:

```text
// Take the last `need` points by POSITION, not by age.
  //
  // This used to window at `need * 240` seconds — 4x a 60s tick per sample,
  // intended as slack. It is not enough: the tick is only 60s while the host is
  // awake. During the 2026-08-21..23 outage the machine mostly slept, the
  // collector ran roughly hourly, and three consecutive failures spanned three
  // HOURS — so no dwell-gated rule could ever see them, exactly when the
  // machine was unhealthy enough to sample slowly.
  //
  // Age is `isStale`'s job now, and it is applied by every caller before this
  // runs. What `forSamples` is actually for is suppressing a single spike, and
  // that is a question about consecutive samples, not elapsed time.
```

## Note 032

Source: [bags/telemetry/src/usage/queries.ts](../../bags/telemetry/src/usage/queries.ts)

Interpolate the closed bucket enum and bind only the time window so placeholder order remains correct.

Original rationale:

```text
// count(*) FILTER (WHERE ...) has no SQLite spelling; sum(CASE) is the
  // equivalent. The bucket format string is interpolated, not bound: it is a
  // literal from this closed two-value enum, and binding it would put a `?`
  // in the SELECT ahead of the window's `?` — the values would bind in the
  // wrong order and the panel would render empty (found live, 2026-09-22).
  // Both bucket shapes remain ISO so the renderer needs no per-dialect
  // knowledge.
```

## Note 033

Source: [bags/vault/server/src/app.ts](../../bags/vault/server/src/app.ts)

Include a unique token ID so simultaneous logins cannot revoke each other when one logs out.

Original rationale:

```text
/**
 * A login's token, unique to it.
 *
 * Logout revokes by the token's hash, and without `jti` two logins to one
 * account in the same second signed the same payload — the same token — so
 * one session's logout revoked the other's, which then got 401 on every call.
 * Barry opens and closes sessions on one account from several processes at
 * once, so this was routine (2026-10-06: six of eight back-to-back logins).
 */
```

## Note 034

Source: [cli/test/bag-install-deps.test.ts](../../cli/test/bag-install-deps.test.ts)

A nonzero dependency-install exit does not imply missing packages; verify the installed result.

Original rationale:

```text
// The regression: pnpm exits nonzero for ERR_PNPM_IGNORED_BUILDS while
  // leaving a complete node_modules. The old gate read that as "missing
  // dependencies", aborted before registering the bag, and `barry pack` then
  // reported it missing entirely (recommendation-checker, 2026-09-17).
```

## Note 035

Source: [cli/test/error-output.test.ts](../../cli/test/error-output.test.ts)

Anticipated failures render one line unless debug is enabled; a regular-file parent fails safely on every platform.

Original rationale:

```text
/**
 * A failure the CLI can anticipate should read as a sentence, not a stack.
 *
 * This used to assert against `barry devops db status` pointed at an
 * unreachable database — the most ordinary failure there was — which printed a
 * raw Node stack with node:net internals and node_modules paths. That database
 * and that command are both gone, but the guarantee was never about either: it
 * is that `errorMessage()` renders any anticipated failure as one line, and
 * that BARRY_DEBUG=1 is the only way to get the stack back.
 *
 * Retargeted at a backup into an unwritable path rather than deleted. A
 * deleted test would have left the surviving behaviour with no coverage at
 * all, which is how the stack-trace regression got in the first time.
 *
 * The destination is a path whose PARENT is a regular file, which fails as
 * ENOTDIR on both platforms in well under a millisecond.
 *
 * It used to be `/proc/nonexistent/backup`, chosen as "somewhere that cannot be
 * written" — a macOS idiom, since macOS has no /proc and returns ENOENT at once.
 * On Linux that hangs FOREVER: `mkdirSync(path, {recursive: true})` under /proc
 * never returns on Node 26.10, so the CLI died on its very first filesystem
 * call (cli/src/commands/db.ts, the mkdirSync at the top of dbBackupCommand)
 * having printed nothing, and the suite reported a 20s timeout as an assertion
 * failure. Measured: /proc + recursive hangs, /proc without recursive gives
 * ENOENT, and /sys + recursive gives ENOENT — so it is specific to /proc, not
 * to virtual filesystems generally. An upstream Node bug, not a Barry one, but
 * this test has no reason to depend on it.
 */
```

## Note 036

Source: [cli/test/git-url-install.test.ts](../../cli/test/git-url-install.test.ts)

Reject bare git repository URLs without overwriting local registrations; allow actual MCP endpoint paths.

Original rationale:

```text
/**
 * `barry install` accepts a remote MCP URL, and a bare git repo URL is the
 * most likely thing someone types when they mean "install this bag". Before
 * this guard, such a URL registered as a remote MCP server pointing at an
 * HTML page -- OVERWRITING any existing local registration, dropping the
 * bag's composition and tools, while install and the following pack both
 * exited 0 and printed success.
 *
 * Observed on jalen-brunson, 2026-09-16: `Type: local` with three composed
 * bags became `Type: remote` with none, reported as "registered".
 *
 * The predicate is deliberately narrow. A git host can serve a real MCP
 * endpoint under a path, so only the bare owner/name shape is refused.
 */
```

## Note 037

Source: [cli/test/monorepo-child-dedupe.test.ts](../../cli/test/monorepo-child-dedupe.test.ts)

Deduplicate by bag source including subdirectory so diamonds terminate without skipping sibling bags.

Original rationale:

```text
/**
 * `installDeclaredChildren` skips a child whose source it has already seen, so
 * a diamond installs once and a cycle terminates. The key must identify a BAG,
 * not a repository.
 *
 * It used to be the repo URL alone, which was correct only while one repo held
 * one bag. Once `subdir:` let several bags ship from one repo, every child
 * after the first collapsed onto the same key and was skipped — and the skip is
 * a bare `continue`, so the install printed success while the parent silently
 * contributed none of their tools. That is exactly the half-installed parent a
 * declared `repo:` source is supposed to rule out.
 *
 * The function is not exported and its body does real git and registry work, so
 * this asserts on the key expression itself.
 */
```

## Note 039

Source: [cli/test/vault-backup.test.ts](../../cli/test/vault-backup.test.ts)

Expose snapshot and live vault counts before restore, without opening the encrypted backup for comparison.

Original rationale:

```text
// The manifest is what lets a future restore say "this is 3 accounts from
  // 2026-09-15; your live vault has 3" without opening the (possibly
  // encrypted) snapshot first. verify() computed these counts before this
  // existed too — they just reached only a console line and were discarded.
```

## Note 040

Source: [sdk/src/bags/__tests__/build-errors.test.ts](../../sdk/src/bags/__tests__/build-errors.test.ts)

Preserve every unresolved-import diagnostic and its location in the structured build result.

Original rationale:

```text
/**
 * A bag whose entry imports a package that cannot resolve — the exact shape
 * that made vantage-core fail (2026-09-17). esbuild reports one diagnostic per
 * unresolved import, with a location; the build result must carry them.
 */
```

