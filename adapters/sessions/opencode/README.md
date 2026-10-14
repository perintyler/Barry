# @barry-rocks/session-opencode

Install this adapter independently:

```sh
npm install @barry-rocks/session-opencode
```

The default export is the Barry session adapter declaration. Importing it reads capabilities and native-tool policy; starting a session is explicit. The package ships compiled ESM, declarations and its native-tool bag manifest for Node 26.

```ts
import adapter from "@barry-rocks/session-opencode";

console.log(adapter.id, adapter.defaultMode);
```

The adapter is verified against opencode 2.0.24, from the `@opencode/cli` npm package (`npm install -g @opencode/cli@2.0.24`). The `opencode-ai` package is the 1.x line, which this adapter cannot drive; both install a binary named `opencode`, so `barry adapter doctor` is the way to see which one a launch resolves. To check the declared guarantees against the installed binary — with a local fake for the model and MCP server, so nothing is spent:

```sh
BARRY_OPENCODE_LIVE=1 pnpm exec vitest run src/live
```

Barry owns identity credentials, traits and bounds. Installing the adapter does not grant access or borrow a shell credential. Provider executables and accounts are separate requirements; inspect the declaration's requirements and modes before starting a session.

Select the installed package explicitly with `barry adapter add ./node_modules/@barry-rocks/session-opencode`. Barry does not register sibling session packages automatically. Listing model choices requires the caller's selected environment; providers must not use an ambient account credential.

The package declares `barry.sessionAdapter.contractVersion: 1` and exports compiled ESM. After upgrading it, reselect its package directory with `barry adapter add`. Use `barry adapter remove <adapter-id>` to remove its selection while preserving package files and registered bag data.

## Connection, environment and modes

Hosted mode starts a private OpenCode 2.x server per session and uses its streaming API. Guest mode starts the vendor TUI with a standalone private server; instrumented mode is unavailable. Hosted is the default. Barry constructs session-local configuration and data directories and supplies provider credentials from the identity's declared environment. The server must not borrow a background service's configuration. These modes do not declare an egress sandbox; see `src/modes.ts` for the separate capture, delivery and gating guarantees.
