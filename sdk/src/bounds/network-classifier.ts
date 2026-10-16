/**
 * Network action classifier for bound enforcement.
 *
 * Maps bash commands and structured tools to semantic network action tags
 * (e.g. "git:push", "http:write") so bounds can deny categories of network
 * access without enumerating every tool or program.
 *
 * The action hierarchy lets a single rule like `actions: ["write"]` deny
 * git push, HTTP POST, and SCP uploads in one declaration.
 *
 * This is application-level enforcement — a cooperative safety rail against
 * well-meaning agents, not a hard boundary against adversarial code. Pair
 * with `enforce: "sandbox"`, which routes the process tree through an egress
 * proxy filtering by hostname. Not Seatbelt: it filters by IP and port and
 * cannot match hostnames at all (see the README's bound primitive).
 */

import { classifyBashCommand, type BashClassification } from "./bash-classifier.js";

/**
 * Parent → children. "write" expands to "git:push" + "http:write" + "ssh:write".
 * "all" expands to everything.
 */
const NETWORK_ACTION_HIERARCHY: Record<string, string[]> = Object.assign(
  Object.create(null) as Record<string, string[]>,
  {
    "*": ["all"],
    all: ["write", "read"],
    // `ssh:read` must hang off `read`, not float free: otherwise
    // `actions: ["all"]` — which every caller reads as "deny all network" —
    // silently permits interactive `ssh`.
    write: ["git:push", "http:write", "ssh:write"],
    read: ["git:fetch", "http:read", "ssh:read", "dns"],
  },
);

/**
 * Expand a set of action tags to include all descendants.
 * e.g. ["write"] → {"write", "git:push", "http:write", "ssh:write"}
 */
export function expandActions(actions: string[]): Set<string> {
  const expanded = new Set<string>();
  const queue = [...actions];
  while (queue.length > 0) {
    const action = queue.pop()!;
    if (expanded.has(action)) continue;
    expanded.add(action);
    // Null-prototype map, so keys like "__proto__"/"constructor" resolve to
    // undefined instead of Object.prototype members (which threw on spread).
    const children = NETWORK_ACTION_HIERARCHY[action];
    if (Array.isArray(children)) queue.push(...children);
  }
  return expanded;
}

// Program → network action mapping

/**
 * Maps program names (and program:subcommand pairs) to the network action
 * tags they perform. Uses the same program:subcommand format as the bash
 * classifier's BashClassification.subcommands.
 */
const PROGRAM_ACTIONS: Record<string, string[]> = Object.assign(
  Object.create(null) as Record<string, string[]>,
  {
    // Git
    "git:push": ["git:push"],
    "git:fetch": ["git:fetch"],
    "git:pull": ["git:fetch"],
    "git:clone": ["git:fetch"],
    "git:ls-remote": ["git:fetch"],
    "git:submodule": ["git:fetch"],
    // GitHub CLI. The bash classifier already synthesizes `gh:api:write` for
    // mutating `gh api` calls, so both variants map here.
    "gh:api": ["http:read"],
    "gh:api:write": ["http:write"],
    "git:remote:update": ["git:fetch"],
    "git:svn:dcommit": ["git:push"],
    "git:send-email": ["http:write"],
    // SSH family

    sftp: ["ssh:write"],
    // DNS
    dig: ["dns"],
    nslookup: ["dns"],
    host: ["dns"],
  },
);

