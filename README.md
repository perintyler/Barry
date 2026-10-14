# Barry

A responsible way to use AI safely and effectively. I didn't think the right patterns existed, so I built my own.

<p align="center">
  <img src="https://raw.githubusercontent.com/perintyler/barry-assets/main/avatars/barry-glasses.png" alt="Barry the platypus" width="300">
</p>

<p align="center">
  <a href="https://barry.rocks/guides/quickstart">Quickstart</a> · <a href="https://barry.rocks/guides/reference">Reference</a>
</p>

<p align="center">
  <a href="docs/protocols.md"><img src="https://img.shields.io/badge/MCP-supported-0e7c86" alt="MCP supported"></a>
  <a href="docs/protocols.md"><img src="https://img.shields.io/badge/ACP-supported-0e7c86" alt="ACP supported"></a>
  <a href="docs/protocols.md"><img src="https://img.shields.io/badge/AG--UI-supported-0e7c86" alt="AG-UI supported"></a>
</p>

> [!WARNING]
> Barry is a platypus. But just like the first of men, Barry knows his tools.

- [What is it?](#what-is-it)
- [Problems it solves](#problems-it-solves)
- [Primitives](#primitives)
- [Example Use Case](#example-use-case)
- [Installation](#installation)
- [Base Identity](#base-identity)
- [Further Reading](#further-reading)

## What is it?

Barry consists of:

- An SDK, for building composable and extendable agentic capabilities
- A control layer, for enforcing tool & network access per identity and session

<p align="center">
  <img src="https://raw.githubusercontent.com/perintyler/barry-assets/main/diagrams/control-layer.svg" alt="Barry sits between coding-agent harnesses (Claude Code, Codex, Cursor, OpenCode, Pi, Antigravity) and bags: tool calls come in and allow or deny goes back, governed by one effective policy, with actions, schedules and workers running work while you are away under the same policy" width="760">
  <br>
  <sub><em>All tool calls flow through Barry</em></sub>
</p>

## Problems it solves


Barry treats agent capabilities as something you compose, govern, and reuse like traditional software.

1. **Security & Control.** Agents are isolated and all tool calls go through a control layer. Bounds are deterministically enforced. Agent capabilities can be easily configured per session or identity, or through the SDK. Bounds support all sorts of useful things like only allowing certain parameters for a given tool call. Secrets are put in vaults, allowing tools to use necessary secrets (when granted) without the LLM ever "seeing" them.
2. **Reuse & Composition.** Barry packages tools, policy, stores, services and apps into bags that compose into other bags, so power compounds. Everything you pack launches on its own. Services start at login and restart if they crash, so tools are ready the moment a session opens.
3. **Reliable & Durable Distributed Agentic Work.** Background work is done through actions, which have typed inputs, outputs and a lifecycle, and can be configured to use a certain harness or model. Actions are built on a durable workflow engine with persisted state and retries, and can fan out work to multiple computers on a private network.
4. **Portability.** Use whichever coding agent you like: Claude Code, Codex, Cursor, OpenCode, Pi and Antigravity all follow the same rules. Easily switch between AI API keys within or across providers/accounts by starting sessions with different identities - just add the keys to your identities' vaults.

## Primitives


Barry's architecture was designed from first principles, meaning it comes with its own set of primitives. To put it most simply: *you put things in Bags, Traits enable, Bounds restrict.*

- **Bag**: a collection of tools, services, instructions, actions, schedules, apps, and other bags
- **Bound**: a restriction, denied tools, write access, file globs, shell programs, network actions or domains. Denials union, allowlists intersect.
- **Trait**: a named set of tool grants and bounds
- **Identity**: a Barry persona with its own bags, default traits, shipped bounds, a default adapter, its own secrets. Inherits from a parent.
- **Adapter**: Embedding models, decision, and agent harnesses, which support 3 modes: guest, instrumented, hosted.
- **Instruction**: natural language agent guidance, always or on demand.
- **Action**: an LLM-powered job with inputs, outputs, and lifecycle. My take on skills.

<p align="center">
  <img src="https://raw.githubusercontent.com/perintyler/barry-assets/main/diagrams/tool-resolution.svg" alt="Tool resolution: packed bags produce traits; the session's selected traits union into a grant; bounds such as readonly and no-egress subtract from it; what remains is the allowed namespaces, denied tools and access, file, shell and network rules, and native tool grants" width="760">
  <br>
  <sub><em>Tool Resolution</em></sub>
</p>

## Example Use Case


Say an alert fires at 2am and you want an agent to look into it, but you do not want it touching anything: no edits, no pushes, no writes. You give it a `debug` trait that opens the Datadog and Slack bags for reading, composed with a bound that denies writes. Start a session with it and the write tools are never even discoverable, enforced when the tool list is built and again on every call, failing closed if anything is unclear.

```sh
my-work-identity start --trait employer:debug
```

Here `employer` is a bag you would write for your work identity; it defines the `debug` trait, referenced as `employer:debug`.

```yaml
traits:
  debug:
    includes: [datadog, slack]
    bound:
      deniedAccess: [write]
      network:
        actions: [write]
```

The Datadog and Slack tools need API keys. You store them in the identity's vault and declare them in its `identity.yaml`; the tools receive the values, and the model never sees them.

```sh
my-work-identity vault add DATADOG_API_KEY <value>
my-work-identity vault add SLACK_BOT_TOKEN <value>
```

```yaml
# identity.yaml
secrets:
  DATADOG_API_KEY:
    in: vault
  SLACK_BOT_TOKEN:
    in: vault
```

That worked, so you want it to happen every time, the same way. You turn the triage into an action: a named unit of work with typed inputs, a typed output, and a model it runs on, instead of a prompt you paste and tweak.

```yaml
version: 1
name: triage-alert
description: Pull the firing alert, correlate recent deploys and logs, report the likely cause.
input_schema:
  properties:
    alert_id:
      type: string
  required: [alert_id]
output_schema:
  type: string
model: claude-sonnet-4-5
```

Now you would rather not be woken up at all, so you schedule it. It runs on its own under `my-work-identity`, with the same read-only `debug` trait, and leaves its findings as an event you read over coffee.

```yaml
schedules:
  nightly-triage:
    every: 1d
    action: triage-alert
    identity: my-work-identity
    traits: [debug]
```

But running a frontier model every night burns tokens, so you point the action at a local open-source model instead. It is free, and the triage never leaves your machine.

```yaml
model: ollama/qwen3:4b
```

Now your Mac is pinned running inference while you work, so you hand the job to another computer: link the old laptop in the closet as a worker, and the durable workflow engine sends it the run, retries if it dies, and keeps your main machine free.

```sh
barry workers join <invite-token>
```

A trait and a bound became a policy, an action became a repeatable unit of work, a schedule made it autonomous, a local model made it cheap, and a worker made it distributed. Those pieces compose everything else Barry does.

## Installation


The linked checkout is the primary install channel. Homebrew releases remain experimental. Install with the supported Node and pnpm versions:

```sh
git clone https://github.com/perintyler/barry.git && cd barry
pnpm install --frozen-lockfile
pnpm build:packages
node cli/bin/barry.js setup --link .
```

See the [install guide](docs/install.md) for release/system channels, verification, footprint and removal.

### Prerequisites

- Homebrew
- Homebrew node, major 26, at least 26.9 (matches .node-version)
- pnpm major 12
- [An adapter](adapters/): Claude Code, Codex, Cursor, OpenCode, Pi or Antigravity

For installation problems, follow the [support playbook](docs/support.md#when-something-is-wrong); contact platypus@barry.rocks if its checks do not resolve the issue.

## Base Identity


Almost every identity needs the same foundational bags: a way to run tools, read and write files, keep sessions, remember things, run work on a schedule. Rather than make you pack those every time, Barry ships a base identity, `identity.yaml` at the repository root, named `base`, that already packs them.

Every identity you create inherits from `base` automatically, so those fundamentals are there without being redeclared. A child only names what differs, and can narrow the parent's bounds but never widen them. To inherit a different parent, name it:

```yaml
inherits: base
```

The base identity packs [Actions](bags/actions), [Artifacts](bags/artifacts), [Bash](bags/bash), [Decisions](bags/decisions), [Embeddings](bags/embeddings), [Events](bags/events), [Filesystem](bags/filesystem), [Identities](bags/identities), [Instructions](bags/instructions), [MCP](bags/mcp), [Memory](bags/memory), [Nodes](bags/nodes), [Schedules](bags/schedules), [Sessions](bags/sessions), and [Telemetry](bags/telemetry).

## Further Reading


- [Use cases](docs/use-cases.md)
- [Bags](sdk/docs/bags.md) and [the bag host](sdk/docs/host.md)
- [Bounds](sdk/docs/bounds.md)
- [Distributed work](sdk/docs/distributed-work.md): workers on other machines
- [Adapters](adapters/README.md)
- [Actions](bags/actions/README.md)
- [Events](bags/events/README.md)
- [Schedules](bags/schedules/README.md)
- [Sessions](bags/sessions/README.md)
- [Telemetry](bags/telemetry/README.md)
- [Artwork](https://github.com/perintyler/barry-assets)
