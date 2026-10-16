/**
 * Program-name classifier for Bash commands.
 *
 * Goal: decide whether a command line invokes a denied program (e.g. `git`,
 * `gh`) ANYWHERE — across `&&`/`||`/`;`/`|`/newlines, inside subshells `(...)`
 * and brace groups `{ ...; }`, inside command substitutions `$(...)`/backticks,
 * and through wrappers like `env`, `sudo`, `xargs`, `nice`, `sh -c "..."` — with
 * no false positives on lookalikes (`legit`, `echo "git push"`).
 *
 * Why not substring matching: every agent harness that shipped substring/regex
 * command matching (Gemini CLI, Cursor, Amp) was publicly bypassed or abandoned
 * it. `git push` as a substring misses `git -C /x push` and false-fires on
 * `legit`/commit messages. We resolve the actual program of each command instead.
 *
 * Why not a third-party bash parser: this sits in a security path and needs to
 * be auditable and dependency-free. We don't need a full AST — only to tokenize,
 * split on separators, and resolve argv[0] of each command. Anything we cannot
 * confidently tokenize (unbalanced quotes, unknown constructs) is DENIED, not
 * allowed — deny-on-unknown is the load-bearing rule, not parser completeness.
 *
 * Scope: this is a safety rail against a cooperative agent's natural mistakes,
 * not a hard boundary against an adversary determined to smuggle execution
 * (e.g. writing a script to disk then running it). Pair with credential/env
 * hardening for defense in depth.
 */

/** A single simple command: its argv plus whether tokenization was clean. */
interface SimpleCommand {
  argv: string[];
  /** True when a token contained an unresolved expansion (`$VAR`, `$(...)`, backtick). */
  hadDynamicArgv0: boolean;
}

/** Result of classifying one command line. */
export interface BashClassification {
  /** Program basenames invoked anywhere in the line (deduped, lowercased kept as-is). */
  programs: string[];
  /**
   * Subcommand chains per program, colon-joined: `git push origin` →
   * "git" -> ["push"]; `gh pr create` → "gh" -> ["pr:create"]. Used for
   * `program:sub` and `program:sub:subsub` deny rules.
   */
  subcommands: Map<string, string[]>;
  /** True if any part of the line could not be safely tokenized → caller must fail closed. */
  unparseable: boolean;
  /** Quote-removed effective argument vectors, including nested commands. */
  argvs: string[][];
}

/**
 * Wrapper programs whose trailing command is the "real" command to inspect.
 * The value is the count of leading POSITIONAL args the wrapper consumes before
 * the wrapped command begins (its own -flags are always skipped separately).
 * e.g. `timeout 30 git push` — timeout eats one positional (the duration).
 */
const PASSTHROUGH_WRAPPERS: Record<string, number> = {
  command: 0,
  exec: 0,
  builtin: 0,
  nohup: 0,
  nice: 0,
  ionice: 0,
  stdbuf: 0,
  time: 0,
  timeout: 1, // duration
  setsid: 0,
  sudo: 0,
  doas: 0,
  env: 0,
  xargs: 0,
  chroot: 1,
  caffeinate: 0,

  // Package runners. These execute an arbitrary program the same way `env` and
  // `sudo` do, so not unwrapping them left a hole: `uv run git push` and
  // `npx --yes git push` both sailed past a `git` denial that `sudo git push`
  // correctly caught.
  //
  // `uvx foo` / `npx foo` / `bunx foo` run their first positional directly, so
  // they eat none. `uv run foo` and `pnpm exec foo` spend one positional on the
  // subcommand itself. `npm`/`pnpm`/`yarn` are only wrappers in that
  // subcommand form. Ordinary installation or publishing keeps the package
  // manager itself visible to network classification.
  uvx: 0,
  npx: 0,
  bunx: 0,
  pnpx: 0,
  uv: 1, // `uv run <cmd>`
  npm: 1, // `npm exec <cmd>`
  pnpm: 1, // `pnpm exec <cmd>` / `pnpm dlx <cmd>`
  yarn: 1, // `yarn dlx <cmd>`
  bun: 1, // `bun run <cmd>`
};