/** Recognized remote clients remain a denylist under owner decision 28. */
function commonClientActions(program: string, argv: string[]): string[] {
  const [first, second] = clientOperands(argv, new Set(["--profile", "--region", "--endpoint-url", "--output", "--query", "--project", "--account", "--configuration", "--subscription", "--context", "--namespace", "-n", "--kubeconfig", "--prefix", "--cwd", "-C", "--directory", "--dir", "--workspace-dir", "--filter", "--workspace", "-w", "-R", "--repo", "--hostname"]));
  const read = ["http:read"];
  const write = ["http:write"];
  if (program === "gh") {
    if (first === "api") {
      const mutating = argv.some((arg, index) => {
        if (/^-(?:f|F)(?:.+)?$|^--(?:raw-)?field(?:=|$)/.test(arg)) return true;
        const method = arg === "-X" || arg === "--method" ? argv[index + 1] : arg.match(/^(?:-X|--method=)(.+)$/)?.[1];
        return method !== undefined && !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
      });
      return mutating ? write : read;
    }
    if (["pr", "issue", "release", "repo", "gist", "secret", "variable", "workflow"].includes(first ?? "") && second) {
      return ["view", "list", "status", "checks", "diff", "download", "clone", "watch", "verify", "ls"].includes(second) ? read : write;
    }
  }
  if (["npm", "pnpm", "yarn"].includes(program)) {
    if (["publish", "unpublish", "deprecate", "login", "logout", "adduser", "owner", "access", "token"].includes(first ?? "")) return write;
    if (first === "dist-tag") return second === "ls" ? read : write;
    if (["install", "i", "ci", "add", "update", "upgrade", "outdated", "audit", "view", "info", "search", "fetch", "dlx", "exec"].includes(first ?? "")) return read;
  }
  if (["pip", "pip3", "uv"].includes(program)) {
    if (["install", "download", "index", "sync", "add", "tool", "pip"].includes(first ?? "")) return read;
  }
  if (program === "brew" && ["install", "update", "upgrade", "fetch", "tap"].includes(first ?? "")) return read;
  if (program === "docker") {
    if (["push", "login", "logout"].includes(first ?? "")) return write;
    if (["pull", "search", "build"].includes(first ?? "")) return read;
  }
  if (program === "kubectl") return ["get", "describe", "logs", "version", "api-resources", "api-versions", "explain"].includes(first ?? "") ? read : write;
  if (program === "terraform") {
    if (["apply", "destroy", "import", "refresh", "taint", "untaint", "force-unlock"].includes(first ?? "")) return write;
    if (["init", "plan", "output", "show", "state"].includes(first ?? "")) return first === "state" && !["list", "show", "pull"].includes(second ?? "") ? write : read;
  }
  if (["aws", "gcloud", "az"].includes(program)) {
    if (program === "aws" && first === "s3" && ["cp", "sync", "mv"].includes(second ?? "")) {
      const operands = clientOperands(argv, new Set(["--profile", "--region", "--endpoint-url", "--output", "--query"]));
      const destination = operands[3];
      return second === "mv" || destination?.startsWith("s3://") ? write : read;
    }
    // These clients have large, evolving mutation vocabularies. Unknown
    // operations on a recognized cloud client conservatively count as writes.
    return /^(?:get(?:-|$)|list(?:-|$)|describe(?:-|$)|show$|ls$)/.test(second ?? "") ? read : write;
  }
  if (["nc", "netcat", "ncat", "socat", "telnet"].includes(program)) return ["http:read", "http:write"];
  if (program === "openssl" && first === "s_client") return ["http:read", "http:write"];
  if (program === "ssh") {
    const operands = clientOperands(argv, new Set(["-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]));
    return operands.length > 1 || argv.some(arg => /^-[LRDW]/.test(arg)) ? ["ssh:write"] : ["ssh:read"];
  }
  if (program === "scp" || program === "rsync") {
    const operands = clientOperands(argv, new Set(program === "scp" ? ["-c", "-D", "-F", "-i", "-J", "-l", "-o", "-P", "-S", "-X"] : ["-e", "-f", "--rsh", "--filter", "--exclude", "--include", "--exclude-from", "--include-from", "--files-from", "--rsync-path", "--port", "--password-file", "--timeout", "--bwlimit", "--log-file"]));
    const remote = (operand: string) => operand.startsWith("rsync://") || /^[^/]+:/.test(operand);
    if (operands.length < 2) return [];
    if (remote(operands.at(-1)!)) return ["ssh:write"];
    if (operands.slice(0, -1).some(remote)) return argv.includes("--remove-source-files") || argv.some(arg => arg.startsWith("--rsync-path")) ? ["ssh:write"] : ["ssh:read"];
  }
  return [];
}

/** Skip option values so a port or identity path cannot become the host. */
function clientOperands(argv: string[], valueOptions: Set<string>): string[] {
  const operands: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") return [...operands, ...argv.slice(i + 1)];
    if (token.startsWith("-")) {
      if (valueOptions.has(token)) i++;
      continue;
    }
    operands.push(token);
  }
  return operands;
}

/**
 * Programs that make HTTP requests. Their action depends on whether the
 * invocation is read or write — determined by flag inspection.
 */
// `http` and `https` are both real httpie entry points (Homebrew ships both as
// symlinks). Omitting `https` here made the `prog === "https"` arm below
// unreachable, so `https POST example.com a=1` classified as no network action
// at all and sailed past `actions: ["write"]`.
const HTTP_PROGRAMS = new Set(["curl", "wget", "httpie", "http", "https"]);

/**
 * curl short flags that consume a value.
 *
 * Needed to decompose a bundled cluster correctly: in `-sdx=1` the `d` is a
 * body flag and `x=1` is its value, while in `-sI` both characters are
 * booleans. Without knowing which is which, a cluster cannot be split, and the
 * previous regexes could only recognise a body flag that stood alone.
 *
 * Taken from `curl --help all`; curl's short-option set is closed and has been
 * stable for years, so enumerating it is safe in a way that enumerating body
 * *spellings* was not.
 */
const CURL_SHORT_FLAGS_WITH_VALUE = new Set(
  "EKCbcdDFPhHmoxUQreXYytTuAw".split(""),
);

/** curl short flags that take no value. */
const CURL_SHORT_BOOLEAN_FLAGS = new Set(
  "aqfGgIkjlLMnNZpJORSsivV#01234".split(""),
);

/**
 * Short flags whose presence means curl sends a request body.
 * `-d` data, `-F` multipart form, `-T` upload-file (PUT).
 */
const CURL_BODY_SHORT_FLAGS = new Set(["d", "F", "T"]);

/**
 * Long flags whose presence means curl sends a request body.
 *
 * Matched as a whole flag name, after any `=value` is split off, so a new
 * `--data-*` spelling cannot slip in through a loose prefix match.
 */
const CURL_BODY_LONG_FLAGS = new Set([
  "data",
  "data-ascii",
  "data-binary",
  "data-raw",
  "data-urlencode",
  "json",
  "form",
  "form-escape",
  "form-string",
  "upload-file",
]);

/**
 * Decompose one curl short-flag cluster.
 *
 * Returns the flag characters it contains, and whether the cluster swallowed
 * its value (so the caller must not also skip the following token), or null
 * when a character is not a flag this code knows. Unknown means we cannot tell
 * where the cluster's flags end and a value begins, so the caller fails closed
 * rather than guessing.
 */
function splitCurlShortCluster(
  token: string,
): { flags: string[]; consumedValue: boolean } | null {
  const flags: string[] = [];
  for (let i = 1; i < token.length; i++) {
    const ch = token[i];
    if (CURL_SHORT_FLAGS_WITH_VALUE.has(ch)) {
      flags.push(ch);
      // The rest of the token is this flag's value (`-dx=1`), or the value is
      // the next argv token (`-d x=1`) when the cluster ends here.
      return { flags, consumedValue: i + 1 < token.length };
    }
    if (CURL_SHORT_BOOLEAN_FLAGS.has(ch)) {
      flags.push(ch);
      continue;
    }
    return null;
  }
  return { flags, consumedValue: false };
}

/**
 * Detect whether a curl invocation is mutating (POST/PUT/PATCH/DELETE).
 * Mirrors the ghApiIsMutating pattern in bash-classifier.ts.
 *
 * WHY THIS PARSES RATHER THAN PATTERN-MATCHES
 * -------------------------------------------
 * The previous version tested each token against regexes anchored on a body
 * flag standing alone or followed by `=`. That recognised `-d x=1` and
 * `--data=x` but silently cleared every *attached* form curl accepts:
 * `curl -dx=1 URL`, `-Fx=1`, `-d@payload.json`, `-T./file`, and any bundled
 * cluster such as `-sdx=1`. All five were confirmed against a loopback
 * listener to send a real body (four POSTs and a PUT) while classifying as
 * `http:read`, so `actions: ["write"]` did not stop them.
 *
 * Enumerating body-flag spellings cannot close that: the gap was in the
 * *grammar*, not the vocabulary. So this decomposes clusters using curl's
 * short-option table instead, and FAILS CLOSED — an unrecognised short flag
 * means the cluster cannot be split, which means a `d`/`F`/`T` could be hiding
 * inside it, so the command is treated as a write. A new curl flag therefore
 * costs a false deny (loud, fixable) rather than a silent bypass of a security
 * bound. Same posture as `wgetIsMutating`'s bare `--method` and the unknown
 * HTTP client in `classifyNetworkActions`.
 */
function curlIsMutating(argv: string[]): boolean {
  // Scan ALL flags before deciding. An earlier version returned false as soon
  // as it saw -I/--head, so `curl -I -d x=1 URL` was classified as a read even
  // though curl sends the body — a write bypass that depended only on flag
  // order. A body flag anywhere wins over a HEAD flag anywhere.
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--") break; // everything after is a URL, not a flag
    if (!a.startsWith("-") || a === "-") continue;

    if (a.startsWith("--")) {
      // `--name=value` or `--name value`; only the name decides.
      const eq = a.indexOf("=");
      const name = (eq === -1 ? a : a.slice(0, eq)).slice(2);
      if (CURL_BODY_LONG_FLAGS.has(name)) return true;
      if (name === "request") {
        const value = eq === -1 ? argv[k + 1] : a.slice(eq + 1);
        if (value && isMutatingMethod(value)) return true;
      }
      continue;
    }

    const cluster = splitCurlShortCluster(a);
    if (!cluster) return true; // unknown short flag — fail closed, see above
    if (cluster.flags.some((f) => CURL_BODY_SHORT_FLAGS.has(f))) return true;

    const last = cluster.flags[cluster.flags.length - 1];
    if (last === "X") {
      // `-XPOST` (attached) or `-X POST` / `-sX POST` (next token).
      const value = cluster.consumedValue
        ? a.slice(a.indexOf("X") + 1)
        : argv[k + 1];
      if (value && isMutatingMethod(value)) return true;
    }
    // A value-taking flag that ate the next token must not have that token
    // re-read as a flag — `-o -dx=1` writes to a file named `-dx=1`.
    if (last !== undefined && CURL_SHORT_FLAGS_WITH_VALUE.has(last) && !cluster.consumedValue) {
      k++;
    }
  }
  // No body/method flag found — a plain GET (or an explicit -I HEAD).
  return false;
}

/** Anything that isn't a safe/idempotent read method counts as mutating. */
function isMutatingMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

/**
 * Detect whether a wget invocation is mutating.
 */
function wgetIsMutating(argv: string[]): boolean {
  for (const a of argv) {
    // Bare and attached forms. `--method=POST` was previously missed entirely.
    if (/^--post-data(?:=|$)/.test(a) || /^--post-file(?:=|$)/.test(a)) return true;
    if (/^--body-data(?:=|$)/.test(a) || /^--body-file(?:=|$)/.test(a)) return true;
    if (a === "--method") return true; // value unknown here — fail closed
    const m = a.match(/^--method=(.+)$/);
    if (m && isMutatingMethod(m[1])) return true;
  }
  return false;
}

/**
 * Detect whether an HTTPie invocation is mutating.
 *
 * HTTPie takes the method as a positional argument (`http POST url k=v`) and
 * also treats `k=v` / `k:=v` item syntax as a request body, which implies a
 * POST even with no explicit method.
 */
function httpieIsMutating(argv: string[]): boolean {
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k];
    if (a.startsWith("-")) continue;
    // First bare word after flags is the method if it looks like one.
    if (/^[A-Za-z]+$/.test(a)) return isMutatingMethod(a);
    break;
  }
  // No explicit method: item syntax (k=v, k:=v, k@file) implies a body → POST.
  return argv.slice(1).some((a) => !a.startsWith("-") && /^[\w.-]+(?:=|:=|@)/.test(a));
}

