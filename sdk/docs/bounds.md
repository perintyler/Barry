# `@barry-rocks/sdk/bounds`

The bound vocabulary: the schema a bag or identity author writes, the merge that combines
authored bounds, and the enforcement that gives both their meaning.

## Current consumers

The SDK carries the authored bound schema and the runtime helpers used by
Barry's MCP host and bounded tool invocation. It does not depend on an engine
package. The production modules importing `mergeBounds` and `filterTools` live in
[`sdk/src/bounds/filter-tools.ts`](../src/bounds/filter-tools.ts),
[`sdk/src/bounds/merge-bounds.ts`](../src/bounds/merge-bounds.ts), and
[`sdk/src/bounds/bound-guards.ts`](../src/bounds/bound-guards.ts).

Guards are best effort against ordinary mistakes. Adversarial protection needs
an enforceable sandbox.

## Choosing a restriction

Every bound dimension uses `{ allow, deny }` (plus optional `enforce: sandbox` on `network`):

| Dimension | Restricts |
|---|---|
| `tools.{allow, deny}` | Tool selectors (`<namespace>:<tool>`, `<namespace>:write`, `<namespace>:*`, `*:write`, `*:<ToolName>`) |
| `inputs.<ns>:<tool>.<param>.{allow, deny}` | Parameter value globs for specific tool parameters |
| `files.{allow, deny}` | Paths matching glob patterns |
| `bash.{allow, deny}` | Resolved programs and subcommands (`git`, `gh:pr:create`) |
| `network.{allow, deny, enforce}` | URL/hostname globs (`https://api.github.com/**`, `*.internal.corp`) and recognized network actions (`write`, `git:push`, `all`) |
| `nodes.{allow, deny}` | Allowed or denied execution nodes (`local` or invited worker names/IDs) |

Across bounds merged with `mergeBounds(a, b)`, `deny` lists union and `allow` lists preserve every bound's allowlist clauses so a call must match at least one pattern in every contributing bound's allowlist and zero patterns in the combined denylist. A deny rule always wins when the same tool, input, path, command, URL, or node is also allowed. File patterns expand a leading tilde and match normalized absolute paths. Non-empty `files` bounds also withhold native file tools and Bash so those routes cannot bypass the MCP path checks.

Program rules resolve wrappers and subcommands: `git` matches the program, while `gh:pr:create` names a narrower operation. An unreadable command is denied when a bash bound is active.

## Built-in config file write protection

Barry's MCP file write tools and bash guard unconditionally refuse writes to Barry's own configuration and state files (`~/.barry/**`, `identity.yaml`, `bag.yaml`, `.claude/**`, `.codex/**`, `.cursor/**`, `.gemini/**`, `.opencode/**`) even when a session starts with `bounds: []`. This built-in config protection is not part of the `Bound` value and does not withhold native `Bash`/`Read`/`Write` on unrestricted sessions.

## Enforcement coverage

Guards inspect structured tools and recognizable shell commands. They cannot reliably classify arbitrary programs or URLs constructed at runtime. Bag tools making requests in their own process are controlled by which bags are active and by `tools` / `inputs` bounds, not the agent process’s network bound.

