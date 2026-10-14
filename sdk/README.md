# Barry SDK

The TypeScript SDK for connecting to Barry and authoring bags. The package ships compiled ESM and TypeScript declarations. It requires Node 26 for Node-specific modules; the HTTP client can also run in browsers.

The SDK is not published to npm. Packages in this repository depend on it with `workspace:*`. A bag in its own repository links the SDK of the installation Barry runs from: `barry new <bag> --server` writes that `link:` dependency.

Connect to an explicitly configured API:

```ts
import { Barry } from "@barry-rocks/sdk";

const barry = Barry.at({ baseUrl: "https://barry.example", secret: token });
for await (const session of barry.identity("bux").sessions()) {
  console.log(session.id);
}
```

Handles and collections make no network requests until used. Collections fetch pages on demand. Failures throw `BarryError`, with a reason, message, and optional hint. Writes are not automatically retried.

A Node application that hosts no subjects can discover this machine's instance explicitly:

```ts
import { Barry } from "@barry-rocks/sdk";
import { localConnection } from "@barry-rocks/sdk/services";

Barry.connect(await localConnection());
const sessions = await Barry.identity("bux").sessions();
```

An explicit `secret` bypasses local credential discovery. `Barry` uses the transport its caller installs or supplies. Hosting code that needs the raw HTTP client imports it from `/internal/client`; that entry carries no compatibility promise.

Bag authors use `Barry.Tool` and `Barry.bag` from `@barry-rocks/sdk`. Subject modules expose tools, traits, bounds, identities, sessions, instructions, actions, apps, workflows and stores. See [module ownership](docs/modules.md), [bags](docs/bags.md) and [bounds](docs/bounds.md).

Library imports do not start Barry. Application entry points start services only when invoked. Concrete session, decision and completion adapters are separate packages. Swift apps use BarryKit, a separate repository; `pnpm contracts:generate` writes its OpenAPI spec.

From the repository, `pnpm check:sdk-package` builds and packs the SDK, installs the tarball outside the workspace, checks every exported file, and exercises strict TypeScript, the HTTP client and workflow snapshot/restore under plain Node.

Setup records shipped call-code packages; use `barry adapter model add <package-directory>` for packages Barry does not ship. `barry adapter model list` reports selections and load refusals; `check` validates the selected contracts; `remove <package-name>` removes a selection and preserves its package files. The model-provider contract is `barry.modelProvider` in package.json, with `contractVersion: 1` and the name of its exported factory maps in `factoryExport`.

Node composition roots can load the same selection registry:

```ts
import { loadModelProviders } from "@barry-rocks/sdk/adapters/models";
import { barryModelProvidersPath } from "@barry-rocks/sdk/services";

const providers = loadModelProviders({ file: barryModelProvidersPath() });
const factories = await providers.load();
```

Reading selections loads no provider code. `load([packageName])` imports only the named registered packages. Empty installations choose no default provider. Unavailable packages and conflicting factories are skipped and reported in `providers.refused`; healthy selections still load. Provider selection never supplies credentials or grants execution permissions. Application entry points read this registry instead of importing every model provider.

One-off schedules accept explicit `identity`, `traits` and `bounds` selections in their options. Identity-free script schedules must select a trait that grants `bash.Bash`; an omitted or empty selection grants nothing. The SDK preserves those fields, including explicit empty arrays, on the request wire.

Session packages are selected separately with `barry adapter add <package-directory>`. Reading an installation's adapter registry never discovers sibling packages or bootstraps its bag store. Barry setup/start owns baseline policy bootstrap and preserves intentionally deleted optional traits. Adapter `listModels` receives an explicit environment; discovery must not borrow an ambient provider key or user login. Cursor's executable resolution loads only its selected adapter.

## Session streaming

Use the existing AG-UI connection for Barry's version-2 session execution protocol:

```ts
import { AgUiConnection } from "@barry-rocks/sdk/apps";

const connection = new AgUiConnection({
  baseUrl: "https://barry.example/api/v2/sessions",
  secret: token,
});
try {
  for await (const { cursor, event } of connection.subscribe(sessionId, {
    signal: controller.signal,
    reconnect: { maxAttempts: 3, delayMs: 250 },
  })) {
    render(event);
    saveCursor(cursor);
  }
} finally {
  connection.close();
}
```

