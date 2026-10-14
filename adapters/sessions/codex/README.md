# @barry-rocks/session-codex

Custom endpoint URLs must implement the OpenAI Responses API. The pinned Codex
build no longer accepts `wire_api = "chat"`; a Chat Completions-only endpoint
cannot be used directly. Configuration loading does not establish that a backend
implements Responses: verify a real turn against the selected backend.

Install this adapter independently:

```sh
npm install @barry-rocks/session-codex
```

The default export is the Barry session adapter declaration. Importing it reads capabilities and native-tool policy; starting a session is explicit. The package ships compiled ESM, declarations and its native-tool bag manifest for Node 26.

```ts
import adapter from "@barry-rocks/session-codex";

console.log(adapter.id, adapter.defaultMode);
```

Barry owns identity credentials, traits and bounds. Installing the adapter does not grant access or borrow a shell credential. Provider executables and accounts are separate requirements; inspect the declaration's requirements and modes before starting a session.

Select the installed package explicitly with `barry adapter add ./node_modules/@barry-rocks/session-codex`. Barry does not register sibling session packages automatically. Listing model choices requires the caller's selected environment; providers must not use an ambient account credential.

The package declares `barry.sessionAdapter.contractVersion: 1` and exports compiled ESM. After upgrading it, reselect its package directory with `barry adapter add`. Use `barry adapter remove <adapter-id>` to remove its selection while preserving package files and registered bag data.

## Conversation retention

Hosted and guest conversations live under Barry’s cache directory at `codex-homes/<instance>/<session-digest>`. `CODEX_HOME` is a short temporary symlink to that directory; preparation restores an alias after temporary-directory cleanup or reboot, and transcript discovery scans durable homes directly. Existing directory homes migrate on their next preparation. Clearing Barry’s cache deliberately removes these conversations; they are excluded from Time Machine.

The daily `codex/home-retention` job reads session closure through the authenticated local API. It removes owned, unpinned homes only when both closure and the last runtime preparation are at least 30 days old. Live, recent, pinned, unknown and unreadable sessions are kept, as are legacy homes without an ownership marker. A filesystem lock serializes preparation with retention; an abandoned lock keeps the home until the owner investigates it. Ephemeral homes remain temporary and are removed when their hosted session closes or their guest launch is cleaned up.

## Connection, environment and modes

Connects to the selected Codex CLI app-server over a local socket. Supported modes: hosted, instrumented and guest; the default is hosted. Barry supplies the selected identity’s model credentials and a private `CODEX_HOME`; do not substitute a shared vendor home. Registration is separate from execution and grants no credentials. See the [adapter declaration](src/adapter.ts) and its requirements for the selected build’s actual guarantees.
