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

Hosted mode starts the Antigravity process against its Gemini provider and captures its stream. Instrumented and guest modes retain the vendor UI with hooks and transcript capture; their delivery and interruption guarantees differ. Hosted is the default. Declare the provider credential through the selected Barry identity; installation alone supplies no account. Read `src/modes.ts` for the verified version and evidence limits: scripted endpoint checks do not certify a real Gemini conversation. None of these modes declares an egress sandbox.
