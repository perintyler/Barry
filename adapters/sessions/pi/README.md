# @barry-rocks/session-pi

Install this adapter independently:

```sh
npm install @barry-rocks/session-pi
```

The default export is the Barry session adapter declaration. Importing it reads capabilities and native-tool policy; starting a session is explicit. The package ships compiled ESM, declarations and its native-tool bag manifest for Node 26.

```ts
import adapter from "@barry-rocks/session-pi";

console.log(adapter.id, adapter.defaultMode);
```

Barry owns identity credentials, traits and bounds. Installing the adapter does not grant access or borrow a shell credential. Provider executables and accounts are separate requirements; inspect the declaration's requirements and modes before starting a session.

Select the installed package explicitly with `barry adapter add ./node_modules/@barry-rocks/session-pi`. Barry does not register sibling session packages automatically. Listing model choices requires the caller's selected environment; providers must not use an ambient account credential.

The package declares `barry.sessionAdapter.contractVersion: 1` and exports compiled ESM. After upgrading it, reselect its package directory with `barry adapter add`. Use `barry adapter remove <adapter-id>` to remove its selection while preserving package files and registered bag data.

## Connection, environment and modes

Hosted mode runs the pinned Pi SDK in process and connects to the selected model provider. It is the only available mode; instrumented and guest launches are refused. Bind the provider's credential variable in the Barry identity. The credential resolver reads that declared environment, rather than Pi's `auth.json` or `models.json`. Barry preserves Pi's normal session and agent directories and does not redirect `PI_CODING_AGENT_DIR`. The adapter does not declare an egress sandbox. See `src/modes.ts` and `src/credentials.ts` for the supported guarantees and required keys.
