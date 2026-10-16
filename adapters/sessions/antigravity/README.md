# @barry-rocks/session-antigravity

Install this adapter independently:

```sh
npm install @barry-rocks/session-antigravity
```

The default export is the Barry session adapter declaration. Importing it reads capabilities and native-tool policy; starting a session is explicit. The package ships compiled ESM, declarations and its native-tool bag manifest for Node 26.

```ts
import adapter from "@barry-rocks/session-antigravity";

console.log(adapter.id, adapter.defaultMode);
```

Barry owns identity credentials, traits and bounds. Installing the adapter does not grant access or borrow a shell credential. Provider executables and accounts are separate requirements; inspect the declaration's requirements and modes before starting a session.

Select the installed package explicitly with `barry adapter add ./node_modules/@barry-rocks/session-antigravity`. Barry does not register sibling session packages automatically. Listing model choices requires the caller's selected environment; providers must not use an ambient account credential.

The package declares `barry.sessionAdapter.contractVersion: 1` and exports compiled ESM. After upgrading it, reselect its package directory with `barry adapter add`. Use `barry adapter remove <adapter-id>` to remove its selection while preserving package files and registered bag data.

## Connection, environment and modes

Hosted mode starts the Antigravity process against its Gemini provider and captures its stream. Instrumented and guest modes retain the vendor UI with hooks and transcript capture; their delivery and interruption guarantees differ. Hosted is the default. Declare the provider credential through the selected Barry identity; installation alone supplies no account.

Two credentials are possible, and they spend different quotas. `GEMINI_API_KEY` on the identity (the default) makes agy skip sign-in and spend the quota of the Google Cloud project that issued the key, which is the free tier unless that project has billing linked; a paid plan on a Google account does nothing for such a key. `ANTIGRAVITY_AUTH=google-account` instead rides the Google account agy is signed into on this Mac. A session's env carries only PATH, HOME and the credentials this manifest declares, so the switch is read from the session env first, the host process env second, and the instance env file (`~/Library/Application Support/Barry/env`) last; `sessions.api` reads the file on each start, so set it there and restart the service once. With it set, the adapter copies `~/.gemini/antigravity-cli/antigravity-oauth-token` into the session's isolated home on every start, leaves `modelProvider` out of its settings, and keeps any `GEMINI_API_KEY` away from the process, since a key in the env would win. It refuses to start when agy has not been signed in (`agy` once, interactively). This is the one place a Barry session rides a credential that was not declared on the identity, which is why it is an explicit opt-in and not a fallback. Read `src/modes.ts` for the verified version and evidence limits: scripted endpoint checks do not certify a real Gemini conversation. None of these modes declares an egress sandbox.

Hosted cancellation follows the [shared Session contract](../../../sdk/src/sessions/README.md):
interrupt acknowledges a request; the runtime owns the completion deadline. Close aborts startup,
releases owned resources, and ends an open reader once. Shared conformance tests exercise this adapter.

The tool gate permits `view_file` on agy's saved MCP results
(`brain/<conversation-uuid>/.system_generated/steps/<number>/output.txt`) and
MCP schema JSON files for configured servers and tools that are not denied,
inside the session's isolated `.gemini/antigravity-cli` directory. These reads
let agents consume large tool responses even when native filesystem access is
denied. The exception rejects symlinks and does not grant reads of credentials,
settings, transcripts, or repository files.
