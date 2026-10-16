/**
 * Execute a `run:` action: spawn its process, bound it, record what happened.
 *
 * The contract a script sees is the one `hooks.barry` scripts already have —
 * JSON on stdin, verdict by exit code — so a bag author learns one shape:
 *
 * - inputs arrive as JSON on stdin, and again in BARRY_ACTION_INPUTS for
 *   scripts that would rather not read stdin;
 * - BARRY_ACTION_RUN_ID and BARRY_ACTION_DIR say which run and where;
 * - exit 0 is complete, anything else (or a timeout) is failed;
 * - with an output_schema, stdout must be JSON matching it; without one, the
 *   tail of stdout is kept as text output so a run is never recorded blind.
 *
 * Every failure after the run row exists is RECORDED on the row, never only
 * thrown: this is what schedules call unattended, and a failure that lives
 * only in an exception is one no reader will ever see.
 */

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveActionRun, runActionValidation, validateActionInputs, type ScriptAction } from "@barry-rocks/sdk/internal/actions";
import { bagLogsDir, bagDataDir, bagSegment, hostEnvironment } from "@barry-rocks/sdk/services";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { identityEnvironmentForId } from "@barry-rocks/sdk/internal/env";
import { boundHasProcessRestrictions } from "@barry-rocks/sdk/bounds";
import { currentStoreContext } from "@barry-rocks/sdk/internal/stores";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";


import { getDbPath } from "./db.js";

import { ActionRuns, MAX_OUTPUT_CHARS, type ActionRunRecord, type ActionRunTrigger } from "./action-runs.js";
import { resolveOutput } from "./output.js";

/** Ten minutes: long enough for a backup, short enough that a hang is noticed. */
export const DEFAULT_SCRIPT_TIMEOUT_SECONDS = 600;

/** Grace between SIGTERM and SIGKILL, so a script can flush what it was writing. */
const KILL_GRACE_MS = 5_000;

/** Text output kept when no output_schema is declared: the tail, where results and errors land. */
const TEXT_OUTPUT_TAIL_CHARS = 4_096;

/** Logs kept per action; older ones are removed as new runs are written. */
const LOGS_KEPT_PER_ACTION = 100;

export interface RunScriptOptions {
  /** Credential ownership is supplied by the trusted launcher. */
  secretScope?: { kind: "identity"; id: number } | { kind: "identity"; uuid: string } | { kind: "installation" } | { kind: "none" };
  inputs?: Record<string, unknown>;
  trigger: ActionRunTrigger;
  sessionId?: string | null;
  scheduleId?: string | null;
  /** Root for per-run logs. Defaults to ~/.barry/logs/actions. */
  logRoot?: string;
  /** Aborting kills the process and records the run failed. */
  signal?: AbortSignal;
  /** Only host essentials and instance paths are retained from this source. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Extra run metadata — the scheduler records its pid, to find runs it orphaned. */
  metadata?: Record<string, unknown>;
  /** Variables set on top of everything else — e.g. BARRY_SCHEDULE_ID for a one-off. */
  extraEnv?: Record<string, string>;
  /**
   * Called with the run and the process-group id once the process is started.
   * A runner that must find the process again after a crash records these.
   */
  onStart?: (info: { runId: string; processGroup: number }) => void;
}

export interface ScriptRunResult {
  run: ActionRunRecord;
  timedOut: boolean;
}

function defaultLogRoot(): string {
  // Through the BARRY_HOME resolver, not $HOME: a test pins BARRY_HOME, and
  // logs written under the real home are how a suite once littered it.
  return join(bagLogsDir("actions"), "runs");
}

/** Keep the newest LOGS_KEPT_PER_ACTION logs in one action's log dir. */
function pruneLogs(dir: string): void {
  try {
    const logs = readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of logs.slice(LOGS_KEPT_PER_ACTION)) {
      // rm, not trash: these are Barry's own rotating logs, not user files.
      rmSync(old.path, { force: true });
    }
  } catch {
    // Pruning is housekeeping; a failure must never fail the run it follows.
  }
}