/**
 * Global options that take a following value for specific programs. When
 * resolving the subcommand we must skip both the option AND its value, or the
 * value (e.g. the path in `git -C /repo push`) is mistaken for the subcommand.
 */
const VALUE_OPTIONS: Record<string, Set<string>> = {
  git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]),
};

const WRAPPER_VALUE_OPTIONS: Record<string, Set<string>> = {
  nice: new Set(["-n", "--adjustment"]), timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  sudo: new Set(["-u", "-g", "-C", "-h", "-p", "-r", "-t"]), doas: new Set(["-u", "-C"]),
  xargs: new Set(["-n", "-I", "-P", "-d", "-s", "--max-args", "--replace", "--max-procs", "--delimiter"]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]), exec: new Set(["-a"]),
  caffeinate: new Set(["-t", "-w"]), ionice: new Set(["-c", "-n", "-p"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  npm: new Set(["--prefix", "--workspace", "-w"]),
  pnpm: new Set(["--dir", "--directory", "-C", "--filter", "--workspace-dir"]),
  yarn: new Set(["--cwd"]), uv: new Set(["--directory", "--project"]),
  bun: new Set(["--cwd"]),
};

/** Shells whose `-c <string>` argument is itself a command line to re-parse. */
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * Tokenize a command line into words + structural separator tokens.
 * Separators are emitted as their own tokens: && || ; | & ( ) { } newline.
 * Quoted spans are collapsed into a single word token. Returns null when the
 * input cannot be tokenized safely (e.g. an unterminated quote) — caller denies.
 */
function tokenize(input: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  let cur = "";
  let curHasContent = false;

  const flush = () => {
    if (curHasContent) {
      tokens.push(cur);
      cur = "";
      curHasContent = false;
    }
  };

  while (i < input.length) {
    const ch = input[i];

    // Single-quoted: literal until the next single quote.
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) return null; // unterminated
      cur += input.slice(i + 1, end);
      curHasContent = true;
      i = end + 1;
      continue;
    }

    // Double-quoted: honor backslash escapes; expansions preserved verbatim.
    if (ch === '"') {
      let j = i + 1;
      let ok = false;
      while (j < input.length) {
        if (input[j] === "\\") {
          cur += input[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (input.slice(j, j + 2) === "$(") {
          const nested = readBalanced(input, j + 2, "(", ")");
          if (!nested) return null;
          tokens.push(SUBST_OPEN, ...(tokenize(nested.body) ?? [DENY_SENTINEL]), SUBST_CLOSE);
          cur += "$(...)";
          j = nested.end + 1;
          continue;
        }
        if (input[j] === "`") {
          const end = input.indexOf("`", j + 1);
          if (end === -1) return null;
          tokens.push(SUBST_OPEN, ...(tokenize(input.slice(j + 1, end)) ?? [DENY_SENTINEL]), SUBST_CLOSE);
          cur += "`...`";
          j = end + 1;
          continue;
        }
        if (input[j] === '"') {
          ok = true;
          break;
        }
        cur += input[j];
        j++;
      }
      if (!ok) return null; // unterminated
      curHasContent = true;
      i = j + 1;
      continue;
    }

    // Backslash escape outside quotes.
    if (ch === "\\") {
      if (i + 1 >= input.length) return null; // trailing backslash / line continuation ambiguity
      cur += input[i + 1];
      curHasContent = true;
      i += 2;
      continue;
    }

    // Whitespace separates words.
    if (ch === " " || ch === "\t") {
      flush();
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      flush();
      tokens.push("\n");
      i++;
      continue;
    }

    if ((ch === "<" || ch === ">") && input[i + 1] === "(") {
      const inner = readBalanced(input, i + 2, "(", ")");
      if (!inner) return null;
      flush();
      tokens.push(SUBST_OPEN, ...(tokenize(inner.body) ?? [DENY_SENTINEL]), SUBST_CLOSE);
      i = inner.end + 1;
      continue;
    }
    if (ch === "<" || ch === ">") {
      if (/^\d+$/.test(cur)) { cur = ""; curHasContent = false; }
      flush();
      const redirect = input.slice(i).match(/^(?:<<<|<<-|<<|>>|<>|>&|<&|>|<)/)![0];
      tokens.push(redirect);
      i += redirect.length;
      continue;
    }
    // A brace expansion belongs to its word; a whitespace-delimited brace is a group.
    if (ch === "{" && input[i + 1] && !/\s/.test(input[i + 1])) {
      const end = input.indexOf("}", i + 1);
      if (end !== -1) { cur += input.slice(i, end + 1); curHasContent = true; i = end + 1; continue; }
    }
    // Two-char operators.
    const two = input.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === ";;" || two === "|&" || two === ">>") {
      flush();
      tokens.push(two === ";;" ? ";" : two === ">>" ? ">" : two);
      i += 2;
      continue;
    }

    // Single-char structural operators.
    if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === "<" || ch === ">") {
      flush();
      tokens.push(ch);
      i++;
      continue;
    }

    // Command substitution `$(...)` and backticks: extract inner as a nested
    // command line by recording a marker token; keep the surrounding word too.
    // We surface the inner text via a sentinel so the parser recurses on it.
    if (two === "$(") {
      const inner = readBalanced(input, i + 2, "(", ")");
      if (inner === null) return null;
      flush();
      tokens.push(SUBST_OPEN, ...(tokenizeOrFail(inner.body) ?? [DENY_SENTINEL]), SUBST_CLOSE);
      i = inner.end + 1;
      continue;
    }
    if (ch === "`") {
      const end = input.indexOf("`", i + 1);
      if (end === -1) return null;
      const body = input.slice(i + 1, end);
      flush();
      tokens.push(SUBST_OPEN, ...(tokenizeOrFail(body) ?? [DENY_SENTINEL]), SUBST_CLOSE);
      i = end + 1;
      continue;
    }

    // Ordinary character.
    cur += ch;
    curHasContent = true;
    i++;
  }
  flush();
  return tokens;
}

