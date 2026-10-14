# `@barry-rocks/sdk/bounds`

The bound vocabulary: the schema a bag author writes, the merge that combines
authored bounds, and the enforcement that gives both their meaning.

## Current consumers

The SDK carries the authored bound schema and the runtime helpers used by
Barry's MCP host and scoped tool invocation. It does not depend on an engine
package. The production modules importing `resolveTraits` are
[`sdk/src/bounds/filter-tools.ts`](../src/bounds/filter-tools.ts) and
[`sdk/src/traits/index.ts`](../src/traits/index.ts); the bounds barrel also
re-exports it. Identity session-bound resolution now has a separate local
function, rather than importing this SDK function. The importer regression
checks this current set instead of repeating the original review's stale count.

`bash:no-bash` is a trait whose only content is the `bash:no-bash` bound.
Guards are best effort against ordinary mistakes. Adversarial protection needs
an enforceable sandbox; see the threat-model decision in the review plan.

## Choosing a restriction

| Field | Restricts |
|---|---|
| `deniedTools` | Named tools or namespaces |
| `deniedAccess` | Write access globally or for a namespace/tool |
| `files.deny` | Paths matching glob patterns |
| `files.allowOnly` | Every path outside the listed patterns |
| `bash.deny`, `bash.denyPrograms` | Command text or resolved programs and subcommands |
| `network.actions` | Recognized network operations, such as writes or git pushes |
| `network.domains` | Recognized destination hostnames to deny |
| `network.allowDomains` | Hosts permitted by the egress sandbox |

Denials union. Allowlists intersect; an absent allowlist expresses no opinion, while an explicit empty list permits nothing. A deny rule still wins when the same path or host is allowed. File patterns expand a leading tilde and match normalized absolute paths. `files.allowOnly` also requires denying native file tools and Bash so those routes cannot bypass the MCP path checks; provider support for that denial is part of the effective guarantee.

Program denials resolve wrappers and subcommands: `git` denies the program, while `gh:pr:create` names a narrower operation. An unreadable command is denied. A readable program the network classifier does not recognize is a different case: it may run without a network action tag.

## Enforcement coverage

Guards inspect structured tools and recognizable shell commands. They cannot reliably classify arbitrary programs or URLs constructed at runtime. Bag tools making requests in their own process are controlled by their trait and tool grants, not the agent process’s network bound.

