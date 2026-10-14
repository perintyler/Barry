# What Barry is for

Each scenario below is something a builtin or installable bag does today, with the commands
and configuration it takes. Scenarios that name a bag (supervisor, bdiff, coding, slack,
browser, caddy, questions, approvals, reminders, the `-official` wrappers and the product
bags) ship as separate bags you pack onto an identity; some are not public yet. The
[README](../README.md) carries the short version; this page has all of them, grouped by
what they lean on.

## Govern the agent

### A reviewer that cannot write

You want an agent to read a change and report, with no possibility of an edit,
a push or an outbound write. The shipped `readonly` bound denies Bash, Write
and Edit, removes every readwrite tool, and tags network writes.

Barry enforces it in three places: the tool list the model sees, a hook on every
native tool call, and optionally an egress proxy the agent cannot lift. The
[enforcement coverage](../sdk/docs/bounds.md#enforcement-coverage) table says
which harness supports which; read it before relying on a bound for anything
that matters.

```sh
barry start --bound readonly
```

```yaml
# or in identity.yaml, so every session of this identity starts bounded
bounds:
  - readonly
  - no-secrets
```

### A way of working, as a trait

The coding bag's `IC` trait grants bash, filesystem, the git bag's tools and
GitHub reads, and carries a bound that denies raw git and publishing `gh`
commands. A commit goes through a tool that decides which files are this
session's rather than through `git commit -am`. It is applied per session, not
per identity, because it is an opinion about how to work, not a property of
who you are.

```sh
barry start --traits IC
```

The slack bag's `slack-me` trait is the same idea in a different domain: read
Slack, and DM only yourself.

```yaml
bounds:
  slack-self-dm-only:
    bound:
      deniedTools: [send_slack_message, send_message_as_user]
traits:
  slack-me:
    bags: [slack]
    bounds: [slack-self-dm-only]
```

### A sandboxed, offline session

The `sandboxed-offline` bound sets `network.enforce: sandbox` with an empty
domain allowlist. On a supported harness, outbound traffic goes through a
hostname-filtering proxy the agent cannot lift. On an unsupported harness it
degrades to app-level guards with a diagnostic.

```sh
barry start --bound sandboxed-offline
```

### Work Barry, home Barry

Each identity has its own bags, its own default traits, its own command and its
own secrets. Both inherit the base identity, so shared bags and bounds are
defined once. A child can narrow a parent's bounds but cannot widen them.

Secrets live in a vault that runs as a different user behind a unix socket.
Same UID is same trust on macOS, so a vault running as you is readable by
anything running as you, including the agent. A separate user is the only thing
that closes that, and it is what the [vault bag](../bags/vault) does.

```sh
barry identity create acme
acme pack github linear datadog
barry identity create home
home pack calendar notes
```

## Reach a person

### Ask a person who is not at the terminal

The harness's question picker only exists in a terminal, and a Barry session is
often a cron job, an overnight run or a task started from a phone. The questions
bag's `ask` blocks until the answer arrives: a macOS notification with the
options as buttons, the Questions Mac app, a web page, or the iPhone app.
Expired and dismissed are different outcomes.

```ts
const outcome = await ask({
  context: "Both sides rewrote the retry loop in src/db.ts.",
  questions: [{
    question: "Which retry implementation should survive the merge?",
    options: [{ label: "Ours" }, { label: "Theirs" }],
  }],
});
```

### Approve the merge from your phone

`request_approval` blocks on a human verdict with a deadline. Everything fails
toward not-approved: an undelivered notification, an unreachable service and an
unanswered request all block. Denied and expired are kept distinct so a broken
delivery path cannot hide behind a refusal. A cron job with no session can ask
too.

### Supervise every session from one screen

The supervisor bag watches every active session, keeps a live book of what each
is doing, writes a digest with a local model, and is where you answer questions
and approvals. A Mac app with a menu bar, an iPhone app with push. Liveness is
judged from activity, never from the session row.

### Comment on a diff while the agent is still working

The bdiff bag stores review comments on a session's diff. A comment on a
running session nudges it between turns, so the agent addresses it mid-flight
instead of after the fact. A burst of comments becomes one nudge.

### Remind me

```sh
barry remind "stand up" "in 20 minutes"
```

A reminder is a one-off schedule. Delivery goes through `barry notify`, retries
on failure, and runs when the machine wakes if it was asleep at the due time.

## Keep working without you

### Work that runs while you sleep

A bag declares a schedule: cron in a timezone, every five minutes, once at a
time, or at login. The scheduler runs the action as a script or as a detached
hosted agent session under the identity you name. Runs are durable rows with
inputs, outputs, timeouts and an overlap policy. Results land as events, which
the menu bar shows in the morning.

```yaml
schedules:
  nightly-review:
    cron: "0 2 * * 1-5"
    timezone: America/New_York
    action: review:open-prs
    identity: acme
    overlap: skip
```

Barry runs itself this way. A bookkeeping job summarizes recent sessions with a
local Ollama model, and the telemetry bag samples the machine every few minutes.

### Agents that leave each other mail

A session can send a message to another session and is told what will happen
to it: the recipient wakes now, reads it at the end of its turn, reads it on its
next tool call, or gets it when it next resumes. A wake budget stops two agents
told to reply to each other from looping.

"Check back on this in 20 minutes" is one tool call. It books a one-off
schedule that resumes the session at the due time, even if it has stopped.

```
send_message(session: "yZ4Zz9…", text: "migration landed, rerun your tests")
schedule_prompt(in: "20m", text: "is the deploy green yet?")
```

### Ten sessions on one checkout

Parallel sessions editing one repository clobber each other. Barry's engine
wraps every edit tool: a write needs a stated intent, which claims the file, and
an edit fails unless this session read the file since it last changed. Every
file change is recorded, so any session can ask what the others did.

The locks bag measured the problem before solving it. Of 415 cross-session
collisions on this repo, none were simultaneous, so the arbiter rules on
intent, not position. Two sessions touching one file is normal, and a real
conflict is surfaced instead of guessed at.

### A second machine that takes the heavy jobs

Link another Mac as a worker. The owner keeps workflow history and decides
which worker takes each step; the worker claims steps over HTTPS, heartbeats,
and reports outcomes. The credential opens one route and nothing else, and an
invite can be scoped to named jobs. A crashed worker's step is retried. See
[distributed work](../sdk/docs/distributed-work.md).

```sh
barry workers invite second-mac --jobs sessions:summarize-session@1   # owner
barry workers join barry_wj2.…                                        # worker
barry service restart workflows.runtime
```

## Remember

### Memory that follows you between harnesses

Lessons an agent learns in Codex on Tuesday are injected into Claude Code on
Wednesday. Memories are scoped by the git remote, not the working directory, so
every worktree of a project shares them. Always-on memories join every prompt
under a budget; on-demand ones cost one index line until fetched. A web UI
keeps the collection curatable, and an importer brings in Claude Code's
file-based auto-memory.

```sh
barry memory save "use pnpm, never npm; nvm node 22 shadows node 26"
barry memory search "node version"
```

### Find out what happened

Every session's messages, tool calls and file changes are recorded, whichever
harness ran it. The search extension adds semantic search over transcripts with
local embeddings. The telemetry UI shows usage, cost, reliability and the
resource slopes that have actually broken this machine. Stores are SQLite files
you can back up, snapshot before an upgrade, and roll back.

```sh
barry session list
barry service url telemetry.web
barry db backup
barry upgrade          # snapshots, migrates a copy, switches, verifies
```

### Plans with a home

Claude Code writes plans into a folder nothing ever reads again. The plans bag
gives them a store, a web app, a native editor and tools, so a session can ask
what was planned for X. An idea is jotted in seconds and promoted to a plan
when it earns it.

## Build bags

### Package a domain as a bag

You keep re-explaining your Blender, Ableton or Linear workflow to agents. A
bag holds the tools, the instructions, an optional SQLite store with migrations,
a service if it needs one, actions and schedules. Install it from a directory,
an npm package, a git URL or a remote MCP server. Existing `SKILL.md` files are
picked up as actions without editing them.

```sh
barry new linear-bag
barry bag check ./linear-bag
barry install ./linear-bag
acme pack linear
```

```ts
// linear-bag/tools.ts
export default defineTool({
  name: "create_issue", namespace: "linear", access: "readwrite",
  schema: { title: z.string(), team: z.string() },
  handler: async (input, ctx) => ...
});
```

### A bag is a whole product

Lists, notes, plans and questions each declare a SQLite store, a service that is
the one write path, a web app, an iOS app, a macOS app and MCP tools in one
`bag.yaml`. `barry up` runs the service, `barry app` lists and opens the apps,
and backups carry the store.

```yaml
stores:
  lists: { owned_by: node, engine: sqlite, migrations: ./migrations/lists }
services:
  web: { entry: server/src/index.ts, serves: http, health: /health }
apps:
  ListsiOS:
    platform: ios
    build: { project: lists-ios/Lists.xcodeproj, scheme: Lists }
```

### One grant, three ways to reach the web

The browser bag composes playwright (a clean profile), chrome (your real
logged-in Chrome) and web-fetching (markdown without a browser). Each stands
alone. The manifest documents why chrome is a real exposure and how to drop it
from the grant.

```sh
acme pack browser                    # all three
barry start --traits web-fetching    # reads only
```

### The vendor's MCP server, as a bag

Notion, Figma, Linear, Datadog and PagerDuty each have an `-official` bag
wrapping the vendor's hosted MCP server, and a parent bag composing it with
Barry's own tools under one namespace. Consumers grant `linear` and get both. A
bag's namespace is independent of its name, so the vendor can change without
touching a single trait.

### Infrastructure in a bag too

Sites and workers are bags with a `deploy` tool, and Terraform lives under
`infra:` so a session can plan and apply it with the vault's credentials.

```sh
barry bag infra mailgun plan
barry tool barry.rocks deploy --preview redesign
```

### Readable names for every service

The caddy bag gives every local service a name like `https://lists.barry.lan`
with a local CA, rendered from the instance's hosting policy.

```sh
barry hosting status
```

## Make and test things

### Render it, and prove it rendered

The video-editing bag composes five animation engines, screen and terminal
capture, and media conversion, all headless. Every engine can exit 0 having
produced a blank file, so the render tools assert the artifact is non-blank
before returning. The terminal recorder produces the text a doc embeds and the
video beside it from one tape, so the two cannot disagree.

```sh
acme pack video-editing
barry tool terminal-recorder record-tape captures/intro.tape
```

### Test what the agent built the way a person would

The qa bag runs `QA.md` checklists as an agent per module and writes a
pass/fail report. macOS app testing drives a native app through the
accessibility tree and posts no synthetic input, so a stray keystroke can never
land in someone's half-written message. iOS simulator testing builds, boots and
pulls failure evidence out of an `.xcresult`. Site audit checks links, axe
violations and phone-width rendering. The docs bag lints prose against a
standard where an output block is a claim and the capture is the evidence.

```sh
barry tool site-audit check-links public/guide --site-root public
```

## Every tool is a shell command

A bag's tools are callable by people as well as models, through the bag's own
command group or `barry tool <bag> <tool>`.

```sh
barry git status ~/repos/barry
barry sentry search_errors --query "is:unresolved" --timeframe 24h
barry memory search "launchd"
barry coffee on
```