const SUBST_OPEN = "\0SUBST_OPEN";
const SUBST_CLOSE = "\0SUBST_CLOSE";
/** Sentinel that forces a fail-closed deny (unparseable nested content). */
const DENY_SENTINEL = "\0DENY";

function tokenizeOrFail(input: string): string[] | null {
  return tokenize(input);
}

/** Read a balanced (...) span starting just after the opener. */
function readBalanced(
  input: string,
  start: number,
  open: string,
  close: string,
): { body: string; end: number } | null {
  let depth = 1;
  let i = start;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "'" ) {
      const e = input.indexOf("'", i + 1);
      if (e === -1) return null;
      i = e + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < input.length && input[j] !== '"') {
        if (input[j] === "\\") j++;
        j++;
      }
      if (j >= input.length) return null;
      i = j + 1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { body: input.slice(start, i), end: i };
    }
    i++;
  }
  return null;
}

/** Separator tokens that end one simple command. */
const COMMAND_KEYWORDS = new Set(["if", "then", "while", "until", "do", "else", "elif", "fi", "done", "!", "coproc", "function"]);
const COMMAND_SEPARATORS = new Set(["&&", "||", ";", "|", "|&", "&", "(", ")", "{", "}", "\n"]);

/**
 * Split a token stream into simple commands, unwrapping subshell/brace groups
 * and command-substitution spans (which are themselves command lines). Returns
 * null if a sentinel deny marker is present.
 */
