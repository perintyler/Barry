# @barry-rocks/session-cursor

Install this adapter independently:

```sh
npm install @barry-rocks/session-cursor
```

The default export is the Barry session adapter declaration. Importing it reads capabilities and native-tool policy; starting a session is explicit. The package ships compiled ESM, declarations and its native-tool bag manifest for Node 26.

```ts
import adapter from "@barry-rocks/session-cursor";

console.log(adapter.id, adapter.defaultMode);
```

Barry owns identity credentials, traits and bounds. Installing the adapter does not grant access or borrow a shell credential. Provider executables and accounts are separate requirements; inspect the declaration's requirements and modes before starting a session.

Select the installed package explicitly with `barry adapter add ./node_modules/@barry-rocks/session-cursor`. Barry does not register sibling session packages automatically. Listing model choices requires the caller's selected environment; providers must not use an ambient account credential.

The package declares `barry.sessionAdapter.contractVersion: 1` and exports compiled ESM. After upgrading it, reselect its package directory with `barry adapter add`. Use `barry adapter remove <adapter-id>` to remove its selection while preserving package files and registered bag data.

## Connection, environment and modes

Connects to the selected Cursor agent CLI and its configured model service. Supported modes: hosted, instrumented and guest; the default is hosted. Credentials and the launch environment come from the selected identity. Inspect the requirements before assuming a vendor account is usable. Registration is separate from execution and grants no credentials. See the [adapter declaration](src/adapter.ts) and its requirements for the selected build’s actual guarantees.

Hosted cancellation follows the [shared Session contract](../../../sdk/src/sessions/README.md):
interrupt acknowledges a request; the runtime owns the completion deadline. Close aborts startup,
releases owned resources, and ends an open reader once. Shared conformance tests exercise this adapter.