`network.enforce: sandbox` adds a hostname-filtering egress proxy on supported runtimes. Without `network.allow`, that sandbox permits no non-local egress. A hostname proxy cannot distinguish an HTTP read from a write to the same host, so partial action denials still need guards. Unsupported harnesses degrade to guards with a diagnostic; consult the capabilities each adapter declares (for example [Claude Code's](../../adapters/sessions/claude/src/capabilities.ts)) and model endpoint overrides before claiming sandbox enforcement.

Harness native tools are enabled by default when no bound restricts their dimension, and withheld when a bound restricts their dimension or explicitly denies them via `*:write` or `*:<ToolName>` in `bound.tools.deny`. The [adapter contracts](../../adapters/README.md) explain each harness's native tool boundaries.

File restrictions withhold native shell, file reads, and file writes because native calls bypass Barry’s path guards. Barry shell guards still cannot inspect paths read by arbitrary programs; these bounds are not a process-wide filesystem sandbox.

## Native tool withholding

Bounds withhold harness native tools automatically based on active dimensions and `tools.deny` selectors:

| Bound rule | Native categories withheld |
| --- | --- |
| Nonempty `bash.allow` or `bash.deny` | Shell |
| Nonempty `network.allow` or `network.deny`, or `network.enforce: sandbox` | Shell, network |
| Nonempty `files.allow` or `files.deny` | Shell, file reads, file writes |
| `tools.deny` contains `*:write` | Shell, file writes |
| `tools.deny` contains `*:Bash` or `bash:*` | Shell |
| `tools.deny` contains `*:Read`, `*:Glob`, `*:Grep` | File reads |
| `tools.deny` contains `*:Write`, `*:Edit` | File writes |
| `tools.deny` contains `*:WebFetch`, `*:WebSearch` | Network |
| `tools.deny` contains `*:<ToolName>` | That native tool |

| Harness | Shell | File reads | File writes | Network |
| --- | --- | --- | --- | --- |
| claude-code | Bash | Read, Glob, Grep | Write, Edit, NotebookEdit | WebFetch, WebSearch |
| codex | exec_command, write_stdin | view_image | apply_patch | web_search |
| opencode | shell | read, grep, glob | edit, write, patch | webfetch, websearch |
| pi | bash, powershell | read, grep, find, ls | edit, write | None |
| cursor | Shell, WriteShellStdin | Read, Grep, List, Glob | Write, Edit, Delete | WebFetch, WebSearch, Fetch |
| antigravity | run_command, send_command_input, command_status | view_file, grep_search, find_by_name, list_dir | write_to_file, replace_file_content, multi_replace_file_content, sed_file | read_url_content, search_web |

Identity files select bags and bounds as lists of names or one-name mappings. `optional: true` offers a bag or bound for per-session selection without activating it by default; a bare name activates it by default. Children inherit their parent's bags and bounds and can narrow them, but cannot weaken an inherited default bound.

### Shell classification limits

Shell guards are best-effort protection against ordinary mistakes (decision 28). Program rules inspect shell command structure, substitutions and common wrappers. Stdin-fed shells, eval/source and unresolved executable expansions refuse under a program rule. Unknown Git or gh command heads refuse when a corresponding subcommand restriction applies; aliases already configured outside the command cannot be resolved. Prefer network action restrictions for pushes. Python/Node/Perl/awk code, find -exec, remote ssh execution and arbitrary scripts remain outside shell classification; adversarial enforcement requires a sandbox.

Domain guards inspect quote-removed arguments, including scheme-less curl, wget and HTTPie targets. Unknown target expansions and curl/wget configuration files refuse under a domain rule. IP literals and Host header overrides are outside hostname matching; use `enforce: sandbox` to fence a host.

### File guard coverage

File guards canonicalize existing symlinks and the existing parent of a new file.
On macOS they compare paths without case, matching the default filesystem. A
recursive directory rule includes the directory itself. Structured filesystem
tools expose path parameters through their schemas; the guard checks those fields,
with parameter names retained for native tools. Grep/Glob/LS check their
explicit or default search root. A root above a fixed denied subtree is refused;
unanchored denied patterns conservatively refuse recursive search because the
subtree could occur anywhere below that root.

`files.allow` requires absolute or home-relative roots at schema validation.
This avoids treating the shared tool-host cwd as an implicit session root. Each
bound's allowlist clause is checked against the normalized candidate; deny rules retain priority.
For a new allowed file, its immediate parent must exist so it can be resolved.

A nonempty `files.deny` or `files.allow` clause withdraws Barry's Bash from
advertised tools, and the invocation guard refuses stale or direct Bash calls.
Use the structured filesystem tools under these bounds. This follows Step 12's
explicit shell-withdrawal alternative: scripts and persisted shell cwd cannot be
reliably covered by an argv predicate. These remain application safety rails,
not a cryptographic filesystem sandbox; other custom tools, native vendor
capabilities and filesystem races require their own enforcement. HTTP URLs passed
to open are not treated as filesystem paths; file rules do not enforce egress.

### Hosted approval predicate cleanup

The unused `decidePermission`, `PermissionQuestion` and `PermissionVerdict` exports
were removed. They had no runtime callers and did not implement the network
checks used by bound guards. Hosted sessions use their native-tool rules and
durable approval path; MCP invocation uses `applyBoundGuards`. Neither path
consumes a second exported permission predicate.

### Recognized network actions

Under owner decision 28, `network.deny: [all]` remains a denylist of recognized
network operations. It does not reject every unknown executable. `write` denies
recognized mutations while allowing recognized reads. Interpreter code, arbitrary
scripts, package lifecycle scripts, and aliases configured outside the command
remain documented gaps; use supported sandbox enforcement for an adversarial
boundary. A requested sandbox must refuse to start when unavailable.

| Client | Recognized operations |
| --- | --- |
| Git | Push, SVN dcommit, and send-email mutate; fetch, pull, clone, remote update, and submodule operations read |
| GitHub CLI | PR, issue, release, repository, gist, secret, variable, and workflow mutations; API methods and field flags; views and lists read |
| npm, pnpm, yarn | Publishing, unpublishing, deprecation, and dist-tag changes mutate; installation and registry queries read |
| pip, uv, Homebrew | Installation, fetching, and updates read the network |
| Docker | Push and login mutate; pull, search, and build read |
| kubectl, Terraform | Known queries read; cluster changes and Terraform apply/destroy mutate |
| AWS, gcloud, Azure CLI | Recognized queries read; unknown operations conservatively count as writes. AWS S3 copies classify by destination; moves mutate the source too |
| SSH | An interactive connection reads; a remote command or forwarding counts as a write |
| SCP, rsync | Remote destinations write; downloads read unless they remove remote sources or specify a remote rsync command |
| HTTP clients | curl, wget, and HTTPie inspect each command's own method/body flags |
| Generic transports | netcat, socat, telnet, and OpenSSL s_client can read and write |

SCP and rsync use literal remote operands (`host:path`, or `rsync://`); unusual
option spellings and indirect configuration remain best-effort limitations. These
classifications describe potential access, rather than proving what a remote
command or package installation will do.