function extractCommands(tokens: string[]): SimpleCommand[] | null {
  const commands: SimpleCommand[] = [];
  let argv: string[] = [];
  let hadDynamic = false;

  const flush = () => {
    if (argv.length > 0) {
      commands.push({ argv, hadDynamicArgv0: hadDynamic });
      argv = [];
      hadDynamic = false;
    }
  };

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (t === DENY_SENTINEL) return null;

    // Command substitution span: recurse on the inner tokens as their own line.
    if (t === SUBST_OPEN) {
      const depthEnd = matchSubst(tokens, i);
      if (depthEnd === -1) return null;
      const inner = tokens.slice(i + 1, depthEnd);
      const innerCmds = extractCommands(inner);
      if (innerCmds === null) return null;
      commands.push(...innerCmds);
      // A substitution can appear mid-word (as argv0 or an arg); treat the
      // current command's argv0 as dynamic since it embeds a substitution.
      hadDynamic = true;
      i = depthEnd + 1;
      continue;
    }

    if (COMMAND_SEPARATORS.has(t)) {
      flush();
      i++;
      continue;
    }

    // Skip redirections and their targets — not part of argv.
    if (/^(?:<<<|<<-|<<|>>|<>|>&|<&|>|<)$/.test(t)) {
      const target = tokens[i + 1];
      if (!target || COMMAND_SEPARATORS.has(target) || target.startsWith("&")) return null;
      i += 2;
      continue;
    }
    if (argv.length === 0 && COMMAND_KEYWORDS.has(t)) {
      i++; continue;
    }

    // Assignment prefix (FOO=bar) before a command: skip while it's still argv[0].
    if (argv.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }

    if (containsExpansion(t) && argv.length === 0) {
      hadDynamic = true;
    }
    argv.push(t);
    i++;
  }
  flush();
  return commands;
}

function matchSubst(tokens: string[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i] === SUBST_OPEN) depth++;
    else if (tokens[i] === SUBST_CLOSE) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** True if a token still contains a shell expansion we couldn't resolve. */
function containsExpansion(token: string): boolean {
  return token.includes("$") || token.includes("$(") || token.includes("`") || /[?*[\]{}]/.test(token);
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Resolve the effective program of a simple command, unwrapping wrappers.
 * Returns { program, subcommandChain, dynamic } — `dynamic` true means argv[0]
 * (or a wrapper's target) was an unresolved expansion → caller must fail closed.
 */
function resolveProgram(cmd: SimpleCommand): { program: string; subcommandChain?: string[]; dynamic: boolean; argv: string[] } | null {
  let argv = cmd.argv;
  const dynamic = cmd.hadDynamicArgv0;
  // Bound the unwrap loop so a pathological line can't spin.
  for (let guard = 0; guard < 16; guard++) {
    if (argv.length === 0) return null;
    const raw = argv[0];
    if (containsExpansion(raw)) return { program: raw, dynamic: true, argv };
    const prog = basename(raw).toLowerCase();

    const runnerSubcommands: Record<string, string[]> = {
      npm: ["exec"], pnpm: ["exec", "dlx"], yarn: ["exec", "dlx"], uv: ["run"], bun: ["run", "x"],
    };
    const runnerModes = runnerSubcommands[prog];
    let runnerCommand: string | undefined;
    for (let index = 1; runnerModes && index < argv.length; index++) {
      const arg = argv[index];
      if (arg.startsWith("-")) {
        if (WRAPPER_VALUE_OPTIONS[prog]?.has(arg)) index++;
        continue;
      }
      runnerCommand = arg;
      break;
    }
    const isWrapper = prog in PASSTHROUGH_WRAPPERS && (!runnerModes || runnerModes.includes(runnerCommand ?? ""));
    if (isWrapper) {
      // Drop the wrapper, its own -flags, any VAR=val it carries (env/sudo), and
      // the fixed number of positional args it consumes (e.g. timeout's
      // duration). Then inspect the remainder as the real command.
      let positionalsToEat = PASSTHROUGH_WRAPPERS[prog];
      let k = 1;
      while (k < argv.length) {
        const a = argv[k];
        if (prog === "env" && (a === "-S" || a === "--split-string" || a.startsWith("--split-string=") || a.startsWith("-S") && a.length > 2)) {
          const text = a === "-S" || a === "--split-string" ? argv[++k] : a.startsWith("--split-string=") ? a.slice(15) : a.slice(2);
          const split = text === undefined ? null : tokenize(text);
          if (!split || split.some(token => COMMAND_SEPARATORS.has(token))) return { program: prog, dynamic: true, argv };
          argv = [prog, ...split, ...argv.slice(k + 1)];
          k = 0; break;
        }
        if (a === "--") { k++; break; }
        if (a.startsWith("-")) {
          if (WRAPPER_VALUE_OPTIONS[prog]?.has(a)) k++;
          k++;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
          k++;
          continue;
        }
        if (positionalsToEat > 0) {
          positionalsToEat--;
          k++;
          continue;
        }
        break;
      }
      const rest = argv.slice(k);
      if (rest.length === 0) return { program: prog, dynamic, argv }; // wrapper alone
      argv = rest;
      continue;
    }

    if (SHELL_PROGRAMS.has(prog)) {
      // sh/bash/zsh -c "<cmdline>" — the -c argument is a nested command line,
      // re-parsed by classifyBashCommand(). We still report the shell program.
      return { program: prog, dynamic, argv };
    }

    // Collect the subcommand CHAIN: the leading non-flag args (up to 2 levels),
    // skipping value-taking global options and their values (e.g.
    // `git -C /repo push` → ["push"], `gh pr create` → ["pr","create"]).
    const valueOpts = VALUE_OPTIONS[prog];
    const chain: string[] = [];
    for (let k = 1; k < argv.length && chain.length < 2; k++) {
      const a = argv[k];
      if (a.startsWith("-")) {
        // `-C /path` (separate value) — skip the value too. `-c name=val` and
        // `--git-dir=/x` (attached value) consume nothing extra.
        if (valueOpts?.has(a) && !a.includes("=")) k++;
        continue;
      }
      chain.push(a.toLowerCase());
    }

    // `gh api` is a GET by default but mutates with -X/--method POST/PATCH/PUT/
    // DELETE. Append a synthetic "write" level so a `gh:api:write` rule catches
    // mutating calls while read-only `gh api <path>` stays allowed.
    if (prog === "gh" && chain[0] === "api" && ghApiIsMutating(argv)) {
      chain[1] = "write";
    }

    return { program: prog, subcommandChain: chain, dynamic, argv };
  }
  return { program: basename(argv[0]).toLowerCase(), dynamic: true, argv };
}

/** True if a `gh api` invocation uses a mutating HTTP method via -X/--method. */
function ghApiIsMutating(argv: string[]): boolean {
  const mutating = new Set(["POST", "PATCH", "PUT", "DELETE"]);
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k];
    // `-X POST` / `--method POST` (separate value)
    if ((a === "-X" || a === "--method") && argv[k + 1]) {
      if (mutating.has(argv[k + 1].toUpperCase())) return true;
      k++;
      continue;
    }
    // `-XPOST` / `--method=POST` (attached value)
    const m = a.match(/^(?:-X|--method=?)([A-Za-z]+)$/);
    if (m && mutating.has(m[1].toUpperCase())) return true;
    // gh infers POST when a field (-f/--field/-F/--raw-field) is present.
    if (a === "-f" || a === "--field" || a === "-F" || a === "--raw-field") return true;
  }
  return false;
}

