# @barry-rocks/session-claude

Install this adapter independently:

```sh
npm install @barry-rocks/session-claude
```

The default export is the Barry session adapter declaration. Importing it reads capabilities and native-tool policy; starting a session is explicit. The package ships compiled ESM, declarations and its native-tool bag manifest for Node 26.

```ts
import adapter from "@barry-rocks/session-claude";

console.log(adapter.id, adapter.defaultMode);
```

Barry owns identity credentials, traits and bounds. Installing the adapter does not grant access or borrow a shell credential. Provider executables and accounts are separate requirements; inspect the declaration's requirements and modes before starting a session.

Select the installed package explicitly with `barry adapter add ./node_modules/@barry-rocks/session-claude`. Barry does not register sibling session packages automatically. Listing model choices requires the caller's selected environment; providers must not use an ambient account credential.

The package declares `barry.sessionAdapter.contractVersion: 1` and exports compiled ESM. After upgrading it, reselect its package directory with `barry adapter add`. Use `barry adapter remove <adapter-id>` to remove its selection while preserving package files and registered bag data.

## Directory trust

TUI launches retain Claude's folder-trust prompt for ordinary repository directories. A directory-creating composition root may supply `options.barryCreatedDirectory`; only an exact canonical match with the launch cwd permits pre-acceptance. In that case Barry atomically updates the project trust entry in `~/.claude.json`, preserves unrelated fields and writes a 0600 replacement. This shared-file courtesy does not serialize independent vendor writes. Failures leave Claude's interactive prompt in place. The attestation is internal launch metadata, not inferred from a project's settings or arbitrary cwd.

## Connection, environment and modes

Connects to Claude Code’s selected CLI build and Anthropic-compatible model endpoint. Supported modes: hosted, instrumented and guest; the default is hosted. The selected identity must provide its configured model credentials; the Claude route requires `ANTHROPIC_API_KEY`. Registration is separate from execution and grants no credentials. See the [adapter declaration](src/adapter.ts) and its requirements for the selected build’s actual guarantees.