/** Decide what a finished process's stdout records as output, or why it cannot. */
function outputFor(
  action: ScriptAction,
  stdout: string,
): { output: { type: "json" | "text"; value: string } | null } | { error: string } {
  const trimmed = stdout.trim();
  if (action.outputSchema) {
    if (!trimmed) return { error: "declares an output_schema but printed nothing to stdout" };
    if (trimmed.length > MAX_OUTPUT_CHARS) {
      return { error: `stdout is ${trimmed.length} chars, over the ${MAX_OUTPUT_CHARS} output cap` };
    }
    try {
      return { output: resolveOutput(action.outputSchema, trimmed) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!trimmed) return { output: null };
  return { output: { type: "text", value: trimmed.slice(-TEXT_OUTPUT_TAIL_CHARS) } };
}

/**
 * Run a `run:` action to completion and return its closed run row.
 *
 * Throws only BEFORE the row exists (bad inputs), for the same reason
 * begin_action does: a run that never started must not be found as one.
 */
export async function runScriptAction(action: ScriptAction, options: RunScriptOptions): Promise<ScriptRunResult> {
  const inputErrors = validateActionInputs(action, options.inputs);
  if (inputErrors.length) throw new Error(inputErrors.join(" "));

  const inputs = options.inputs ?? {};
  const run = await ActionRuns.create({
    action: action.qualifiedName,
    bag: action.bag,
    session_id: options.sessionId ?? null,
    trigger: options.trigger,
    schedule_id: options.scheduleId ?? null,
    metadata: {
      ...options.metadata,
      ...(options.secretScope?.kind === "identity"
        ? "id" in options.secretScope ? { identity_id: options.secretScope.id } : { identity: options.secretScope.uuid }
        : {}),
      run: action.run,
      ...(Object.keys(inputs).length ? { inputs } : {}),
      ...(action.outputSchema ? { output_schema: action.outputSchema } : {}),
    },
  });

  const started = Date.now();
  const fail = async (summary: string, extra: { exit_code?: number | null; log_path?: string | null } = {}) => ({
    run: (await ActionRuns.finishExecuted(run.id, {
      status: "failed",
      summary,
      process: { exit_code: extra.exit_code ?? null, duration_ms: Date.now() - started, log_path: extra.log_path ?? null },
    })) ?? run,
    timedOut: false,
  });

  const execution = currentStoreContext()?.execution;
  if ((options.trigger === "session" && !execution)
    || (execution && (boundHasProcessRestrictions(execution.bound ?? undefined) || !execution.allowedToolIds.includes("bash:Bash")))) {
    return fail("Did not start: raw script execution requires an unbounded Bash grant from the caller's execution policy");
  }

  let invocation;
  try {
    invocation = resolveActionRun(action.dir, action.run);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const declared = { env: Object.fromEntries((action.env ?? []).map(entry => [entry.name, entry.value])) };
  if (action.secrets?.length) {
    try {
      let scope = options.secretScope;
      if (!scope) {
        const identity = currentStoreContext()?.identity;
        if (!identity) throw new Error("no selected secret owner");
        scope = { kind: "identity", uuid: identity };
      }
      if (scope.kind === "none") throw new Error("no selected secret owner");
      const names = [...new Set(action.secrets)];
      const vars = scope.kind === "installation"
        ? await installationSecrets(names)
        : (await identityEnvironmentForId("id" in scope ? scope.id : installationRegistry().legacyIdentityId(scope.uuid), { names })).vars;
      for (const name of names) {
        if (!vars[name]) throw new Error("selected secret unavailable");
        declared.env[name] = vars[name];
      }
    } catch {
      return fail(`Did not start: declared action secrets are unavailable from the selected owner (${action.secrets.join(", ")})`);
    }
  }


  // One segment per bag, so an extension's logs sit beside its parent's rather than inside them.
  const logDir = join(options.logRoot ?? defaultLogRoot(), bagSegment(action.bag), action.name);
  const logPath = join(logDir, `${run.id}.log`);
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(logPath, { flags: "a" });

  const timeoutSeconds = action.timeout ?? DEFAULT_SCRIPT_TIMEOUT_SECONDS;
  const serializedInputs = JSON.stringify(inputs);

  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; spawnError?: string; timedOut: boolean; aborted: boolean }>((resolve) => {
    let stdout = "";
    // Stream callbacks can arrive out of order; retain stderr for failure summaries.
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: {
        ...hostEnvironment(options.baseEnv ?? process.env),
        ...options.extraEnv,
        ...declared.env,
        BARRY_ACTIONS_DB: getDbPath(),
        BARRY_ACTION_RUN_ID: run.id,
        BARRY_ACTION_DIR: action.dir,
        // Where the action's bag keeps its stores, for scripts that cannot call bagDataDir.
        BARRY_BAG_DATA_DIR: bagDataDir(action.bag),
        BARRY_ACTION_INPUTS: serializedInputs,
      },
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so a timeout kills what the script started too
      // — a `bash` wrapper killed alone leaves its children running.
      detached: true,
    });

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };
    const terminate = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutSeconds * 1000);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: { code: number | null; signal: NodeJS.Signals | null; spawnError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, stdout, stderr, timedOut, aborted });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      log.write(chunk);
      // Bounded: enough to hold the largest acceptable output plus one char,
      // so an oversize output is detected rather than silently cut to fit.
      stdout = (stdout + chunk.toString("utf8")).slice(-(MAX_OUTPUT_CHARS + 1));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      log.write(chunk);
      stderr = (stderr + chunk.toString("utf8")).slice(-TEXT_OUTPUT_TAIL_CHARS);
    });
    child.on("error", (error) => finish({ code: null, signal: null, spawnError: error.message }));
    // detached: the child leads its own group, so its pid is the group id.
    if (child.pid) options.onStart?.({ runId: run.id, processGroup: child.pid });
    child.on("close", (code, signal) => finish({ code, signal }));

    // A script that never reads stdin closes the pipe; that is not an error.
    child.stdin.on("error", () => {});
    child.stdin.end(serializedInputs);
  });

  await new Promise<void>((resolve) => log.end(resolve));
  pruneLogs(logDir);

  const processRecord = { exit_code: outcome.code, duration_ms: Date.now() - started, log_path: logPath };
  const closeFailed = async (summary: string) => ({
    run: (await ActionRuns.finishExecuted(run.id, { status: "failed", summary, process: processRecord })) ?? run,
    timedOut: outcome.timedOut,
  });

  if (outcome.spawnError) return closeFailed(`Could not start ${invocation.command}: ${outcome.spawnError}`);
  if (outcome.timedOut) return closeFailed(`Timed out after ${timeoutSeconds}s and was killed`);
  if (outcome.aborted) return closeFailed("Stopped before it finished");
  if (outcome.code !== 0) {
    const how = outcome.code === null ? `killed by ${outcome.signal ?? "a signal"}` : `exited ${outcome.code}`;
    const lastLine = (outcome.stderr.trim() || outcome.stdout.trim()).split("\n").pop();
    return closeFailed(`${how}${lastLine ? ` — ${lastLine.slice(0, 300)}` : ""} (log: ${logPath})`);
  }

  const produced = outputFor(action, outcome.stdout);
  if ("error" in produced) return closeFailed(`Exited 0 but ${produced.error}`);

  const validation = await runActionValidation(action.validate, action.dir);
  const summary = validation.failures.length
    ? `Exited 0; validation failed: ${validation.failures.join("; ")}`
    : "Exited 0";
  const closed = await ActionRuns.finishExecuted(run.id, {
    status: "complete",
    summary,
    process: processRecord,
    validation: validation.skipped ? null : { failures: validation.failures },
    output: produced.output,
  });
  return { run: closed ?? run, timedOut: false };
}