/**
 * Classify a command line: which programs it invokes, plus a fail-closed flag.
 */
export function classifyBashCommand(command: string): BashClassification {
  const programs = new Set<string>();
  const subcommands = new Map<string, string[]>();
  let unparseable = false;
  const argvs: string[][] = [];

  const addSub = (prog: string, chain?: string[]) => {
    if (!chain || chain.length === 0) return;
    // Record every prefix so a `program:sub` rule matches `program sub subsub`
    // and a `program:sub:subsub` rule matches the full path.
    const list = subcommands.get(prog) ?? [];
    for (let n = 1; n <= chain.length; n++) {
      const joined = chain.slice(0, n).join(":");
      if (!list.includes(joined)) list.push(joined);
    }
    subcommands.set(prog, list);
  };

  const analyze = (line: string, depth: number) => {
    if (depth > 8) {
      unparseable = true;
      return;
    }
    const tokens = tokenize(line);
    if (tokens === null) {
      unparseable = true;
      return;
    }
    const cmds = extractCommands(tokens);
    if (cmds === null) {
      unparseable = true;
      return;
    }
    for (const cmd of cmds) {
      const resolved = resolveProgram(cmd);
      if (!resolved) continue;
      if (resolved.dynamic) {
        unparseable = true;
        // still record what we can
      }
      argvs.push(resolved.argv);
      programs.add(resolved.program);
      addSub(resolved.program, resolved.subcommandChain);

      if (["eval", "source", "."].includes(resolved.program)) unparseable = true;

      // Recurse into sh/bash/zsh -c "<cmdline>".
      if (SHELL_PROGRAMS.has(resolved.program)) {
        const cIdx = resolved.argv.findIndex((a, i) => i > 0 && (a === "--command" || /^-[^-]*c/.test(a)));
        const inner = cIdx !== -1 ? resolved.argv[cIdx + 1] : undefined;
        if (inner !== undefined) analyze(inner, depth + 1);
        else unparseable = true;
      }
    }
  };

  analyze(command, 0);
  return { programs: [...programs], subcommands, unparseable, argvs };
}

