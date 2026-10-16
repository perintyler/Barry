# Bag loading and composition

See the [README's primitive vocabulary](../../README.md#primitives) for the domain model and [the guide](https://barry.rocks/guide/) for installing a bag. This package owns the manifest and registry contracts.

## Registry and builds

The authoritative registry is the machine-wide config store. Writes regenerate `~/Library/Application Support/Barry/bags.snapshot.json` for callers that must read synchronously. Never edit that snapshot. The older YAML registry is a fallback when the snapshot is unavailable and can be stale; fallback warnings and `barry bag doctor` make the discrepancy visible.

Snapshot publication refuses an empty registry and a redirected config store without a separately redirected snapshot path. Tests or scratch stores must redirect both `BARRY_CONFIG_DB` and `BARRY_BAGS_SNAPSHOT` to avoid publishing development data into the live registry.

Local tools load from bundled JavaScript in `~/Library/Caches/Barry/bags/`, keyed by name and source directory so worktrees do not share output. The MCP service rebuilds missing or stale bundles at startup. A bag's `prompts:` entry builds separately, to `prompt.js`, when a session first needs it or its sources change. Raw TypeScript is an escape hatch, not the production contract: code that works under development's TypeScript loader can fail under plain Node. `barry bag build <name>` and `barry bag doctor` expose these failures.

## Composition and bounds

A manifest's `bags:` composes its child bags: tools, skills, instructions, actions, bounds, and other capabilities. Selecting a composite bag activates its child bags transitively.

A bag can also declare `namespace: <ns>` to publish its tools under a shared namespace (for example `session-vector-search` declares `namespace: sessions` and `requires: [sessions]`). Every bag is a standalone bag with its own `bag.yaml`.

Packing a bag into an identity adds it to `identity.yaml` `bags:`. A bare bag name is active by default on every session; `- <bag>: { optional: true }` makes the bag available for per-session selection (`--bag <bag>`) without activating it by default. Bounds work the same way under `bounds:`: bare names apply to every session, and `optional: true` bounds can be selected per session with `--bound <bound>` or defined inline in `identity.yaml` or `bag.yaml`.

One bag owns each MCP server declaration. Composing that owner is how other bags reuse it. Child repository references are fetched as editable checkouts, not disposable cache entries; installation refuses to relocate a dirty checkout.

Barry's own bags register by directory: every folder under [bags/](../../bags) holding a `bag.yaml` is registered at setup. The global bounds Barry ships (`readonly`, `safe`, `no-network`, `sandboxed`, `local-only`) are defined in the base identity, [identity.yaml](../../identity.yaml) at the repository root. Installing registers a bag on the machine; packing selects the bag's content for an identity. Adapter installation registers its declared bag through that same registry.

## Declarative bags

A bag can contain any combination of tools, services, instructions, constants, bounds, or model vendors. A bag with only declarations needs no executable entry point. The host resolves these declarations, supplies credentials and lifecycle behavior, and applies bounds for the running harness.

```yaml
name: review-bounds
description: Reusable review restrictions
constants:
  shell-denials: [git, rm]
bounds:
  safe-shell:
    description: Keep shell commands read-only
    bash:
      deny: {constant: shell-denials}
  readonly:
    description: Read-only tools and no shell mutations
    tools:
      deny: ["*:write", "*:Bash"]
```

Definitions in a bag can be referenced by bare name (`safe-shell`) when unambiguous or qualified as `review-bounds:safe-shell`.

Constants replace whole values with `{constant: name}` or `{constant: bag:name}` before schema validation. A cross-bag source must be composed with `bags:` or declared in `requires:`, and available as an installed local bag or a composed local path. Missing references, cycles, excessive expansion, and substituted values of the wrong type are refused. Strings such as `${API_KEY}` stay literal; constants execute no expressions.

Harness native tools are enabled by default and withheld when a bound restricts their dimension (`files`, `bash`, `network`) or denies `*:write` / `*:<ToolName>` in `tools.deny`. See [native tool withholding](bounds.md#native-tool-withholding) for the category and harness tables.

The bash bag owns the `no-bash` bound (`bash:no-bash`). Selecting it denies `bash:*` and `*:Bash`, withholding both Barry's `Bash`/`BashOutput`/`KillShell` tools and the harness's native shell tool. Packing the bash bag alone imposes no restriction.

Model vendor declarations use `vendors:` in a registered bag. The shipped vendor definitions live in [shipped-models.yaml](../src/adapters/models/vendors/shipped-models.yaml); reading vendor definitions does not import vendor call code. Strict field checks and relationship checks remain in place. Model availability comes from installation, independently of packing. Identity defaults and per-session choices still select the model and adapter.

## Boundaries

The manifest describes intent; the host supplies runtime behavior. Bag code must not import the engine or host-only loading and authentication machinery. Shared authoring contracts live in the SDK. Event hooks are spawned as processes so their dependencies and failures remain outside the event writer. The hook mode travels in arguments, not in a vendor-specific event name.

Use [manifest.ts](../src/bags/manifest.ts), the [hook schema](../src/tools/hooks-schema.ts), and [the guide](https://barry.rocks/guide/) for the concrete authoring and verification surfaces.