/**
 * Given a BashClassification and the raw command string, return all network
 * action tags the command would perform.
 */
export function classifyNetworkActions(
  classification: BashClassification,
  rawCommand: string,
): string[] {
  const actions = new Set<string>();

  for (const prog of classification.programs) {
    // Check program:subcommand entries first (e.g. "git:push")
    const subs = classification.subcommands.get(prog);
    if (subs) {
      for (const sub of subs) {
        const key = `${prog}:${sub}`;
        const mapped = PROGRAM_ACTIONS[key];
        if (mapped) mapped.forEach((a) => actions.add(a));
      }
    }

    // Inspect each effective argv independently, including wrapped commands.
    for (const argv of classification.argvs.filter(argv => argv[0]?.split("/").pop()?.toLowerCase() === prog)) {
      commonClientActions(prog, argv).forEach(action => actions.add(action));
    }

    // Check bare program name (e.g. "ssh", "scp", "dig")
    const bareActions = PROGRAM_ACTIONS[prog];
    if (bareActions) bareActions.forEach((a) => actions.add(a));

    // HTTP programs: inspect flags to determine read vs write.
    if (HTTP_PROGRAMS.has(prog)) {
      const invocations = classification.argvs.filter(argv => argv[0]?.split("/").pop()?.toLowerCase() === prog);
      for (const argv of invocations.length ? invocations : [tokenizeForFlags(rawCommand)]) {
        let isMutating: boolean;
        if (prog === "curl") isMutating = curlIsMutating(argv);
        else if (prog === "wget") isMutating = wgetIsMutating(argv);
        else if (prog === "httpie" || prog === "http" || prog === "https") {
          isMutating = httpieIsMutating(argv);
        } else {
          // Unknown HTTP client: we cannot determine the method, so claim BOTH.
          // Fail closed — an undetectable POST must not slip past a write deny.
          isMutating = true;
          actions.add("http:read");
        }
        actions.add(isMutating ? "http:write" : "http:read");
      }
    }
  }

  return [...actions];
}