/**
 * Decide whether a command is denied by program/subcommand rules.
 *
 * Rules:
 *   - `"git"` — deny any invocation of git.
 *   - `"git:push"` — deny only `git push …`.
 *   - `"gh:pr:create"` — deny only `gh pr create …` (multi-level subcommand).
 *
 * Matching is on resolved program basenames + subcommand chains, so `git -C /x
 * push`, `FOO=1 git push`, `cd a && git push`, `(git push)`, `git push | tee`,
 * `xargs git push`, `/usr/bin/git push`, and `bash -c "git push"` all match,
 * while `gh pr view` is allowed under a `gh:pr:create` rule.
 *
 * Fails closed: if the line couldn't be safely tokenized AND any deny rule
 * exists, returns a deny (so obfuscation can't slip a denied program through).
 *
 * @returns the matched rule string, or null if allowed.
 */
export function isProgramDenied(command: string, programRules: string[]): string | null {
  if (!programRules || programRules.length === 0) return null;

  const denyAll = new Set<string>(); // "git"
  const denySub = new Map<string, Set<string>>(); // "gh" -> {"pr:create"}
  for (const rule of programRules) {
    const idx = rule.indexOf(":");
    if (idx === -1) {
      denyAll.add(rule);
    } else {
      const prog = rule.slice(0, idx);
      const subPath = rule.slice(idx + 1); // may itself contain ":" for deeper paths
      const s = denySub.get(prog) ?? new Set<string>();
      s.add(subPath);
      denySub.set(prog, s);
    }
  }

  const { programs, subcommands, unparseable } = classifyBashCommand(command);

  for (const prog of programs) {
    if (denyAll.has(prog)) return prog;
    const subs = denySub.get(prog);
    if (subs) {
      const builtins: Record<string, Set<string>> = {
        git: new Set("add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout--worker checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects credential credential-cache credential-cache--daemon credential-store describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects fsmonitor--daemon gc get-tar-commit-id grep hash-object help hook index-pack init init-db interpret-trailers last-modified log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-ours merge-recursive merge-recursive-ours merge-recursive-theirs merge-subtree merge-tree mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id pickaxe prune prune-packed pull push range-diff read-tree rebase receive-pack reflog refs remote remote-ext remote-fd repack replace replay repo rerere reset restore rev-list rev-parse revert rm send-pack shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule--helper switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive upload-archive--writer upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree".split(" ")),
        gh: new Set("alias api auth browse cache codespace completion config extension gist gpg-key help issue label org pr project release repo ruleset run search secret ssh-key status variable workflow".split(" ")),
      };
      const heads = (subcommands.get(prog) ?? []).filter(head => !head.includes(":"));
      if (builtins[prog] && heads.some(head => !builtins[prog].has(head))) return `${prog}:<unknown-subcommand>`;
      // subcommands.get(prog) holds every chain prefix (e.g. ["pr","pr:create"]),
      // so an exact set membership check matches both `gh:pr` and `gh:pr:create`.
      for (const s of subcommands.get(prog) ?? []) {
        if (subs.has(s)) return `${prog}:${s}`;
      }
    }
  }

  // Deny-on-unknown: if we couldn't fully parse and any relevant program could
  // be hiding, refuse rather than let obfuscation through.
  if (unparseable) {
    return "<unparseable-command>";
  }

  return null;
}

function bashGlobMatch(text: string, pattern: string): boolean {
  if (!pattern.includes("*")) return text === pattern || text.startsWith(`${pattern} `);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(text);
}

