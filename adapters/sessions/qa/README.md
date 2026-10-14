# Adapter acceptance

Run from the repo root on Node 26. The runner prints the selected adapter’s resolved SDK package path. It creates a new scratch Barry home, stores, repository and vendor home. It removes ambient credentials and preserves `evidence.json`, `events.json`, the MCP ledger and SQLite store. It never changes the support CSV.

```sh
node --import tsx adapters/sessions/qa/run.ts --adapter codex --offline --model openai/gpt-5.5
node --import tsx adapters/sessions/qa/run.ts --adapter codex --offline --model openai/gpt-5.5 --negative-control
node --import tsx adapters/sessions/qa/run.ts --adapter claude --offline --model anthropic/haiku
node --import tsx adapters/sessions/qa/run.ts --adapter antigravity --offline --model google/gemini-3.8-flash-high
node --import tsx adapters/sessions/qa/run.ts --adapter pi --preflight
node --import tsx adapters/sessions/qa/run.ts --adapter opencode --preflight
node --import tsx adapters/sessions/qa/run.ts --adapter claude --model anthropic/claude-sonnet-5 --env /path/to/test-credentials.json
```

`--adapter` accepts claude, codex, cursor, opencode, pi and antigravity. Credentials are an explicit JSON object of vendor environment variables. Use a test account. No login is copied from the user's vendor history. `--timeout-ms` defaults to 120000 per turn. Artifacts may contain prompts/tool contents; the runner never writes credential variables to its evidence.

| Check | Runner evidence | Remaining scope |
| --- | --- | --- |
| V02 | Two turns, session link, two MCP ledger calls with exact Barry context, persisted messages and correlated result | API, installed CLI, actions and ephemeral paths |
| Native denial | Forced native call refused by the vendor exclusion or hook; refusal reaches the model and no sentinel appears | Other native tools and other modes |
| V03 | Process closed and exact conversation resumed; original random marker recalled | Real model when using `--offline`; runtime restart |
| V04 | Newer decoy before exact older target; Codex also checks missing-target refusal | Missing-target refusal for other adapters |
| Preflight | Actual engine connects; Pi's active tools contain only the probe tools | No conversation or support certification |

The offline Codex, Anthropic Messages and Gemini endpoints script the model responses while running the real vendor binary, MCP transport and Barry recorder. Its request log proves what the vendor exposed and retained. It is not a simulation of Codex. A preflight or mocked unit test cannot check off a broad support cell. Use the full verification plan in `barry-plans/adapter-parity/verification.md` before certification.

For a worktree with shared package symlinks, use a temporary tsconfig mapping local package exports to the worktree's sources and set `TSX_TSCONFIG_PATH`. Otherwise the runner can test the main checkout's code instead.

Codex offline forces apply_patch and the three native MCP resource helpers and requires runtime hook denials. Claude forces Bash and checks its native-exclusion refusal reaches the model; Antigravity forces run_command and checks its hook refusal. Every case checks that no sentinel was created. `--negative-control` removes only the scratch guard; that run must fail because the native sentinel is created. Ensure PATH resolves OpenCode 2.x; this adapter does not speak the 1.x protocol.

## Connections, environment and modes

This directory is an acceptance harness, not an installable session provider. `--offline` connects a real vendor process to scripted local endpoints; `--preflight` checks engine connectivity without a conversation; a run without either flag connects to the configured vendor. Supply test credentials explicitly with `--env`, and select an adapter with `--adapter`. These harness switches do not change the adapter's declared hosted, instrumented or guest support. A successful offline run does not certify live vendor behavior.
