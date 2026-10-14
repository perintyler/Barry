# Barry

A responsible way to use AI safely and effectively. I didn't think the right patterns existed, so I built my own.

<p align="center">
  <img src="https://raw.githubusercontent.com/perintyler/barry-assets/main/avatars/barry-glasses.png" alt="Barry the platypus" width="300">
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
- [Quick start](#quick-start)
- [Installation](#installation)
- [Barry Bags](#barry-bags)
- [Barry Traits](#barry-traits)
- [Barry Bounds](#barry-bounds)
- [Base Identity](#base-identity)
- [Further Reading](#further-reading)

## What is it?


Barry is a control layer for coding agents, built for modern software development.

- Secure agent behavior deterministically, with enforced limits rather than prompts.
- Formalize agentic work as actions with clearly defined inputs, outputs, and lifecycle.
- Configure capabilities once, then plug and play your favorite harness, even within a single session.
- Compose agent capabilities like software, instead of reconfiguring every vendor by hand.

<p align="center">
  <img src="https://raw.githubusercontent.com/perintyler/barry-assets/main/diagrams/control-layer.svg" alt="Barry sits between coding-agent harnesses (Claude Code, Codex, Cursor, OpenCode, Pi, Antigravity) and bags: tool calls come in and allow or deny goes back, governed by one effective policy, with actions, schedules and workers running work while you are away under the same policy" width="900">
</p>

## Problems it solves


Most coding-agent setups are a pile of per-vendor config. Barry treats an agent's power as something you compose, govern, and reuse like traditional software.

1. **Governance and security.** A system prompt that says "don't" is not a control, and most setups cannot stop an agent from writing, pushing, or reaching the network. Barry's bounds are enforced: a denied tool never reaches the model, denials beat grants, and it fails closed. You can give an agent read-only access it cannot escape, or a vault secret it can use but never see.
2. **Reuse and composition.** Every capability is re-explained to every agent, and nothing carries from one to the next. Barry packages tools, policy, stores, services and apps into bags that compose into other bags, so power compounds instead of being rebuilt.
3. **Distributed agentic workflows.** Agents only run while you watch, on the one machine in front of you, and ad-hoc "skills" have no inputs, outputs, or guarantees. Barry turns work into actions with typed inputs and outputs and a configurable model, so an action can run on a cheap local model instead of paid tokens. Schedule it to run on its own, on cron or at login, and a durable workflow engine backs every run: state survives restarts, a crashed step is retried, and when one machine is not enough you link others on your tailnet as workers and Barry fans the jobs out across them.
4. **Portability.** You are locked to one harness and one provider. Barry runs the same policy across Claude Code, Codex, Cursor, OpenCode and more, and gives each identity its own API keys and model provider without logging in and out.

<p align="center">
  <img src="https://raw.githubusercontent.com/perintyler/barry-assets/main/diagrams/with-vs-without.svg" alt="Without Barry versus with Barry across four axes: wiring each harness to each tool by hand versus wiring once, a system-prompt request versus an enforced bound where denied tools never reach the model, running only while you watch versus on a schedule and across machines, and state scattered per vendor versus one searchable record" width="900">
</p>

## Primitives


Barry's architecture was designed from first principles, meaning it comes with its own set of primitives. To put it most simply...

<ins>*You put things in bags. Traits enable, bounds restrict.*</ins>

- **Bag**: a collection of tools, services, instructions, actions, schedules, apps, and other bags
- **Bound**: a restriction, denied tools, write access, file globs, shell programs, network actions or domains. Denials union, allowlists intersect.
- **Trait**: a named set of tool grants and bounds
- **Identity**: a Barry persona with its own bags, default traits, shipped bounds, a default adapter, its own secrets. Inherits from a parent.
- **Adapter**: a harness binding, launches Claude Code, Codex, Cursor, OpenCode, Pi or Antigravity with Barry's tools and hooks in hosted, instrumented or guest mode.
- **Instruction**: natural language agent guidance, always or on demand.
- **Action**: an LLM-powered job with inputs, outputs, and lifecycle. My take on skills.

<p align="center">
  <img src="https://raw.githubusercontent.com/perintyler/barry-assets/main/diagrams/effective-policy.svg" alt="From identity file to effective policy: identity.yaml and bag traits/bounds plus the session request resolve into one effective policy, consumed by the MCP tool filter, the call-time bound guards, the native ceiling and hook gate, and the optional egress sandbox" width="900">
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
BARRY_WORKFLOW_LABELS=model=local barry up
```

A trait and a bound became a policy, an action became a repeatable unit of work, a schedule made it autonomous, a local model made it cheap, and a worker made it distributed. Those pieces compose everything else Barry does.

## Quick start


Create your very own Barry.

```
barry identity create bonanza
```

That wrote an identity that inherits the base one, registered it, and installed a `bonanza` command on your PATH that is `barry` with the identity pre-selected.

Pack a bag.

```
bonanza pack embeddings
```

Packing edits the identity file, creates the stores the bag declares, bundles its tools, and generates a trait named `embeddings` that grants them.

Start a session with `bonanza` and select traits.

```
  Identity: bonanza
  Bags: instructions, actions, events, sessions, embeddings
  Session: yZ4Zz9HYXxIrnhnrOpDRV

? Select capabilities (↑/↓ navigate, ⇧↑/⇧↓ jump, space select, type to filter, enter submit)
  ◯ embeddings
  ◯ embeddings-read [readonly]
  ◯ ...
```

Barry resolves the selected traits and bounds into one policy, writes the harness's settings and hooks, launches it, and records everything the session does. Pass `--codex`, `--cursor` or any installed adapter to pick the harness; `barry use <identity>` switches identities for the general `barry` command.

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

### After installing

A Barry instance is a few supervised services, a shelf of SQLite files, and the `barry` command plus one generated command per identity.

```sh
barry status              # services, stores and schedules
barry doctor              # installation health and configuration drift
barry service logs mcp.server
barry db backup           # every store, one snapshot
barry upgrade             # snapshot, migrate a copy, switch, verify
```

## Barry Bags


You can put all sorts of things in bags: tools, servers, databases, containers, deployments, actions, apps, secrets, scheduled jobs. Or other bags. Once a bag is packed, everything in it is just there: its store and services launch on boot, its macOS app is built and reachable, its MCP server is always ready, and its tools are discoverable the moment a session enables the bag.

Bags should just work.

Install one from a directory, an npm package, a git URL or a remote MCP server, and validate it before you do.

```sh
barry new linear-bag
barry bag check ./linear-bag
barry install ./linear-bag
bonanza pack linear
```

Bags compose. A `browser` bag with no code of its own grants a clean headless profile, your real logged-in Chrome and cheap markdown fetching under one name, and each child still stands alone. A `linear` bag composes Linear's own hosted MCP server with Barry's ticket tools under one namespace.

Barry bags are designed for seamless and total control of tools. I'm a tool truther. Tools are what make LLMs powerful; tools let LLMs *do* things. But with great power comes great responsibility. An unbounded, powerful, non-deterministic black box is a danger to polite society. Tools are how we mammals integrate deterministic workflows into agentic systems.

> Opinion: The future will not be built on a bash tool. Statistics at scale are surprisingly powerful. But humans have a world view that guides our sensibilities. The future will be built on mature systems.

## Barry Traits


Traits are cheap. They are preset combinations of bags and bounds.

Whenever a bag is packed, a trait named after it is generated, enabling everything in the bag. Read-only access is expressed by composing that trait with a `readonly` bound. Hand-written traits carry opinions: `IC` for how an engineer works, `slack-me` for read Slack and DM only yourself.

The bag, trait and bound patterns aim to make it possible to build up AI systems where power compounds, just like with traditional code.

## Barry Bounds


Bounds restrict capabilities that traits have granted.

Guarantee specific tools or types of tools aren't used. Network too: no pushes, no writes, nothing at all, or only the domains you allow. Barry ships `readonly`, `no-secrets`, `no-network`, `no-network-write` and `sandboxed-offline`; an identity can select one, and a child identity can narrow a parent's bounds but never widen them.

This is enforcement, not a prompt that asks the model nicely. A bound is applied in two places: tools it denies are never discoverable, so the model never sees them, and anything that slips through is refused again at call time. It fails closed. A shell command the classifier can't read, a file path it can't resolve, a session whose bounds failed to load: all denied, not allowed. Denials always beat grants, so composing a broad trait with a tight bound is safe by construction. The egress sandbox goes further on supported harnesses, proxying outbound traffic by hostname so the agent can't reach a domain you didn't allow, and saying so plainly when a harness can only enforce the weaker version.

## Base Identity


Almost every identity needs the same foundational bags: a way to run tools, read and write files, keep sessions, remember things, run work on a schedule. Rather than make you pack those every time, Barry ships a base identity, `identity.yaml` at the repository root, named `base`, that already packs them.

Every identity you create inherits from `base` automatically, so those fundamentals are there without being redeclared. A child only names what differs, and can narrow the parent's bounds but never widen them. To inherit a different parent, name it:

```yaml
inherits: base
```

The base identity packs:

- [Actions](bags/actions): named, parameterized agent work with a durable run record
- [Artifacts](bags/artifacts): generated files with fixed bytes and provenance
- [Bash](bags/bash): shell execution, streaming and kill
- [Decisions](bags/decisions): typed questions answered by cheap decision models, with a log of every answer
- [Embeddings](bags/embeddings): a local vector store, searched by meaning
- [Events](bags/events): an append-only record of what happened, delivered to the menu bar, Slack or SMS
- [Filesystem](bags/filesystem): the file tools every session gets, plus change tracking and edit coordination
- [Identities](bags/identities): who Barry is when it acts and what each one may reach
- [Instructions](bags/instructions): standing guidance, always-on or fetched on demand
- [MCP](bags/mcp): the one server that serves every bag's tools to every session
- [Memory](bags/memory): long-term lessons, scoped by repo, injected at session start
- [Nodes](bags/nodes): this instance and its peers
- [Schedules](bags/schedules): actions on cron, once, or at login
- [Sessions](bags/sessions): the store, the engines and the search over every conversation
- [Telemetry](bags/telemetry): the resource slopes that have actually broken this machine

Two more bags ship with Barry as always-on services rather than packed capabilities: [vault](bags/vault), the encrypted secret store that backs credential resolution for every identity, and [workflows](bags/workflows), the durable runtime that executes background and distributed work. They run for the whole installation; a session reaches them without packing them.

## Further Reading


- [The guide](https://barry.rocks/guide/): installing Barry, the primitives, identities, bags, traits, bounds and actions
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