Subscriptions are lazy and read on consumer demand. Persist a delivered cursor and pass it as `after` to resume later. Optional reconnects issue GET requests only, use exponential delays capped at 30 seconds and allow at most ten attempts across one subscription. Replay duplicates are suppressed, including individual frames within a committed sequence. Clean EOF ends the subscription when the reconnect budget is exhausted; transient failures then throw. Authorization and malformed responses never reconnect. Run, queue and cancellation writes are never automatically retried.

Legacy WebSocket session/topic publications require an installation credential. Each queued frame rechecks that original credential before its socket write; rotation closes the connection and drops pending frames. Devices use scoped v2 event subscriptions. Legacy queues allow at most 128 pending frames and 1 MiB including buffered socket bytes; consumers exceeding either bound close with code 1013 and must reconnect. Event and identity announcement responses report `queued`, the number of accepted publications. This count does not confirm client receipt: authorization or transport failures can still discard queued frames.

All operations accept request controls with `signal` and `timeoutMs`. JSON deadlines cover the complete response; streaming deadlines cover connection and response headers, so an established subscription can remain open. Cancellation, early iterator return and `close()` release its reader; close also cancels pending JSON requests and backoff. Errors use `BarryApiError` with status, code and request ID. The subscription options object replaces positional cursor/signal arguments.

Session packages declare `barry.sessionAdapter: { contractVersion: 1 }` and export compiled ESM. The registry validates saved declarations, names and ownership without importing packages during a data read. Add/remove mutations refuse concurrent writers; ordinary loads remain concurrent and never rewrite selections. Changed package versions or declarations require explicit `barry adapter add <package-directory>` reselection. `barry adapter remove <adapter-id>` accepts a registered alias and preserves package files and bag data. Runtime modules with unsupported contracts, missing/escaping entries or conflicting names are rejected before selection.


## Request credentials

Use `secret` for a fixed bearer token, or `resolveCredential` for a token that can rotate:

```ts
Barry.connect({
  baseUrl: "https://barry.example",
  resolveCredential: async ({ signal }) => tokenStore.getValidToken({ signal }),
});
```

Both `Barry.connect` and `AgUiConnection` accept this option. Supply exactly one credential source. Construction performs no authentication work; the resolver runs once per request, including subscription reconnects. Tokens are never cached by the SDK. The request deadline and cancellation include credential resolution. Resolvers should honor the supplied signal; even if they ignore it, cancellation ends the SDK operation and prevents a late token from sending a request. Resolver failures produce `BarryError` with reason `unavailable` through Barry, or `BarryApiError` with `credential_error` through the internal HTTP client and AG-UI connection. Messages redact the credential; failures do not retry. Credentials must be nonempty strings without whitespace. No client reads ambient credentials.


## Create and update a session

Barry’s hosting packages use the internal HTTP client for these low-level operations:

```ts
import { BarryClient } from "@barry-rocks/sdk/internal/client";

const client = BarryClient.connect({ baseUrl: "https://sessions.example", secret: token });
const created = await client.sessions.create({
  systemPrompt: "Assist with the project",
  identityId,
  prompt: "Review the repository",
}, { signal: controller.signal });

if ("started" in created && created.started === false) {
  console.error(created.startError); // The session exists; its first turn failed to start.
}
await client.sessions.update(created.id, { name: "Repository review", pinned: true });
```

Omit `prompt` to create an idle session before subscribing with `AgUiConnection`. With a prompt, the result retains `started: true` or `started: false` with `startError`; a successful HTTP creation does not promise a running turn. Inputs are validated before credential resolution or HTTP. Updates preserve omitted fields and allow explicit empty traits or null bounds. `prompt` and `useWorktree` are creation fields and are rejected on update. Session writes are never automatically retried.


## Identity administration

Identities run on their own service. Configure that endpoint and its credentials explicitly:

```ts
import { BarryClient } from "@barry-rocks/sdk/internal/client";

const client = BarryClient.connect({
  baseUrl: "https://sessions.example",
  resolveCredential,
  identities: { baseUrl: "https://identities.example", resolveCredential },
});
const { identity, warnings } = await client.identities.create({
  name: "assistant", bags: ["filesystem"], traits: [],
});
for (const warning of warnings ?? []) console.warn(warning.message);
await client.identities.update(identity.id, { displayName: "Project assistant" });
const effective = await client.identities.effective({ repoPath: "/projects/example" });
```

