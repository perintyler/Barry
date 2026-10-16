# Adapters

This tree splits by the kind of work a vendor's code does, and the model list is data:

- [`shipped-models.yaml`](../sdk/src/adapters/models/vendors/shipped-models.yaml) is the one model list — every vendor, every model, addresses, credentials, and the compatibility doors between them. The SDK validates its `vendors:` declarations and enforces the invariants at parse: unique model ids, one role claim per kind, compatibility naming a listed vendor.
- [`sessions/`](sessions/) is the System-2 agent axis: the harness packages (`sessions/{claude,codex,cursor,opencode,pi,antigravity}`, each depending on the SDK and its own vendor SDK, never on another adapter).
- [`completions/`](completions/) is System-2 token call code: vendors serving direct completions (Anthropic messages, Ollama, llama.cpp), used for one-shot answers and background jobs when no harness is involved.
- [`embeddings/`](embeddings/) is vector call code (Ollama's `/api/embed`).
- [`decisions/`](decisions/) is System One call code: the `/v1/systemone` wire protocol written once (`systemone.ts`), serving hosted Jev and the local Von daemon — byte-compatible with it by design — plus the prompted fallbacks on generative models.
- The composition roots assemble what they install: each names the shipped yaml and call code it ships (see [the CLI's](../cli/src/lib/shipped-vendors.ts) for the shape), and merges installed adapters' vendor code on top — an adapter package may carry [`vendorCode`](../sdk/src/adapters/models/vendors/models.ts) (its own vendor rows and per-kind factories), snapshotted into `adapters.json` at install and loaded from the recorded path at boot. One vendor, one provider of call code; a second adapter claiming one is refused at `add`. There is deliberately no package that imports all of the call code: the set of vendors an instance runs is the instance's, not the tree's.

The call code is data plus plain HTTP: a kind package depends on the SDK alone, plus `completions/`'s transports where one daemon or one API serves several kinds. No vendor SDK may be added here — that is what a harness package is for. A third party ships the same shape: an adapter package whose default export is `defineAdapter({...})` and whose `bag` directory carries vendor rows in `bag.yaml` and whose named `vendorFactories` export carries call code. Legacy `vendorCode` exports remain supported.

The contracts are in the SDK: [`sdk/src/adapters`](../sdk/src/adapters/harnesses/index.ts) (adapter, modes, guarantees, capabilities, requirements), [`sdk/src/sessions`](../sdk/src/sessions/index.ts) (the session and its events), [`sdk/src/adapters/models/vendors`](../sdk/src/adapters/models/vendors/index.ts) (the vendor shape) and [`sdk/src/adapters/models/vendors/models.ts`](../sdk/src/adapters/models/vendors/models.ts) (the yaml schema and the merge). The SDK names no harness and no vendor; the CLI and the sessions API are the composition roots that load the adapters and install the models.

## Installing

`barry adapter add <path>` loads the package at `path`, runs [`checkAdapter`](../sdk/src/adapters/harnesses/check.ts) over its declarations and doctor over this machine, and records it in the instance's `adapters.json`. `barry adapter list` and `barry adapter doctor` read that record without loading any adapter code. Setup records shipped call-code packages; use `barry adapter model add <path>` for packages Barry does not ship and `barry adapter add <path>` to select session harnesses.

A bag service that needs agent work — a harness running a loop with tools in a directory — starts a hosted session by harness id with [`startInstalledSession`](../sdk/src/sessions/installed.ts). A bag that needs a one-shot model answer uses `installedModels().completion(ref)` instead; no harness is involved.

## Modes

A mode says who is at the controls and what Barry holds. It is what a session records, what a message sender is told and what the UI shows.

| Mode | Who drives | What Barry holds |
|---|---|---|
| `hosted` | Barry | the session: every event, delivery, interrupt, a ruling on each tool call the harness asks about |
| `instrumented` | a human, in the harness TUI | the side doors opened at launch: delivery, live capture, tool gating |
| `guest` | a human, in the harness TUI | what the harness leaves behind: its transcript, and delivery when the agent calls a Barry tool |

A TUI mode may instead render the hosted session: its TUI attaches to the engine Barry already holds (`attachesTo: "hosted"`, codex instrumented). Then the session itself is hosted. Capture, delivery, steering, interrupt and gating come from it, and the mode may declare each of them up to what its hosted mode does, while keeping the vendor UI is the TUI's own claim. The session takes the TUI's turns as `externalTurns()` and stays up while a TUI is attached.

`barry start` in such a mode attaches before it launches (`POST /sessions/:id/attach`, held for the CLI's pid) and detaches however the TUI goes; an attachment whose CLI died is freed within a minute. Leaving ends the attachment, not the session, which carries on hosted. Engines stop with the API process, so restarting the API closes an attached TUI; the session resumes on its next message.

`--mode guest-plus` still means `instrumented`. Barry has full control exactly when it holds the engine handle; the other two are guest mechanisms, partial by construction, and declared rather than inferred.

A hosted mode is a `start()` returning a `Session`. How it runs is the adapter's choice and not a mode: claude runs one live Agent SDK query across turns, and one query per turn for a session that runs once; codex runs an app-server engine the instrumented TUI can attach to; opencode runs a hosted server, while its guest TUI launches independently and its instrumented slot is unavailable; cursor runs `cursor-agent acp` (why ACP, and what it does not report, is recorded in [its modes](sessions/cursor/src/modes.ts)). A launch mode is a `plan()` returning the command and the doors it opens.

Every adapter answers all three slots: `null` means "not today" and is a complete answer. Every declared mode carries its `guarantees` (capture, delivery, steer, interrupt, gating, keepsVendorUi, identity), the `verifiedOn` build they were shown against, and `evidence` naming a check someone else can run. `checkAdapter` refuses a declared mode with no implementation, and a guest tier claiming `capture: "total"`, `interrupt` or per-call gating — those need the handle.

A session records the mode, guarantees and harness version of what actually ran, never the adapter's defaults. Where it observes a harness build other than its mode's `verifiedOn`, its guarantees are marked unverified rather than reported as fact.

## ACP

The Agent Client Protocol is an open standard, so both directions live outside the adapters. Inward, [`acpHosted`](../sdk/src/acp/index.ts) is a hosted mode for any harness that speaks ACP on stdio. Outward, `barry acp` serves Barry as an ACP agent to an editor (Zed, JetBrains, Toad).

## Capabilities

Each adapter's `capabilities` (for example [Claude Code's](sessions/claude/src/capabilities.ts)) describe what Barry actually implements for that harness. A vendor CLI having a feature is not evidence that Barry uses it.

Native tools are provided by the harness's bag and restricted by bounds. Codex uses feature switches and a hook gate; OpenCode uses ordered permissions. Cursor reports tools it cannot control; a bound that requires denying those tools refuses launch. See [native tool bounds](../sdk/docs/bounds.md#native-tool-withholding) for each mode’s limits. A requested egress sandbox on an unsupported harness falls back to guards with a diagnostic. Do not present those sessions as having the same boundary as a supported sandbox.

Where the harness has no system-prompt surface, guidance goes in the prompt prefix. The action index remains necessary on harnesses that do not mount commands or skills. Native structured output is used where the mode declares it; elsewhere `runStructured` prompts and validates.

## Routing a model to another vendor

A harness speaks its own vendor's API. To run `vendor/model` on a harness:

- the harness's own vendor: no endpoint is passed, and the harness uses its own settings — Barry never overrides them;
- a vendor with a door compatible with the harness's vendor (z.ai and Ollama speak Anthropic's; Ollama also speaks OpenAI's): the session is pointed there, with that vendor's key;
- otherwise the session is refused before it starts.

Every harness now answers `withoutKey: "unauthenticated"`: a missing key refuses the session — no harness falls back to the user's own login, so there is no login to send anywhere. A bare model id means the harness's own vendor. Cursor and OpenCode connect themselves, so nothing is routed for them; opencode pins the session provider's key into its config so its own credential store cannot shadow the identity's.

## Requirements

Each adapter declares its binary, version probe, installation hints and advisory recommended version in `requirements`. Each mode declares its own supported ranges, tested builds and known incompatibilities in `versions`. Startup, doctor, setup and local schedule forecasts use the shared assessment. An untested build warns and runs; a documented incompatibility refuses startup with its reason. Vendor auto-update suppression keeps a running session stable without requiring an exact installed version.

An explicit executable override takes precedence, followed by declared current paths and the command on PATH. The version assessment and launch use the same resolver. Cursor uses the current installation rather than preferring a historic directory. Bundled Claude/Pi hosted modes are assessed against their SDK runtime independently of the PATH CLI. See [runtime versions](sessions/VERSIONS.md) for fields, overrides and current recommendations.

**Invariant I10 — Barry never permits an undeclared credential.** A session authenticates only through manifest-declared env vars read from declared sources. Each harness bag declares its credential env vars in `bag.yaml` (`credentials:`, vault items), an identity may define the same var with its own source (vault, `.env`, inline) and wins, and the session gate refuses — naming the fix — when a required credential has no definition or will not read. Vendor-login modes (a TUI on the user's own login, codex's `auth.json` link, opencode's own store, the claude subscription opt-in) are refused entirely: they authenticate outside the identity's declared sources.

A TUI mode is allowed when the TUI cannot authenticate any other way than with the declared key. An env var alone rarely does that, because each harness has its own order for picking a credential and a stored login can come first. Each TUI mode therefore names how it rules the login out, and its live check proves it on a machine where a login exists:

| Harness | How the TUI is tied to the identity's key |
|---|---|
| claude-code | The key reaches the TUI only through an `apiKeyHelper` in its settings, which claude never asks about and ranks above `/login`. Every competing credential variable is removed from its env. |
| antigravity | A persistent per-session home whose settings set `modelProvider: "gemini"`, with the identity’s `GEMINI_API_KEY` in env. It never uses the user’s Google OAuth home. |
| opencode | A per-session data dir with no stored credential, and the identity's keys in env. |
| codex | A per-session `CODEX_HOME` with no `auth.json`, and a provider Barry declares there that reads `OPENAI_API_KEY` from the session env. Codex's built-in provider reads only a login. Instrumented gives the TUI no credential at all: it is a client of Barry's engine, which authenticates through that provider. |
| cursor | A per-session `HOME`, so cursor finds no keychain login, no `~/.cursor` config, MCP servers or hooks, and no `~/.claude` hooks, with `CURSOR_API_KEY` in env and `AGENT_CLI_CREDENTIAL_STORE=memory`. In the user's home cursor sends their stored login's token at startup even when a key is set, and saves the key's token over that login in the keychain. Hosted runs in the same kind of home. |

A TUI mode's gate is installed by Barry but runs inside the vendor's TUI. Where that TUI lets its operator switch hooks off (codex: `/hooks`, `/approvals`, `/permissions`), the operator can widen what the session may do. Barry turns the gate back on where it holds the engine (codex instrumented), and the mode's documentation says so where it can't.

## Cursor contracts

Hosted cursor speaks ACP, and Barry names its tool calls from what cursor says of them (`identifyTool`): a title such as `MCP: tool` or a shell command is not a name a denial list or server bound can match. Each session's home is seeded with an empty allowlist, or cursor runs `ls` without asking. ACP sessions and the TUI's chats are separate stores; a conversation one cannot open starts afresh, with Barry's own history.

In the TUI, `preToolUse` names an MCP call only as `MCP:<tool>`, so Barry's gate checks the server at `beforeMCPExecution`. Cursor's public plugins (Linear, Notion, Slack) come from its backend for the account and load into every session; the gate, and over ACP Barry's per-call ruling, keep them from running.

Cursor denial configuration is written to the temporary workspace's `.cursor/cli.json`. The child process must start in that workspace; `--workspace` alone does not make Cursor load the permission file. Reach the user's repo via the additional-directory mechanism. Cursor has no permission kind for every tool, so unsupported denials must be reported. These contracts are covered in the Cursor adapter's tests, its launch goldens and its opt-in live check.

## Models and local inference

The model list is [`shipped-models.yaml`](../sdk/src/adapters/models/vendors/shipped-models.yaml), and it is advisory. Unknown ids may proceed, and failed live discovery must be marked stale rather than looking like a complete account list. Project configuration can affect discovery, so requests for a new session should supply its repository path.

### Running on Ollama

`barry start --ollama` runs Claude Code against a local Ollama daemon on the model list's default model. Add `-m <model>` for any installed model, including ones missing from `shipped-models.yaml`: the route follows the selected vendor, not the model name. `--model-provider ollama` is the general form. To make it an identity's default, run `barry identity adapters set claude-code --model <model> --provider ollama`. That writes `adapters.claude-code.model: ollama/<model>` in `identity.yaml`. API sessions and drafts accept `modelProvider`; the session records it as `model_provider`, and `barry session resume` restores it.

The daemon address is `BARRY_OLLAMA_URL`, read from the session's environment (so an identity's `.env` can set it), then Ollama's own default address, which [`shipped-models.yaml`](../sdk/src/adapters/models/vendors/shipped-models.yaml) carries. An unreachable daemon is reported, never replaced by a hosted endpoint, and Ollama always receives a placeholder key rather than your Anthropic credential.

Before launch, the CLI checks whether the model makes a real tool call and prints one line: `tool call ok`, `no tool call` (with what the model said instead), `model is not installed`, `unreachable`, `timed out`, or `probe error`. The session launches regardless. A failed check means that probe did not see a tool call; a passing check does not promise the model will keep calling tools, which is why the small-model warning prints either way.

Small local models can return plausible descriptions of tool use without making a tool call when the prompt and toolset become large. The September 2026 probes of qwen3:4b found this beyond roughly 25–35 tools depending on prompt size. That is a measured configuration limit, not a promise about every model. Probe actual tool-call blocks and side effects; a live Ollama daemon proves only connectivity. Hiding all tools behind search also adds a reasoning step and is not automatically a remedy.

## Add an adapter

Write a package whose default export is `defineAdapter({...})`: declare its capabilities and requirements, answer every mode slot, and implement each mode you declare. Then `barry adapter add <path>`. Harness ids are open, so nothing in Barry's contracts or stores needs an edit.

Declare today's truth, not the plan. A mode you have not verified is `null`, not an optimistic entry — `null` costs nothing, while a guarantee no session can honour is reported to senders and shown in the UI as if it were real. When you do verify one, `evidence` must name a check someone else can run.

An adapter’s optional `experimental` reason names the evidence still missing. Antigravity carries this mark: its hosted checks use a scripted Gemini endpoint, and V02–V04 still need verification against Gemini’s real API. The CLI prints the reason when listing adapters, and Antigravity warns when a session starts.

Claude hosted rules available tool calls in its shared PreToolUse hook. It fails closed before a ten-minute ruling window ends, retaining Barry’s refusal reason. Native tools are controlled by the session's bounds and harness bag.

The launch version guard does not infer incompatibility from a major, minor or calendar month change. Exact tested builds establish guarantee evidence; supported ranges express compatibility expectations. Unknown versions remain unverified. The former `BARRY_HARNESS_VERSION_CHECK=off` does not bypass a documented incompatibility or mandatory tool bounds.