`network.enforce: sandbox` adds a hostname-filtering egress proxy on supported runtimes. Without `allowDomains`, that sandbox permits no non-local egress. A hostname proxy cannot distinguish an HTTP read from a write to the same host, so partial action denials still need guards. Unsupported harnesses degrade to guards with a diagnostic; consult the capabilities each adapter declares (for example [Claude Code's](../../adapters/sessions/claude/src/capabilities.ts)) and model endpoint overrides before claiming sandbox enforcement.

Native tools are off by default wherever the mode can control them. Traits grant them; bounds take them back. A mode declares its grantable tools, inseparable sets, uncontrolled tools and operator override in `Mode.native`. A refused grant stays off and is listed as unavailable. Uncontrolled tools are listed even without a grant; a bound that would take one back refuses the launch. The [adapter contracts](../../adapters/README.md) explain those boundaries.

File restrictions take back native shell, file reads and file writes because native calls bypass Barry’s path guards. Barry shell guards still cannot inspect paths read by arbitrary programs; these bounds are not a process-wide filesystem sandbox.

## Native grants

A bare trait such as `native-file-reads` resolves against the running harness’s bag. If only another installed harness has it, it grants nothing and launch says so. `native-policy:` and the former `no-*` restriction traits are no longer supported; category bounds remain.

| Bound field | Native categories taken back |
| --- | --- |
| `nativeTools[H]` | Named tools |
| Nonempty `bash.deny` or `bash.denyPrograms` | Shell |
| Nonempty `network.actions` or `network.domains`, present `allowDomains`, or `enforce: sandbox` | Shell, network |
| Present `files.deny` or `files.allowOnly` | Shell, file reads, file writes |
| `deniedAccess` contains `write` | Shell, file writes |
| `deniedTools`: `Bash` or `bash` | Shell |
| `deniedTools`: `Read`, `Glob`, `Grep` | File reads |
| `deniedTools`: `Write`, `Edit` | File writes |
| `deniedTools`: `filesystem` | File reads, file writes |
| `deniedTools`: `WebFetch`, `WebSearch` | Network |
| `deniedTools`: an inventory name | That tool |

Names in `deniedTools` match case-insensitively. Categories resolve through the harness bag’s `no-<category>` bounds; a missing bag or category bound takes back the whole inventory.

| Harness | `native-shell` | `native-file-reads` | `native-file-writes` | `native-network` |
| --- | --- | --- | --- | --- |
| claude-code | Bash | Read, Glob, Grep | Write, Edit, NotebookEdit | WebFetch, WebSearch |
| codex | exec_command, write_stdin | view_image | apply_patch | web_search |
| opencode | shell | read, grep, glob | edit, write, patch | webfetch, websearch |
| pi | bash, powershell | read, grep, find, ls | edit, write | None |
| cursor | Shell, WriteShellStdin | Read, Grep, List, Glob | Write, Edit, Delete | WebFetch, WebSearch, Fetch |
| antigravity | run_command, send_command_input, command_status | view_file, grep_search, find_by_name, list_dir | write_to_file, replace_file_content, multi_replace_file_content, sed_file | read_url_content, search_web |

| Harness and mode | Control limits |
| --- | --- |
| claude, all modes | All trait tools grantable; settings deny rules remain read-only to the operator |
| codex, all modes | All trait tools grantable; `web_search` changes at thread start or resume |
| codex, guest | `/hooks` can lift the gate for the session |
| codex, instrumented | `/hooks` can lift the gate until the next turn |
| opencode, hosted and guest | All trait tools grantable; edit, write and patch must be granted together |
| pi, hosted | All three traits’ tools grantable |
| cursor, hosted | Shell, Read, Write, Edit, Delete, WebFetch and WebSearch grantable; Write, Edit and Delete inseparable. Grep, List, Glob, SemanticSearch and Fetch uncontrolled |
| cursor, guest and instrumented | Shell, WriteShellStdin, Read, Grep, List, Write, Edit, Delete and Fetch grantable; Write and Edit inseparable. WebFetch, WebSearch and Glob uncontrolled pending the author’s paid-key probe |
| antigravity, hosted | All trait tools grantable; category hook names confirmed with the local probe |
| antigravity, guest and instrumented | Same tools; `/hooks` can lift the gate |

Off by default cannot be guaranteed for the uncontrolled cursor tools, or after an operator lifts the codex or antigravity gate. A mode without `native` grants nothing. Calling an adapter without `allowedNativeTools` retains its full native ceiling.

Identity files select traits and bounds as lists of names or one-name mappings. A mapping defines a trait with the manifest fields, or a flat bound with its description and rules. `optional: true` offers an entry without applying it; a bare name selects it. Children can select a parent's optional entry or turn a required entry off with `optional: true`, but cannot redefine an inherited name.

### Shell classification limits

Shell guards are best-effort protection against ordinary mistakes (decision 28). Program rules inspect shell command structure, substitutions and common wrappers. Stdin-fed shells, eval/source and unresolved executable expansions refuse under a program rule. Unknown Git or gh command heads refuse when a corresponding subcommand restriction applies; aliases already configured outside the command cannot be resolved. Prefer network action restrictions for pushes. Python/Node/Perl/awk code, find -exec, remote ssh execution and arbitrary scripts remain outside shell classification; adversarial enforcement requires a sandbox.

Domain guards inspect quote-removed arguments, including scheme-less curl, wget and HTTPie targets. Unknown target expansions and curl/wget configuration files refuse under a domain rule. IP literals and Host header overrides are outside hostname matching; use `enforce: sandbox` to fence a host. The deprecated `bash.deny` substring rules remain supported for compatibility; use `bash.denyPrograms` for program matching.


### File guard coverage

File guards canonicalize existing symlinks and the existing parent of a new file.
On macOS they compare paths without case, matching the default filesystem. A
recursive directory rule includes the directory itself. Structured filesystem
tools expose path parameters through their schemas; the guard checks those fields,
with legacy parameter names retained for native tools. Grep/Glob/LS check their
explicit or default search root. A root above a fixed denied subtree is refused;
unanchored denied patterns conservatively refuse recursive search because the
subtree could occur anywhere below that root.

`files.allowOnly` requires absolute or home-relative roots at schema validation.
This avoids treating the shared tool-host cwd as an implicit session root. The
normalized candidate is checked once for allow rules; deny rules retain priority.
For a new allowed file, its immediate parent must exist so it can be resolved.

A nonempty file deny list or any allowOnly list withdraws Barry's Bash from
advertised tools, and the invocation guard refuses stale or direct Bash calls.
Use the structured filesystem tools under these bounds. This follows Step 12's
explicit shell-withdrawal alternative: scripts and persisted shell cwd cannot be
reliably covered by an argv predicate. These remain application safety rails,
not a cryptographic filesystem sandbox; other custom tools, native provider
capabilities and filesystem races require their own enforcement. HTTP URLs passed
to open are not treated as filesystem paths; file rules do not enforce egress.

### Hosted approval predicate cleanup

The unused `decidePermission`, `PermissionQuestion` and `PermissionVerdict` exports
were removed. They had no runtime callers and did not implement the network
checks used by bound guards. Hosted sessions use their native-tool policy and
durable approval path; MCP invocation uses `applyBoundGuards`. Neither path
consumes a second exported permission predicate.
### Recognized network actions

Under owner decision 28, `network.actions: [all]` remains a denylist of recognized
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