Remote clients never forward the root credential to another service automatically. Supply that service's `secret` or `resolveCredential`, plus optional `fetch` and `timeoutMs`. An unconfigured identity service throws `service_unconfigured` without sending a request; session operations remain usable. `connectLocal` discovers `identities.identities` in the selected instance's registry and uses the selected installation credential, with explicit service options taking precedence. Missing registrations never fall back to the sessions endpoint.

`identities.list()` returns records, `get(id)` returns a record or null on 404, and create/update retain any successful mutation warnings. `effective()` retains the selection source and repository root. Database IDs and stable file identity IDs in the reserved positive range are supported. Inputs are validated before requests; omitted update fields remain untouched, while empty lists and null bounds explicitly clear settings. Identity writes use the same cancellation/deadline/error behavior as other JSON operations and are never automatically retried.

Service control uses its own MCP endpoint: `Barry.at({ baseUrl, secret, services: { baseUrl: mcpUrl, secret } }).services()`. A service handle provides `get()`, `start()`, `stop()` and `restart()`. `localConnection()` from `@barry-rocks/sdk/services` fills `services` from the registry's `mcp.server`, so `Barry.at(await localConnection()).services()` works on this Mac; session callers cannot send control over HTTP.


## Authorization contracts

`@barry-rocks/sdk/internal/auth` supplies the scope and principal types used by Barry’s Node services. Device grants enumerate scopes and identity IDs explicitly; wildcard/admin grants are rejected, and artifact sharing requires read access. Parsed device principals and their grant arrays are frozen. `hasScope` and `hasIdentityGrant` check a principal supplied by a trusted verifier; parsing a shape does not authenticate a caller. Installation principals remain separate from device credentials. Services must also enforce the target resource's ownership and execution policy.

Node services use `authorizeRequest` from `@barry-rocks/sdk/internal/auth`, or pass its options to `applyAuth(app, options)`. Supply a trusted `verifyCredential(credential, signal)` and a `policy(request)` returning required scopes plus an `authorize(principal, request, signal)` resource check. Device requests without a policy are forbidden. Verified installation principals retain operator access; handlers still enforce ownership. The middleware binds an immutable `request.authPrincipal`, rejects malformed/conflicting/duplicate credential headers, and bounds verification and resource checks with one deadline (five seconds by default, configurable up to sixty seconds). Failed verification returns 401, denied scope/resource access 403, and unavailable verification 503 without exposing credential or store errors. Verifiers should honor cancellation. For an admitted streaming request, `revalidateRequestAuthorization(request, signal)` rechecks its original credential and policy within the configured deadline. It returns false on rotation, revocation, changed actor/grants, resource denial, cancellation, timeout or verifier failure. The hook retains the original route, keeps the credential private and leaves `request.authPrincipal` unchanged; transport close releases its state. Stream implementations must stop publishing and clean up subscriptions when a recheck fails. Policy callbacks should capture validated resource identifiers for later checks.

Node transports can use `authenticateCredential` from `@barry-rocks/sdk/internal/auth` with their trusted verifier. `requestCredential` applies the same strict header parsing as HTTP. Invalid credentials return null; verifier failure or deadline expiry throws a redacted `Authorization unavailable` error. The returned frozen handle keeps its credential private, exposes the immutable principal, and offers `revalidate(signal)` plus `authorize({scopes, authorize}, signal)`. Each call rechecks the original credential and exact actor/grants under one bounded deadline. Resource predicates apply to installation operators too; device scopes are enforced before the predicate. Call `dispose()` on disconnect to cancel in-flight checks and release the credential. A transport must keep the handle server-owned and never accept one from client configuration.

Workflow harnesses use the Node-only `@barry-rocks/sdk/internal/auth` functions. A version-three `bws3` token binds a UUID `credentialId` to its actor, numeric identity, session, scope fingerprint and expiry (at most 24 hours). Minting signs claims; it does not issue or persist a run. The Sessions owner must first rotate its dedicated `workflow_credential_id` atomically against the expected owner, identity, scope and open/unended state. Pass that ID to `mintWorkflowSessionCredential`, then use `verifyWorkflowSessionCredentialForSession` against the current persisted record for every admission and retained transport check. Ending a run or changing its persisted session owner, identity or workflow scope clears the binding; reopening the same session requires a fresh ID and token. Metadata edits cannot restore a cleared ID. Version-two tokens are rejected.