function extractSubcommandPrefixes(prog: string, argv: string[]): string[] {
  const valueOpts = VALUE_OPTIONS[prog];
  const chain: string[] = [];
  for (let k = 1; k < argv.length && chain.length < 2; k++) {
    const a = argv[k];
    if (a.startsWith("-")) {
      if (valueOpts?.has(a) && !a.includes("=")) k++;
      continue;
    }
    chain.push(a.toLowerCase());
  }
  if (prog === "gh" && chain[0] === "api" && ghApiIsMutating(argv)) {
    chain[1] = "write";
  }
  const prefixes: string[] = [];
  for (let n = 1; n <= chain.length; n++) {
    prefixes.push(chain.slice(0, n).join(":"));
  }
  return prefixes;
}

function matchesBashAllowPattern(argv: string[], pattern: string): boolean {
  if (argv.length === 0) return false;
  const prog = basename(argv[0]).toLowerCase();
  const cmdStr = [prog, ...argv.slice(1)].join(" ");
  if (pattern === "*") return true;
  if (pattern.includes(":") && !pattern.includes(" ")) {
    const colon = pattern.indexOf(":");
    const wantProg = pattern.slice(0, colon).toLowerCase();
    const wantSub = pattern.slice(colon + 1).toLowerCase();
    if (prog !== wantProg) return false;
    if (wantSub === "*") return true;
    const subPrefixes = extractSubcommandPrefixes(prog, argv);
    if (wantSub.includes("*")) {
      return subPrefixes.some((sub) => bashGlobMatch(sub, wantSub));
    }
    return subPrefixes.includes(wantSub);
  }
  if (!pattern.includes(" ") && !pattern.includes("*")) {
    return prog === pattern.toLowerCase();
  }
  return bashGlobMatch(cmdStr, pattern);
}

/**
 * Evaluate a command line against `bound.bash` (`{ allow, deny, allowClauses }`).
 * Returns a denial reason string if blocked, or `null` if permitted.
 */
export function checkBashBound(
  command: string,
  bash?: { allow?: string[]; deny?: string[]; allowClauses?: string[][] },
): string | null {
  if (!bash) return null;

  const denyRules = bash.deny ?? [];
  if (denyRules.length > 0) {
    const programRules: string[] = [];
    const patternRules: string[] = [];
    for (const rule of denyRules) {
      if (!rule.includes(" ") && !rule.includes("*")) {
        programRules.push(rule);
      } else if (/^[a-z0-9._-]+(?:\s+[a-z0-9._-]+)*\s+\*$/i.test(rule)) {
        const parts = rule.replace(/\s+\*$/, "").trim().split(/\s+/);
        programRules.push(parts.join(":"));
      } else {
        patternRules.push(rule);
      }
    }

    if (programRules.length > 0) {
      const deniedProg = isProgramDenied(command, programRules);
      if (deniedProg) return deniedProg;
    }

    if (patternRules.length > 0) {
      const { argvs, unparseable } = classifyBashCommand(command);
      for (const pattern of patternRules) {
        if (pattern.includes("*")) {
          const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
          const re = new RegExp(`^${escaped}$`);
          if (re.test(command)) return pattern;
          for (const argv of argvs) {
            const cmdStr = [basename(argv[0]).toLowerCase(), ...argv.slice(1)].join(" ");
            if (re.test(cmdStr)) return pattern;
          }
        } else {
          if (command.includes(pattern)) return pattern;
          for (const argv of argvs) {
            const cmdStr = [basename(argv[0]).toLowerCase(), ...argv.slice(1)].join(" ");
            if (cmdStr.includes(pattern)) return pattern;
          }
        }
      }
      if (unparseable) return "<unparseable-command>";
    }
  }

  const clauses = bash.allowClauses?.length
    ? bash.allowClauses
    : bash.allow !== undefined
      ? [bash.allow]
      : undefined;

  if (clauses !== undefined) {
    if (clauses.some((c) => c.length === 0)) return "<empty-bash-allow>";
    const { argvs, unparseable } = classifyBashCommand(command);
    if (unparseable) return "<unparseable-command>";
    if (argvs.length === 0) return null;
    for (const argv of argvs) {
      for (const clause of clauses) {
        if (!clause.some((pattern) => matchesBashAllowPattern(argv, pattern))) {
          return basename(argv[0]).toLowerCase();
        }
      }
    }
  }

  return null;
}


