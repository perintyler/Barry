# @barry-rocks/sdk/tools

Define a tool once and serve it over MCP. Requires Node 26 (at least 26.9) and zod 3.25 or 4.

```bash
pnpm add @barry-rocks/sdk@link:<path to barry>/sdk zod@^3.25.0
```

```ts
import { defineTool, startBagServer } from "@barry-rocks/sdk/tools";
import { z } from "zod";

const greet = defineTool({
  name: "greet",
  namespace: "my-bag",
  access: "read",
  description: "Say hello",
  schema: { name: z.string() },
  handler: async ({ name }) => `Hello, ${name}!`,
});

await startBagServer({ name: "my-bag", tools: [greet] });
```

Compile with TypeScript and run the resulting JavaScript with Node. Keep stdout
free of logging: it carries the MCP protocol. Use stderr for diagnostics.

## The tool contract

`schema` is a Zod object shape. MCP validates inputs and applies defaults before
calling the handler. Input types and the result type passed to `cliFormat` are
inferred. Calling a handler directly bypasses transport validation.

| Handler outcome | MCP response |
| --- | --- |
| String | Text |
| JSON value | Pretty-printed JSON text |
| `undefined` | Successful empty content |
| `mcpResult(response)` | Native MCP content, such as images, resources, or errors |
| Thrown error | Text error with `isError: true` |

An ordinary object is always data, even if it has a `content` or `isError` field.
Use `mcpResult` explicitly when returning an MCP response. Native responses are
validated before sending. Do not include secrets in errors; messages are not redacted.

An optional `outputSchema` declares a JSON Schema for an object result. It appears
in `tools/list`, and successful calls return both `structuredContent` and text.
The SDK validates the serialized result against that schema. Native responses
must supply matching `structuredContent`, unless `isError` is true. Invalid
output produces an error explaining that the handler already completed; check
its outcome before retrying a write. `_meta` is preserved for host extensions,
including MCP app views.

`namespace`, `access`, `secrets`, and `deferred` describe how Barry should host a
tool. They do not enforce authorization in a standalone server. `startBagServer`
exposes namespace/access metadata at `barry://tools-meta`; it does not resolve
credentials, inject `ToolContext`, or implement deferred discovery. Standalone
handlers can use their own credential source. Barry's in-process host supplies
session context and declared secrets. Prefer `context.sessionId` over an
environment variable when serving multiple sessions.

## Prompt contributors

A bag can add computed text to the system prompt of every session that loads it
— what `instructions/` cannot, because that prose is static:

```yaml
prompts:
  entry: prompt.ts
```

```ts
import { definePrompt } from "@barry-rocks/sdk/tools";

export default definePrompt(async ({ cwd, sessionId, provider }) => [
  { text: "## Something computed\n\n..." },
]);
```

Barry bundles the entry and runs it in a separate process at session start, in
both `barry start` and server sessions. It must finish in 1.5s and the whole
collection in 4s; a contributor that throws, hangs, exits, or returns anything
but `{ text }` sections is skipped with a warning naming the bag, and the
session starts anyway. A bag may contribute 9,000 characters and all bags
16,000; sections over budget are omitted whole and counted on a closing line.
Only local bags contribute. The memory bag is the reference implementation.

## Calling Barry from a bag

A bag's own code — a job, a hook script, a service — reaches Barry through the
package root:

```ts
import { Barry } from "@barry-rocks/sdk";

export async function sessionsFor(baseUrl: string, secret: string) {
  const barry = Barry.at({ baseUrl, secret });
  for await (const session of barry.identity("bux").sessions()) {
    console.log(session.id);
  }
}
```

Handles and collections make no requests until used. Supply an explicit API
address and credential with `Barry.at`, or discover the local installation with
`Barry.connect(await localConnection())`, importing `localConnection` from
`@barry-rocks/sdk/services`. See the [SDK README](../README.md) for current
subject handles and collections. The old `Platypus` class and its namespace
calls are not exported by the current SDK.

## Custom servers

Use `registerTools(server, tools, options)` with your own `McpServer`. It preserves
other tools registered on that server. The caller owns transport and shutdown.
`startBagServer` returns its server too; call `server.close()` to stop it.

Results are uncapped by default. `registerTools` accepts `resultCharLimit` and
`onToolCall`; observer failures cannot fail a tool. `startBagServer` honors
`BARRY_TOOL_RESULT_CHAR_LIMIT` when set. Caps apply to each text block, with an
additional truncation marker. Images and structured content remain intact.

## Installing a bag in Barry

Create a bag with `barry new my-bag --path ./my-bag`. Installing is
system-wide; packing puts the bag on one identity, by adding it to that
identity's `identity.yaml` and creating the identity-owned stores it declares:

```bash
barry install ./my-bag --as my-bag   # this machine
bux pack my-bag                      # the identity `bux`
```

Or both at once: `bux install ./my-bag` installs, then asks whether to pack it
onto `bux` (`--yes` packs without asking).

## Upgrading from 1.x

Wrap native MCP responses in `mcpResult(...)`; implicit detection by a `content`
field is gone. Plain data needs no change. Tools declaring `outputSchema` must
return a matching plain object instead of relying on a text-only fallback.

## Authoring contracts

Bag authoring and application integration share one SDK package with deliberate subject exports. Define tools through `@barry-rocks/sdk/tools`, register them through `@barry-rocks/sdk/tools`, and explicitly start a bag server through `@barry-rocks/sdk/mcp`. The package root exposes a small convenience surface; it does not activate the application.

Transport adapters and installed catalog operations have their own subject entry points. Use the documented contracts rather than importing an internal source file.

See [LICENSE.md](../../LICENSE.md) for licensing.