/**
 * Split a raw command into flag-inspectable tokens.
 *
 * Strips surrounding quotes so `curl "https://x" -d y` tokenizes usefully.
 * This is deliberately approximate: it is only used to spot method/body flags,
 * and `isNetworkActionDenied` fails closed on anything the bash classifier
 * could not parse, so an imperfect split cannot create a silent bypass.
 */
function tokenizeForFlags(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((t) => t.replace(/^['"]+/, "").replace(/['"]+$/, ""))
    .filter(Boolean);
}

// Structured tool → network action mapping

/**
 * Static map of MCP/structured tool names to their network action tags.
 *
 * Keys are bare tool names as a bag defines them — `push`, not
 * `mcp__git__push`. Tools no longer repeat their namespace, so these match the
 * git bag's own names. A key naming a tool that does not exist is silently
 * inert, so entries must be kept in step with the bag (`git_clone` sat here
 * for a while against a tool that was never defined).
 */
export const NETWORK_TOOL_ACTIONS: Record<string, string[]> = {
  push: ["git:push"],
  pull: ["git:fetch"],
  fetch: ["git:fetch"],
  remotes: ["git:fetch"],
  clone: ["git:fetch"],
  WebFetch: ["http:read"],
  WebSearch: ["http:read"],
  // The github bag calls the GitHub API directly, where the Bash classifier
  // that sees `gh` cannot look. Both Bash mutations and these direct API
  // tools need their own write tags. (pr_findpath only looks on disk.)
  pr_create: ["http:write"],
  pr_comment: ["http:write"],
  pr_review: ["http:write"],
  pr_checks: ["http:read"],
  pr_threads: ["http:read"],
  // pr_clean has an agent rewrite the branch, then fetch and force-push it.
  pr_clean: ["git:fetch", "git:push"],
};

/**
 * Tools whose parameters carry a URL that domain rules should apply to.
 * Maps tool name → the parameter holding the URL.
 *
 * Without this, `domains` only ever constrained Bash, so denying
 * `*.internal.co` still left `WebFetch https://api.internal.co` working.
 */
export const NETWORK_TOOL_URL_PARAMS: Record<string, string> = {
  WebFetch: "url",
  // The git bag's clone takes its source here, only in forms whose host
  // extractDomainsFromCommand reads (a scheme URL or user@host:path).
  clone: "url",
};

/**
 * Return tool names that should be denied based on network action restrictions.
 * Used by filterTools to expand the denied set.
 */
export function getImpliedDeniedTools(actions: string[]): string[] {
  const expanded = expandActions(actions);
  const denied: string[] = [];
  for (const [toolName, toolActions] of Object.entries(NETWORK_TOOL_ACTIONS)) {
    if (toolActions.some((a) => expanded.has(a))) {
      denied.push(toolName);
    }
  }
  return denied;
}

/**
 * Check if a bash command performs a denied network action.
 * Returns the matched action tag, or null if allowed.
 */
export function isNetworkActionDenied(
  command: string,
  actions: string[],
): string | null {
  if (!actions || actions.length === 0) return null;

  const expanded = expandActions(actions);
  const classification = classifyBashCommand(command);

  // Fail closed on obfuscated input, matching isProgramDenied. Without this,
  // `C=curl; $C https://x.com` classifies to no known program, yields no
  // network actions, and sails past `actions: ["all"]` — the guard's central
  // promise. If we cannot read the command, we cannot clear it.
  if (classification.unparseable) return "<unparseable-command>";

  const commandActions = classifyNetworkActions(classification, command);

  for (const action of commandActions) {
    if (expanded.has(action)) return action;
  }

  return null;
}

/**
 * Check if a domain matches any deny pattern.
 * Patterns support wildcards: "*.foo.com" matches "api.foo.com" and "x.y.foo.com".
 * Exact match: "staging.example.com" matches only that domain.
 */
export function isDomainDenied(domain: string, domains: string[]): string | null {
  // Normalize the trailing dot: "foo.com." is a valid FQDN that curl accepts,
  // and without this it slipped past an exact-match "foo.com" rule.
  const lower = domain.toLowerCase().replace(/\.+$/, "");
  for (const pattern of domains) {
    const p = pattern.toLowerCase().replace(/\.+$/, "");
    if (p === "*") return pattern;
    if (p.startsWith("*.")) {
      const bare = p.slice(2);
      // `*.foo.com` matches foo.com and any depth of subdomain.
      if (lower === bare || lower.endsWith(`.${bare}`)) return pattern;
    } else if (lower === p || lower.endsWith(`.${p}`)) {
      // A bare pattern covers its subdomains too. Users write
      // `domains: ["internal.co"]` meaning "that company", not "that exact
      // hostname" — matching only the apex silently allowed www.internal.co.
      return pattern;
    }
  }
  return null;
}

/**
 * Best-effort extraction of domains/URLs from a bash command string.
 * Inspects arguments of known HTTP programs (curl, wget) and git clone URLs.
 * Returns an array of domain strings (lowercased).
 */
const CURL_VALUE_OPTIONS = new Set([
  "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "-o", "--output", "-P", "--ftp-port", "-A", "--user-agent", "-b", "--cookie", "-c", "--cookie-jar",
  "-u", "--user", "-e", "--referer", "-F", "--form", "--form-string", "-T", "--upload-file",
  "-x", "--proxy", "--proxy-user", "--cacert", "--cert", "--key", "--connect-timeout", "--max-time",
  "-U", "--json", "--data-ascii", "-E", "--cert-type", "--capath", "--proxy-header", "--output-dir", "-m", "--retry", "--retry-delay",
]);

const WGET_VALUE_OPTIONS = new Set([
  "-o", "-a", "-O", "-P", "-A", "-R", "-e", "-t", "-T", "-U", "-X", "-n", "-Q", "-w",
  "--header", "--user-agent", "--output-document", "--directory-prefix", "--post-data", "--post-file",
  "--method", "--body-data", "--body-file", "--user", "--password", "--http-user", "--http-password",
  "--proxy-user", "--proxy-password", "--certificate", "--private-key", "--ca-certificate", "--timeout",
]);

const HTTPIE_VALUE_OPTIONS = new Set(["-a", "--auth", "--session", "--session-read-only", "--proxy", "--timeout", "--verify", "--cert", "--cert-key", "--ssl", "--ciphers", "--output", "-o", "--style", "--pretty", "--print", "-p"]);

function domainArguments(argv: string[]): { targets: string[]; unknown: boolean } {
  const program = argv[0]?.split("/").at(-1)?.toLowerCase();
  if (!HTTP_PROGRAMS.has(program ?? "")) return { targets: argv.slice(1), unknown: false };
  const targets: string[] = [];
  let unknown = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (program === "curl" && /^(?:-K|--config(?:=|$))/.test(arg)
      || program === "wget" && /^(?:-i|--input-file(?:=|$))/.test(arg)) unknown = true;
    if (arg === "--url") { if (argv[i + 1]) targets.push(argv[++i]); else unknown = true; continue; }
    if (arg.startsWith("--url=")) { targets.push(arg.slice(6)); continue; }
    const values = program === "wget" ? WGET_VALUE_OPTIONS : program === "curl" ? CURL_VALUE_OPTIONS : HTTPIE_VALUE_OPTIONS;
    if (values.has(arg)) { i++; continue; }
    if (arg.startsWith("-")) continue;
    if ((program === "http" || program === "https") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) && /^[^/:]+(?:=|:)/.test(arg)) continue;
    targets.push(arg);
  }
  if (targets.some(target => /\$|`/.test(target)
    || /[{}*]/.test(target.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]+)/i)?.[1] ?? ""))) unknown = true;
  return { targets, unknown };
}

/** True when a domain-only guard cannot establish the requested HTTP target. */
export function hasUnknownDomainTarget(command: string): boolean {
  const classification = classifyBashCommand(command);
  return classification.unparseable || classification.argvs.some(argv => domainArguments(argv).unknown);
}

export function extractDomainsFromCommand(command: string): string[] {
  const domains: string[] = [];
  // Strip quotes: `curl "https://x.com"` is the normal way to write a URL, and
  // leaving the quote attached made the anchored patterns miss it entirely.
  const classification = classifyBashCommand(command);
  const tokens = classification.argvs.flatMap(argv => domainArguments(argv).targets);
  // Structured network tools pass a URL directly instead of a shell command.
  const singleArgument = classification.argvs.length === 1 && classification.argvs[0].length === 1
    ? classification.argvs[0][0] : undefined;
  if (singleArgument && (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(singleArgument)
    || /^[^\s@]+@[^/:]+:/.test(singleArgument))) tokens.push(singleArgument);


  for (const token of tokens) {
    // Any scheme, plus scheme-relative `//host`. Previously https?-only, which
    // let git://, ssh://, and ftp:// through.
    const urlMatch = token.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]+)/i)
      // `--url=https://host` and friends: retry after the first `=`.
      ?? token.match(/=(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]+)/i);
    if (urlMatch) {
      const host = normalizeHost(urlMatch[1]);
      if (host) domains.push(host);
      continue;
    }
    // scp/git SSH shorthand: user@host:path. The user part may contain digits,
    // dots or dashes (`git-user@host:`), not just lowercase letters.
    const gitSshMatch = token.match(/^[A-Za-z0-9._-]+@([^:/]+):/);
    if (gitSshMatch) {
      const host = normalizeHost(gitSshMatch[1]);
      if (host) domains.push(host);
    }
  }

  for (const argv of classification.argvs) {
    const program = argv[0]?.split("/").at(-1)?.toLowerCase();
    if (!HTTP_PROGRAMS.has(program ?? "")) continue;
    // Scheme-less HTTP targets use the same authority matching as explicit URLs.
    for (const arg of domainArguments(argv).targets) {
      if (!arg.startsWith("-") && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+(?:[/:?#]|$)/.test(arg)) {
        const host = normalizeHost(arg.split(/[/?#]/)[0]);
        if (host) domains.push(host);
      }
    }
  }
  return [...new Set(domains)];
}

/**
 * Reduce a URL authority to a bare comparable hostname.
 *
 * Drops userinfo, port, and any trailing dot. The userinfo case is the one
 * that matters: `https://user:pass@evil.com/x` previously yielded "user",
 * so the real host never reached the deny list at all.
 */
function normalizeHost(authority: string): string | null {
  let host = authority;
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1);
  // IPv6 literal: [::1]:443
  const v6 = host.match(/^\[([^\]]+)\]/);
  if (v6) return v6[1].toLowerCase();
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  try { host = decodeURIComponent(host); } catch { return null; }
  host = host.replace(/\.+$/, "").toLowerCase();
  return host || null;
}

/** All recognized network action tags. */
export const KNOWN_NETWORK_ACTIONS: ReadonlySet<string> = expandActions(["*", "all"]);

export type ParsedNetworkRule =
  | { kind: "action"; action: string; raw: string }
  | {
      kind: "url";
      method?: string;
      scheme: string;
      hostPattern: string;
      pathPattern: string;
      raw: string;
    }
  | { kind: "domain"; domain: string; raw: string };

/**
 * Parse a single network rule entry from `network.allow` or `network.deny`.
 * Distinguishes action tags (`write`, `http:read`), `[METHOD ]https://...` URL
 * globs, and domain globs (`*.internal.co`, `api.github.com`).
 */
export function parseNetworkRule(entry: string): ParsedNetworkRule {
  const trimmed = entry.trim();
  if (KNOWN_NETWORK_ACTIONS.has(trimmed)) {
    return { kind: "action", action: trimmed, raw: entry };
  }
  const urlMatch = trimmed.match(/^(?:([A-Za-z]+|\*)\s+)?([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(\/[^#]*)?$/i);
  if (urlMatch) {
    const method = urlMatch[1] ? urlMatch[1].toUpperCase() : undefined;
    const scheme = urlMatch[2].toLowerCase();
    const hostPattern = urlMatch[3].toLowerCase().replace(/\.+$/, "");
    const pathPattern = urlMatch[4] || "/**";
    return {
      kind: "url",
      ...(method && method !== "*" ? { method } : {}),
      scheme,
      hostPattern,
      pathPattern,
      raw: entry,
    };
  }
  return { kind: "domain", domain: trimmed, raw: entry };
}

/**
 * Canonicalize a candidate URL using `new URL(...)` so path traversal
 * (`/repos/a/b/issues/../pulls`) and percent-encoding are normalized before
 * matching against URL globs.
 */
export function canonicalizeNetworkUrl(rawUrl: string): {
  scheme: string;
  host: string;
  pathname: string;
  search: string;
  href: string;
} | null {
  try {
    const parsed = new URL(rawUrl);
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    const host = normalizeHost(parsed.host);
    if (!host) return null;
    const pathname = decodeURIComponent(parsed.pathname) || "/";
    return {
      scheme,
      host,
      pathname,
      search: parsed.search,
      href: parsed.href,
    };
  } catch {
    return null;
  }
}

function pathGlobToRegExp(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.slice(i, i + 3) === "/**" && i + 3 === pattern.length) {
      regex += "(?:/.*)?";
      i += 3;
      continue;
    }
    if (pattern.slice(i, i + 3) === "/**") {
      regex += "(?:/.*)?";
      i += 3;
      continue;
    }
    if (pattern.slice(i, i + 2) === "**") {
      regex += ".*";
      i += 2;
      continue;
    }
    if (pattern[i] === "*") {
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (pattern[i] === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }
    regex += pattern[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  regex += "$";
  return new RegExp(regex);
}

/**
 * Match a candidate `{ method, url }` against a parsed URL pattern rule.
 */
export function matchesUrlPattern(
  candidate: { method?: string; url: string },
  rule: Extract<ParsedNetworkRule, { kind: "url" }>,
): boolean {
  if (rule.method && rule.method !== "*") {
    if (!candidate.method || candidate.method.toUpperCase() !== rule.method) {
      return false;
    }
  }
  const canonical = canonicalizeNetworkUrl(candidate.url);
  if (!canonical) return false;
  if (canonical.scheme !== rule.scheme) return false;
  if (isDomainDenied(canonical.host, [rule.hostPattern]) === null) return false;

  const targetPath = rule.pathPattern.includes("?")
    ? `${canonical.pathname}${canonical.search}`
    : canonical.pathname;
  return pathGlobToRegExp(rule.pathPattern).test(targetPath);
}

export interface ExtractedHttpRequest {
  method: string;
  url: string;
  host: string;
  action: "http:read" | "http:write";
}

function extractCurlMethod(argv: string[]): string {
  let explicitMethod: string | undefined;
  let hasBody = false;
  let hasUpload = false;
  let hasHead = false;
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--") break;
    if (!a.startsWith("-") || a === "-") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = (eq === -1 ? a : a.slice(0, eq)).slice(2);
      if (name === "upload-file") hasUpload = true;
      else if (CURL_BODY_LONG_FLAGS.has(name)) hasBody = true;
      else if (name === "head") hasHead = true;
      else if (name === "request") {
        const value = eq === -1 ? argv[k + 1] : a.slice(eq + 1);
        if (value) explicitMethod = value.toUpperCase();
      }
      continue;
    }
    const cluster = splitCurlShortCluster(a);
    if (!cluster) return "POST";
    if (cluster.flags.includes("T")) hasUpload = true;
    if (cluster.flags.includes("d") || cluster.flags.includes("F")) hasBody = true;
    if (cluster.flags.includes("I")) hasHead = true;
    const last = cluster.flags[cluster.flags.length - 1];
    if (last === "X") {
      const value = cluster.consumedValue ? a.slice(a.indexOf("X") + 1) : argv[k + 1];
      if (value) explicitMethod = value.toUpperCase();
    }
    if (last !== undefined && CURL_SHORT_FLAGS_WITH_VALUE.has(last) && !cluster.consumedValue) {
      k++;
    }
  }
  if (explicitMethod) return explicitMethod;
  if (hasUpload) return "PUT";
  if (hasBody) return "POST";
  if (hasHead) return "HEAD";
  return "GET";
}

function extractWgetMethod(argv: string[]): string {
  for (const a of argv) {
    const m = a.match(/^--method=(.+)$/);
    if (m) return m[1].toUpperCase();
    if (a === "--method") return "POST";
    if (/^--(?:post|body)-(?:data|file)(?:=|$)/.test(a)) return "POST";
  }
  return "GET";
}

function extractHttpieMethod(argv: string[]): string {
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k];
    if (a.startsWith("-")) continue;
    if (/^[A-Za-z]+$/.test(a)) return a.toUpperCase();
    break;
  }
  if (argv.slice(1).some((a) => !a.startsWith("-") && /^[\w.-]+(?:=|:=|@)/.test(a))) {
    return "POST";
  }
  return "GET";
}

const GH_API_VALUE_OPTIONS = new Set([
  "-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field",
  "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache",
]);

function extractGhApiRequests(argv: string[]): { requests: ExtractedHttpRequest[]; unknown: boolean } {
  let method: string | undefined;
  let hasField = false;
  let hostname = "api.github.com";
  const endpoints: string[] = [];
  let seenApi = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!seenApi) {
      if (arg === "api") {
        seenApi = true;
        continue;
      }
      if (arg === "-R" || arg === "--repo" || arg === "--hostname") {
        if (arg === "--hostname" && argv[i + 1]) hostname = argv[i + 1];
        i++;
      }
      continue;
    }
    if (arg === "-X" || arg === "--method") {
      if (argv[i + 1]) method = argv[++i].toUpperCase();
      continue;
    }
    const methodMatch = arg.match(/^(?:-X|--method=)(.+)$/);
    if (methodMatch) {
      method = methodMatch[1].toUpperCase();
      continue;
    }
    if (arg === "--hostname") {
      if (argv[i + 1]) hostname = argv[++i];
      continue;
    }
    const hostMatch = arg.match(/^--hostname=(.+)$/);
    if (hostMatch) {
      hostname = hostMatch[1];
      continue;
    }
    if (/^-(?:f|F)(?:.+)?$|^--(?:raw-)?field(?:=|$)|^--input(?:=|$)/.test(arg)) {
      hasField = true;
      if ((arg === "-f" || arg === "-F" || arg === "--field" || arg === "--raw-field" || arg === "--input") && argv[i + 1]) {
        i++;
      }
      continue;
    }
    if (GH_API_VALUE_OPTIONS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    endpoints.push(arg);
  }

  if (!seenApi) return { requests: [], unknown: false };
  if (endpoints.length === 0) return { requests: [], unknown: true };

  const effectiveMethod = method ?? (hasField ? "POST" : "GET");
  const action: "http:read" | "http:write" = isMutatingMethod(effectiveMethod) ? "http:write" : "http:read";
  const requests: ExtractedHttpRequest[] = [];
  let unknown = false;

  for (const endpoint of endpoints) {
    if (/\$|`/.test(endpoint)) {
      unknown = true;
      continue;
    }
    const fullUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint)
      ? endpoint
      : `https://${hostname}/${endpoint.replace(/^\/+/, "")}`;
    const canonical = canonicalizeNetworkUrl(fullUrl);
    if (!canonical) {
      unknown = true;
      continue;
    }
    requests.push({
      method: effectiveMethod,
      url: canonical.href,
      host: canonical.host,
      action,
    });
  }

  return { requests, unknown };
}

/**
 * Extract structured HTTP requests (`{ method, url, host, action }`) from a
 * bash command across `curl`, `wget`, `httpie`, and `gh api`.
 */
export function extractHttpRequestsFromCommand(command: string): {
  requests: ExtractedHttpRequest[];
  unknown: boolean;
} {
  const classification = classifyBashCommand(command);
  if (classification.unparseable) return { requests: [], unknown: true };

  const requests: ExtractedHttpRequest[] = [];
  let unknown = false;

  for (const argv of classification.argvs) {
    const program = argv[0]?.split("/").at(-1)?.toLowerCase();
    if (!program) continue;

    if (program === "gh") {
      const ghRes = extractGhApiRequests(argv);
      if (ghRes.unknown) unknown = true;
      requests.push(...ghRes.requests);
      continue;
    }

    if (!HTTP_PROGRAMS.has(program)) continue;
    const domArgs = domainArguments(argv);
    if (domArgs.unknown || domArgs.targets.length === 0) {
      unknown = true;
      continue;
    }

    const method =
      program === "curl"
        ? extractCurlMethod(argv)
        : program === "wget"
          ? extractWgetMethod(argv)
          : extractHttpieMethod(argv);
    const action: "http:read" | "http:write" = isMutatingMethod(method) ? "http:write" : "http:read";

    for (const target of domArgs.targets) {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
        ? target
        : program === "https"
          ? `https://${target}`
          : `http://${target}`;
      const canonical = canonicalizeNetworkUrl(withScheme);
      if (!canonical) {
        unknown = true;
        continue;
      }
      requests.push({
        method,
        url: canonical.href,
        host: canonical.host,
        action,
      });
    }
  }

  return { requests, unknown };
}

/**
 * Extract the allowed hostnames for the sandbox egress proxy (`enforce: "sandbox"`)
 * from `network.allow`, excluding hosts denied by domain rules in `network.deny`.
 */
export function extractSandboxAllowedDomains(network: {
  allow?: readonly string[];
  deny?: readonly string[];
} | null | undefined): string[] {
  if (!network) return [];
  const rawAllow = network.allow ?? [];
  const denyRules = (network.deny ?? []).map(parseNetworkRule);
  const denyDomains = denyRules.filter((r): r is Extract<ParsedNetworkRule, { kind: "domain" }> => r.kind === "domain").map((r) => r.domain);

  const hosts = new Set<string>();
  for (const entry of rawAllow) {
    const parsed = parseNetworkRule(entry);
    if (parsed.kind === "domain") {
      if (!denyDomains.length || isDomainDenied(parsed.domain, denyDomains) === null) {
        hosts.add(parsed.domain);
      }
    } else if (parsed.kind === "url") {
      if (!denyDomains.length || isDomainDenied(parsed.hostPattern, denyDomains) === null) {
        hosts.add(parsed.hostPattern);
      }
    }
  }
  return [...hosts];
}

function doesClauseAllowCommand(
  clause: readonly string[],
  commandActions: readonly string[],
  domains: readonly string[],
  httpResult: { requests: ExtractedHttpRequest[]; unknown: boolean },
  unknownDomainTarget: boolean,
): boolean {
  if (clause.length === 0) return false;
  const parsed = clause.map(parseNetworkRule);
  const allowedActions = expandActions(
    parsed.filter((r): r is Extract<ParsedNetworkRule, { kind: "action" }> => r.kind === "action").map((r) => r.action),
  );
  const allowedDomains = parsed
    .filter((r): r is Extract<ParsedNetworkRule, { kind: "domain" }> => r.kind === "domain")
    .map((r) => r.domain);
  const allowedUrls = parsed.filter(
    (r): r is Extract<ParsedNetworkRule, { kind: "url" }> => r.kind === "url",
  );

  // Domain-only allowlist (e.g. `allow: ["api.github.com"]`): every network
  // target must have a known domain matching `allowedDomains`.
  if (allowedActions.size === 0 && allowedUrls.length === 0 && allowedDomains.length > 0) {
    if (unknownDomainTarget || domains.length === 0) return false;
    return domains.every((d) => isDomainDenied(d, allowedDomains) !== null);
  }

  for (const action of commandActions) {
    if (allowedActions.has(action)) continue;

    // Action is not broadly allowed by tag; check if it's an HTTP action whose
    // requests are all covered by URL patterns or domain patterns in this clause.
    if (action === "http:read" || action === "http:write") {
      const matchingActionReqs = httpResult.requests.filter((r) => r.action === action);
      if (httpResult.unknown || matchingActionReqs.length === 0) return false;
      const allReqsCovered = matchingActionReqs.every(
        (req) =>
          allowedUrls.some((u) => matchesUrlPattern(req, u)) ||
          (allowedDomains.length > 0 && isDomainDenied(req.host, allowedDomains) !== null),
      );
      if (allReqsCovered) continue;
    }

    return false;
  }

  // If the command extracted domains (e.g. curl/wget/git clone) and no actions matched
  if (commandActions.length === 0 && domains.length > 0) {
    if (allowedDomains.length === 0 && allowedUrls.length === 0) return false;
    return domains.every(
      (d) =>
        (allowedDomains.length > 0 && isDomainDenied(d, allowedDomains) !== null) ||
        httpResult.requests.some((req) => req.host === d && allowedUrls.some((u) => matchesUrlPattern(req, u))),
    );
  }

  return true;
}

/**
 * Evaluate a bash command against a unified `Bound["network"]` specification
 * (`allow`, `allowClauses`, `deny`).
 *
 * Returns an error message string when the command is blocked, or `null` when allowed.
 */
export function checkNetworkBound(
  command: string,
  network: {
    allow?: readonly string[];
    allowClauses?: readonly (readonly string[])[];
    deny?: readonly string[];
  } | null | undefined,
): string | null {
  if (!network) return null;

  const denyList = network.deny ?? [];
  const allowClauses: readonly (readonly string[])[] =
    network.allowClauses ?? (network.allow !== undefined ? [network.allow] : []);

  if (denyList.length === 0 && allowClauses.length === 0) return null;

  const classification = classifyBashCommand(command);
  if (classification.unparseable) {
    return "Access denied: network action '<unparseable-command>' is restricted in this session.";
  }

  const commandActions = classifyNetworkActions(classification, command);
  const domains = extractDomainsFromCommand(command);
  const httpResult = extractHttpRequestsFromCommand(command);
  const unknownDomain = hasUnknownDomainTarget(command);

  // Merge domains discovered from `gh api` (which resolves relative paths to api.github.com)
  const allDomains = [...new Set([...domains, ...httpResult.requests.map((r) => r.host)])];

  // 1. Evaluate `deny` rules
  if (denyList.length > 0) {
    const parsedDeny = denyList.map(parseNetworkRule);
    const denyActions = parsedDeny
      .filter((r): r is Extract<ParsedNetworkRule, { kind: "action" }> => r.kind === "action")
      .map((r) => r.action);
    const denyDomains = parsedDeny
      .filter((r): r is Extract<ParsedNetworkRule, { kind: "domain" }> => r.kind === "domain")
      .map((r) => r.domain);
    const denyUrls = parsedDeny.filter(
      (r): r is Extract<ParsedNetworkRule, { kind: "url" }> => r.kind === "url",
    );

    if (denyActions.length > 0) {
      const expandedDeny = expandActions(denyActions);
      for (const action of commandActions) {
        if (expandedDeny.has(action)) {
          return `Access denied: network action '${action}' is restricted in this session.`;
        }
      }
    }

    if (denyDomains.length > 0) {
      if (unknownDomain) {
        return "Access denied: cannot determine the network target under this domain bound.";
      }
      for (const domain of allDomains) {
        const match = isDomainDenied(domain, denyDomains);
        if (match) {
          return `Access denied: network requests to '${domain}' are restricted in this session (matches pattern '${match}').`;
        }
      }
    }

    if (denyUrls.length > 0) {
      if (httpResult.unknown && commandActions.some((a) => a === "http:read" || a === "http:write")) {
        return "Access denied: cannot determine the HTTP request target under this network URL bound.";
      }
      for (const req of httpResult.requests) {
        const matchedRule = denyUrls.find((u) => matchesUrlPattern(req, u));
        if (matchedRule) {
          return `Access denied: HTTP request '${req.method} ${req.url}' is restricted in this session (matches pattern '${matchedRule.raw}').`;
        }
      }
    }
  }

  // 2. Evaluate `allow` clauses (only applies when the command performs network activity)
  if (allowClauses.length > 0 && (commandActions.length > 0 || allDomains.length > 0)) {
    for (const clause of allowClauses) {
      if (!doesClauseAllowCommand(clause, commandActions, allDomains, httpResult, unknownDomain)) {
        const actionDesc = commandActions[0] ?? allDomains[0] ?? "network";
        return `Access denied: network operation '${actionDesc}' is not in this session's network.allow list.`;
      }
    }
  }

  return null;
}