The identities service currently permits device `GET /api/v1/identities/:id` only with `identities:read` and an explicit canonical identity grant. It verifies current database ownership and resolves the identity using the paired actor. Lists, mutations and other identity operations require operator access until their scoped policies are implemented.

The sessions API permits lists, member, message/detail, context and changes GETs with `sessions:read`. The stored session must belong to a granted canonical identity owned by the paired actor; any recorded session user must also match that actor. Sessions without an identity are unavailable to devices. Lists enforce ownership in SQL before pagination and retain the same access filter during message activity enrichment and physical-store selection. Scoped list responses currently omit event progress until scoped event access is implemented. Device member requests select their store partition from the authorized URL, ignoring body/query partition overrides. Device `GET /api/v2/sessions/:id/events` subscriptions additionally require `events:read` and `events:subscribe` and the same session ownership checks. Streams reverify the original credential and resource policy before their first frame and each later frame, and independently every second while idle or waiting for drain. Failure ends the stream and releases its timers and listeners. Identities-owned revocation notifications wake even blocked streams: local revokes signal after the transaction settles, and a pooled SQLite/WAL directory watcher observes other local services. Signals trigger authoritative credential/resource checks, coalesce bursts, and cause another check if a change arrives during verification. Periodic checks remain active when filesystem events are unavailable or lost. Installation verification observes the running process's current `BARRY_SECRET`; changing a secret file alone does not reload a running process. Search, writes, turns, AG-UI snapshots/runs and generic action/event routes remain unavailable until their resource and execution policies are implemented. Services use the identities bag's public `verifyRequestCredential` facade rather than importing its database implementation. Session lifecycle mutations and AG-UI run/cancel requests check the bound operator against the recorded session user and canonical identity before delivery, continuation or mutation side effects. A missing or foreign execution target returns a generic 403. AG-UI preparation forwards the verified principal separately and rechecks ownership before returning an existing active runtime or starting one. Runtime start/send/stop/interrupt/remove receive the verified principal separately from session configuration and repeat ownership checks. Device execution remains unavailable while full tool and execution-bound policies are completed.

## Device pairing

Pairing uses the identities endpoint. Public request and claim calls need no installation secret:

```ts
import { BarryClient } from "@barry-rocks/sdk/internal/client";

const phone = BarryClient.connect({
  baseUrl: "https://sessions.example",
  identities: { baseUrl: "https://identities.example" },
});
const pending = await phone.devices.requestPairing({
  clientName: "My phone",
  requestedScopes: ["sessions:read"],
  requestedIdentityIds: [1],
});
// Show this code to the local operator; keep the polling secret private.
console.log(pending.pairingCode);
const claim = await phone.devices.claimPairing(pending.pollToken);
if (claim.status === "authorized") {
  await saveCredential(claim.deviceToken);
}
```

Claim is one explicit poll, with a 1.5-second minimum interval. Handle `pending` (HTTP 202), `rejected` (403), and `expired`/`consumed` (410) states; authorized issuance uses HTTP 200. The SDK validates each status/state combination and returns all legitimate states as discriminated results. A lost successful claim requires pairing again. Pairing expires after five minutes, and an issued credential unused for ten minutes expires. Keep poll/device credentials out of URLs and logs. All operations accept cancellation and deadlines; claim and approval are never automatically retried.

An operator client explicitly supplies installation credentials in `identities`. `devices.pending()` reviews requests, `authorize(code, grant)` approves a reduced scope/identity grant, and `authorize(code, null)` rejects it. `devices.list()` returns safe credential metadata; `revoke(id)` is idempotent. Management accepts installation credentials only and derives the operator from the durable installation-owner binding. The owner migration pins a sole existing user. Before preparing or starting services, `barry setup` creates and binds a fresh local user in one transaction, preserves an existing binding, or binds the sole copied user without replacing its durable key. Multiple-user installations require `barry setup --owner <actor-id>`; `--yes` never chooses an arbitrary user. Use local `barry owner` to inspect owner/candidates, then `barry owner <actor-id>` to bind a reviewed user (`--yes` for unattended selection; `--json` for metadata). Binding pins the actor ID, durable token and user type with foreign keys; adding users or renaming one cannot change the owner. Replacing a bound owner is refused and requires an ownership migration. Background execution resolves the bound user rather than actor-list order. Named/inert session creation retains its selected user ID; runtime resumes use that recorded user and refuse a missing actor instead of switching owners. Missing ownership fails explicitly. CLI user lookup reads this binding and never creates a default user; provision ownership through setup or the owner command. The former first-user selection API has been removed.

