# Bag loading and composition

See the [README's primitive vocabulary](../../README.md#barry-bags) for the domain model and [the guide](https://barry.rocks/guide/) for installing a bag. This package owns the manifest and registry contracts.

## Registry and builds

The authoritative registry is the machine-wide config store. Writes regenerate `~/Library/Application Support/Barry/bags.snapshot.json` for callers that must read synchronously. Never edit that snapshot. The older YAML registry is a fallback when the snapshot is unavailable and can be stale; fallback warnings and `barry bag doctor` make the discrepancy visible.

Snapshot publication refuses an empty registry and a redirected config store without a separately redirected snapshot path. Tests or scratch stores must redirect both `BARRY_CONFIG_DB` and `BARRY_BAGS_SNAPSHOT` to avoid publishing development data into the live registry.

Local tools load from bundled JavaScript in `~/Library/Caches/Barry/bags/`, keyed by name and source directory so worktrees do not share output. The MCP service rebuilds missing or stale bundles at startup. A bag's `prompts:` entry builds separately, to `prompt.js`, when a session first needs it or its sources change. Raw TypeScript is an escape hatch, not the production contract: code that works under development's TypeScript loader can fail under plain Node. `barry bag build <name>` and `barry bag doctor` expose these failures.

## Composition and grants

A manifest's `bags:` absorbs its children: tools, skills, instructions, actions, traits, and other capabilities. The automatic parent trait expands child namespaces transitively. Hand-authored YAML traits copy their namespace list literally; naming a composed parent there does not expand its children. Use the parent's automatic trait or list the actual namespaces.

An extension adds to one bag from `<parent>/extensions/<name>/`. Its manifest declares a short `name` and `extends: <parent>`, and its registered name is `<parent>/<name>`. Its tools stamp the parent's namespace and receive the parent's grant; it gets no automatic trait. Identity files pack it under its parent (`- sessions: { extensions: [search] }`). Packing requires the parent, and unpacking the parent removes its extensions. Data, log and build directories replace the registered name's `/` with `+`. Extensions may declare instructions, tool visibility, dependencies, schedules and scripts; other capabilities belong on the parent.

An explicit alias with the bag's own name replaces its automatic trait, losing capabilities that were only in the automatic one. Manifest trait definitions are qualified by their bag. A trait can carry named `bounds:` or an inline `bound:`; the inline form uses the real bound schema so misspellings cannot silently remove restrictions.

`<identity> pack` synchronizes traits. Editing a manifest alone does not update the live trait table; `barry bag sync-traits` does. A loaded or always-on bag still needs a tool grant. A deferred tool also needs registration and a grant before tool search can find it.

One bag owns each MCP server declaration. Composing that owner is how other bags reuse it. Child repository references are fetched as editable checkouts, not disposable cache entries; installation refuses to relocate a dirty checkout.

Barry's own bags register by directory: every folder under [bags/](../../bags) holding a `bag.yaml` is registered at setup, nested ones included. The bounds Barry ships are defined in the base identity, [identity.yaml](../../identity.yaml) at the repository root. Installing registers a bag on the machine; packing selects the bag's content for an identity. Adapter installation registers its declared bag through that same registry.

## Declarative bags

A bag can contain any combination of tools, services, instructions, constants, traits, bounds, or vendor catalogs. A bag with only declarations needs no executable entry point. The host resolves these declarations, supplies credentials and lifecycle behavior, and applies policy for the running harness.

```yaml
name: review-policy
description: Reusable review restrictions
constants:
  shell-denials: [git, rm]
bounds:
  safe-shell:
    description: Keep shell commands read-only
    bound:
      bash:
        denyPrograms: {constant: shell-denials}
traits:
  review:
    description: Review restrictions
    bounds: [safe-shell]
  restricted:
    description: Composed review policy
    includes: [review]
```

Definitions become `review-policy:safe-shell`, `review-policy:review`, and `review-policy:restricted`. Local references resolve within the bag. Cross-bag references use `bag:name`. A bag cannot publish a bare name: bare names are the ones an identity defines.

Constants replace whole values with `{constant: name}` or `{constant: bag:name}` before schema validation. A cross-bag provider must be composed with `bags:` or declared in `requires:`, and available as an installed local bag or a composed local path. Missing references, cycles, excessive expansion, and substituted values of the wrong type are refused. Strings such as `${API_KEY}` stay literal; constants execute no expressions.

Harness bags declare native grants in a trait’s `nativeTools`, keyed by harness id. Native tools are off by default, granted by the harness’s `native-*` traits, and taken back by bounds. Install and reload validate names against the inventory and category bounds. Each mode records its control limits in `Mode.native`; launch reports refused grants and uncontrolled tools, and refuses bounds that cannot take back an uncontrolled tool. See [native grants](bounds.md#native-grants) for the category and mode tables, including where off by default cannot be guaranteed.

The bash bag owns `bash:no-bash`. Selecting it denies Barry’s `Bash`, `BashOutput` and `KillShell`, and takes back native shell through the running harness’s category bound. Packing the bag alone imposes no restriction. To keep guarded Barry shell access while disabling native shell, omit `native-shell`.

Vendor catalogs use `vendors:` in a registered bag. The shipped catalog is [shipped-catalog.yaml](../src/adapters/models/vendors/shipped-catalog.yaml); catalog reading does not import vendor call code. Strict field checks and catalog relationship checks remain in place. Model availability comes from installation, independently of packing. Identity defaults and per-session choices still select the model and adapter.

## Boundaries

The manifest describes intent; the host supplies runtime behavior. Bag code must not import the engine or host-only loading and authentication machinery. Shared authoring contracts live in the SDK. Event hooks are spawned as processes so their dependencies and failures remain outside the event writer. The hook mode travels in arguments, not in a provider-specific event name.

Use [manifest.ts](../src/bags/manifest.ts), the [hook schema](../src/tools/hooks-schema.ts), and [the guide](https://barry.rocks/guide/) for the concrete authoring and verification surfaces.