The owner facade exposes `revalidateRequestPrincipal` for previously authenticated server principals. It reads current revocation, expiry, grant and ownership state without establishing a token or refreshing usage timestamps; changed grants invalidate the snapshot. It does not authenticate by actor/device ID, and transports must reverify their original credential to detect installation-secret rotation. Identity and session read policies revalidate before admitting a handler.

Approval currently requires canonical owned database identity IDs. `@barry-rocks/sdk/internal/auth` supplies the wire schemas and types used by the owner API and client. Device `/api/v2/ws` subscriptions use the same three read/subscription scopes and session ownership rules as SSE. They authorize before loading a snapshot and before every snapshot/event delivery, repeat resource checks while idle, and bound the send buffer. Socket admission binds an installation/device principal through the identities verifier, and independent credential rechecks close expired/revoked idle sockets. Devices cannot enter the legacy v1 socket protocol. Legacy operator mutations use the shared ownership guard and pass the principal separately to runtime start/send/stop/remove. The same identities-owned notifications wake idle sockets after changes from another local process; disposal releases their watcher subscription. Legacy topic/session broadcast per-emission checks and full device execution remain under implementation. Physical-node credential propagation/rotation still needs the infrastructure-phase verification.

## Entry points

Stable entries are versioned APIs for adapters and code outside this repository. Internal entries serve Barry's own packages, carry no compatibility promise, and may change in any release. Adapters and outside code use only stable entries.

| Entry | Purpose |
| --- | --- |
| `.` | Barry, domain handles and types, errors, connection options, credential resolver, tool context, store bindings |
| `/testing` | Subject fakes |
| `/tools` | Tools and prompts |
| `/bags` | Bag manifests, resources, types, and tool authoring |
| `/services` | Instance paths, addresses, hosting policy, test instances, and local connection options |
| `/services/http` | Service HTTP scaffolding and route registration |
| `/stores` | A bag's store, migrations, bindings, context, snapshots, and scratch guard |
| `/logging` | Node logging |
| `/logging/edge` | Workers logging without pino |
| `/auth` | Sign-in for a bag's web pages |
| `/apps` | AG-UI client |
| `/events` | Event schemas and bus |
| `/transcripts` | Transcript readers |
| `/ids` | Identifiers |
| `/http` | Adapter HTTP helper |
| `/acp` | Hosting a harness over ACP |
| `/mcp` | A bag's MCP server |
| `/bounds` | Bounds and guards |
| `/sessions` | Harness sessions |
| `/adapters/harnesses` | Harness adapters |
| `/adapters/models` | Model adapters, including decision models |
| `/openapi.json` | Published HTTP API |

Internal entries use `/internal/` followed by actions, adapters, auth, bags, client, env, hooks, identities, instructions, jobs, mcp, nodes, routes, schedules, services, sessions, stores, tools, traits, vault, or workflows.

A process hosting no subjects connects explicitly:

```ts
import { Barry } from "@barry-rocks/sdk";
import { localConnection } from "@barry-rocks/sdk/services";
Barry.connect(await localConnection());
```

## Versions

The SDK has a version of its own, in its `package.json`, separate from Barry's release version (the `v0.10.0-beta.N` tag that `barry --version` prints). It describes the stable entries above. Internal entries are not versioned.

- Below 1.0, a change that can break code using a stable entry raises the minor number. An addition or a fix raises the patch number.
- Each change is recorded as a changeset when it lands. Cutting a release turns the pending changesets into the next version and its entry in `CHANGELOG.md`, beside `package.json`. See [the changesets README](../.changeset/README.md).
- A release carries one SDK version. A bag linked to an installation's SDK finds the version and the changelog in that SDK's folder.
