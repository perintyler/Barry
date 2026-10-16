// Detached action executor — executeDetached and stopDetachedRun.
// Extracted verbatim from actions.ts for file size; no behavior change.
// Imports mirror the original module; the Router wiring stays in actions.ts.
import {adapterSettings, defaultHarness, FALLBACK_HARNESS} from "@barry-rocks/sdk/internal/identities";
import {identityRecords, type IdentityRecord} from "@barry-rocks/identities-bag";
import {Barry, isBarryError, requestCaller} from "@barry-rocks/sdk";
import {qualifyToolId, type Bound} from "@barry-rocks/sdk/bounds";
import {actionsRoutes} from "@barry-rocks/sdk/internal/routes";
import type { AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import {createLogger} from "@barry-rocks/sdk/logging";
import {readProcessStartTime} from "@barry-rocks/sessions-bag/process-liveness";
import {randomUUID} from "node:crypto";
import {existsSync, statSync} from "node:fs";
import {hostname} from "node:os";
import {isAbsolute} from "node:path";
import {z} from "zod";
import {getDescribeAdapter, getRunStructured, modelRefFor, providerFieldId} from "../agent-runtime.js";
// Action-run persistence belongs to the actions bag.
// See docs/decisions/0035-session-route-and-summary-rationale.md.
import {ActionRuns, MAX_OUTPUT_CHARS, composeActionPrompt, describeActionInvocation, describeActionSource, runScriptAction} from "@barry-rocks/actions-bag";
import type { ActionMeta, RunnableAction } from "@barry-rocks/sdk/internal/actions";
import {isScriptAction, validateActionInputs, MAX_ADHOC_TIMEOUT_S, runActionPreflight, runActionValidation, resolveRunAgent} from "@barry-rocks/sdk/internal/actions";

import {installedModels, routedVendorOf} from "@barry-rocks/sdk/adapters/models";
import {requiredCredentials} from "@barry-rocks/sdk/internal/env";
import {findInstruction} from "@barry-rocks/sdk/internal/instructions";
import {refuseDeniedTools} from "@barry-rocks/sdk/sessions";
import {Processes, Sessions} from "@barry-rocks/sessions-bag/client";
import {IdentityEnvironmentError, resolveEnvForBarry, type IdentityEnv} from "../identity-env.js";
import {TERMINAL_JOB_STATUSES, acceptJobRun, awaitJobRun, serializeJobRun} from "../job-runs.js";
import {buildMcpConfig} from "../mcp-config.js";
import {detachedRunSlots} from "../run-slots.js";
import {canDenyNativeTools, resolveEgressSandbox, resolveSessionNativeTools} from "../session-agent-guards.js";
import {callerScriptBound, permitsRawProcess, resolveCallerBounds, type CallerBounds, type CallerScriptBound} from "./caller-bounds.js";
import {ADHOC_RUN_MAX_TURNS, BAG_RUN_MAX_TURNS, DEFAULT_TIMEOUT_S, ExecutorCancelled, ExecutorTimeout, MAX_DECLARED_TIMEOUT_S, MAX_REPORT_SUMMARY_CHARS, MAX_TIMEOUT_S, REPORT_SCHEMA, WAIT_ELAPSED, agentFailureReason, hardCeilingS, runningAgents, waitElapsed, wrapSchemaRoot} from "./actions-executor-support.js";

const log = createLogger("barry-server");

export type DetachedRunRequest = z.infer<typeof actionsRoutes.runAction.body> & {
  /** Who started it, when not a caller of this route. */
  trigger?: "api" | "schedule" | "cli" | "job";
  /** Internal, resolved by the schedule owner rather than supplied by HTTP clients. */
  executionContext?: {
    identity?: string;
    bags?: string[];
    bound: Bound | null;
    allowedToolIds: string[];
    harness?: string;
  };
};

/** A detached run's HTTP answer, so the route and the schedules route answer alike. */
export interface DetachedRunResult {
  status: number;
  body: Record<string, unknown>;
}

const reply = (status: number, body: Record<string, unknown>): DetachedRunResult => ({ status, body });


/**
 * Whom a detached run acts for, which decides what it may reach.
 *
 * A run a session starts acts for that session, whoever wrote the action: a
 * subagent must never reach what its caller cannot. Only a run with no
 * calling session (a schedule, the CLI, the Actions app) acts for the
 * action's bag, and only an installed action can run that way; an ad-hoc one
 * has no owner to act for without its session.
 */
type RunAuthority =
  | { actsFor: "caller"; action: RunnableAction; caller: CallerBounds }
  | { actsFor: "bag"; action: ActionMeta };

/** What a detached run may reach and where it starts, settled before anything is created. */
interface RunBounds {
  /** The session-row columns the engine resolves the run's tools and bounds from. */
  identityId: number | undefined;
  bags: string[];
  bound: Bound | Record<string, unknown> | null;
  bounds: string[];
  cwd: string;
  maxTurns: number;
  /** The most a run may take when the caller names no bound. */
  timeoutCeilingS: number;
  /** Present when a session started the run: the restrictions that session's own agent runs under. */
  caller?: { agent: string; allowedNativeTools: string[]; deniedTools: string[]; sessionId: string; narrowed: boolean };
}

/** Stop a detached agent run this API is running. False when none is. */
export async function stopDetachedRun(runId: string, reason: string): Promise<boolean> {
  const stop = runningAgents.get(runId);
  if (!stop) return false;
  stop(reason);
  await ActionRuns.cancel(runId, reason);
  return true;
}

/**
 * Run an action detached — a script in a child process, an agent in a
 * synthetic session acting for a barry — and return the closed run as an HTTP
 * answer.
 *
 * Extracted from the route so a schedule firing an action runs through
 * exactly the same path (context check, inputs, identity, concurrency cap,
 * timeout, validation) as a caller of POST /actions/:name/run.
 */
export async function executeDetached(
  action: RunnableAction,
  body: DetachedRunRequest,
  registeredBags: Parameters<typeof findInstruction>[0],
  principal?: AuthPrincipal,
): Promise<DetachedRunResult> {
    if (principal?.kind === "device") return reply(403, { error: "device_dispatch_unavailable", message: "Device action execution requires its execution authorization policy." });
    // Both refusals share one error code: either way the action is not
    // detachable — one needs the calling conversation, the other would run
    // with nothing to hand back.
    if (action.context !== "none") {
      return reply(409, {
        error: "context_session",
        message:
          `Action "${action.qualifiedName}" declares context: session — it needs ` +
          `the calling conversation and cannot run detached. Use begin_action instead.`,
      });
    }
    const inputErrors = validateActionInputs(action, body.inputs);
    if (inputErrors.length) {
      return reply(422, { error: "invalid_inputs", details: inputErrors });
    }

    // Settled first, because it decides whose barry the run acts for. See
    // RunAuthority for the rule.
    if (action.source === "bag" && body.cwd) {
      return reply(400, {
        error: "adhoc_only",
        message: "`cwd` applies only to ad-hoc actions; an installed action runs in its own directory.",
      });
    }
    let authority: RunAuthority;
    if (body.caller_session_id) {
      const checked = await resolveCallerBounds(body.caller_session_id, body, principal);
      if ("status" in checked) return checked;
      // Resolution already scoped an ad-hoc lookup to the caller. Checked
      // again because this function has callers other than that route.
      if (action.source === "adhoc" && action.ownerSessionId !== checked.session.id) {
        return reply(404, { error: "unknown_action" });
      }
      authority = { actsFor: "caller", action, caller: checked };
    } else if (action.source === "adhoc") {
      return reply(400, {
        error: "no_caller_session",
        message: "An ad-hoc action runs with the access of the session that asks for it, and this request names none.",
      });
    } else if (
      (body.bags || body.bounds) &&
      !body.executionContext &&
      body.trigger !== "schedule" &&
      body.trigger !== "job" &&
      !body.schedule_id
    ) {
      return reply(400, {
        error: "no_caller_session",
        message: "`bags` and `bounds` narrow a calling session's access, and this request names no calling session.",
      });
    } else {
      authority = { actsFor: "bag", action };
    }
    // A `job:` action is one of a bag's jobs: run it as a job run, acting for
    // the caller when there is one, and answer with the closed run as a
    // script action does. The job run is durable and at least once; this
    // waits for it the way the executor waits for its own runs.
    if (action.job !== undefined) {
      const ref = action.job.includes(":") ? action.job : `${action.bag}:${action.job}`;
      const accepted = await acceptJobRun({
        ref,
        ...(body.inputs ? { inputs: body.inputs } : {}),
        ...(body.timeout_s ? { timeoutS: body.timeout_s } : {}),
        ...(authority.actsFor === "caller" ? { callerSessionId: authority.caller.session.id } : {}),
      });
      if ("refused" in accepted) {
        const refused = accepted.refused;
        return "body" in refused ? reply(refused.status, refused.body) : reply(refused.status, { error: "job_refused", message: `${refused.title}: ${refused.detail}` });
      }
      const timeoutS = body.timeout_s ?? accepted.oneOff.timeoutS;
      const done = await awaitJobRun(accepted.oneOff.id, body.wait_s ?? hardCeilingS(timeoutS));
      const run = await serializeJobRun(done ?? accepted.oneOff);
      const finished = TERMINAL_JOB_STATUSES.has(run.status);
      return reply(finished ? 200 : 202, {
        run_id: run.runId,
        job_run_id: run.id,
        status: !finished ? "started" : run.status === "succeeded" ? "complete" : "failed",
        summary: run.reason,
        output: run.output,
        output_type: run.outputType,
      });
    }

    // A script action needs no agent, session or model: run its process and
    // report the closed run. Not counted against the run limits, which
    // bounds agent spawns — the loop that cap exists for cannot start here.
    if (isScriptAction(action)) {
      let context = body.executionContext;
      let secretScope: Parameters<typeof runScriptAction>[1]["secretScope"] = authority.actsFor === "caller"
        ? authority.caller.session.identity_id == null ? { kind: "none" } : { kind: "identity", id: authority.caller.session.identity_id }
        : body.executionContext?.identity ? { kind: "identity", uuid: body.executionContext.identity } : { kind: "installation" };
      if (authority.actsFor === "caller") {
        try {
          context = await callerScriptBound(authority.caller, principal);
        } catch {
          return reply(409, { error: "unenforceable_grant", message: "The calling session's execution bounds could not be resolved." });
        }
      }
      if (authority.actsFor === "bag" && (body.identity || body.identity_id !== undefined)) {
        let identityId: number | undefined;
        let selected: Awaited<ReturnType<typeof identityRecords.resolve>>;
        try {
          selected = await identityRecords.resolve({
            ...(body.identity ? { name: body.identity } : {}),
            ...(body.identity_id !== undefined ? { id: body.identity_id } : {}),
          }, requestCaller(principal));
          identityId = (await identityRecords.rowId(selected.barry)) ?? undefined;
          if (identityId === undefined) throw new Error("The selected identity has no installed identity record.");
          secretScope = { kind: "identity", id: identityId };
        } catch {
          return reply(404, { error: "unknown_identity", message: "The selected identity could not be resolved." });
        }
        try {
          const identityCfg = identityRecords.config(selected.barry);
          const defaultBags = (identityCfg.bags ?? [])
            .filter((b: string | { name: string; optional?: boolean }) => typeof b === "string" || !b.optional)
            .map((b: string | { name: string; optional?: boolean }) => (typeof b === "string" ? b : b.name));
          const requestedBags = body.bags ?? context?.bags ?? defaultBags;
          const resolvedBound = context?.bound
            ? context.bound
            : (await Barry.as(requestCaller(principal)).bound(identityId, body.bounds ?? [])) ?? {};
          const tools = await Barry.as(requestCaller(principal)).tools(
            identityId,
            requestedBags,
            resolvedBound,
          );
          const selectedContext: CallerScriptBound = {
            bags: requestedBags,
            bound: resolvedBound,
            tools,
            allowedToolIds: tools.map((tool) => qualifyToolId(tool.namespace, tool.name)),
          };
          if (context) {
            const ceiling = context.allowedToolIds;
            selectedContext.allowedToolIds = selectedContext.allowedToolIds.filter(id => ceiling.includes(id));
          }
          context = selectedContext;
        } catch {
          return reply(409, { error: "unenforceable_grant", message: "The selected identity's execution bounds could not be resolved." });
        }
      }
      if (context && !permitsRawProcess(context)) {
        return reply(409, {
          error: "unenforceable_grant",
          message: "Raw script actions require Bash access and an unrestricted execution bound; use guarded Barry tools for restricted work.",
        });
      }
      const { run } = await runScriptAction(action, {
        secretScope,
        sessionId: authority.actsFor === "caller" ? authority.caller.session.id : null,
        ...(body.inputs ? { inputs: body.inputs } : {}),
        trigger: body.trigger ?? (body.schedule_id ? "schedule" : "api"),
        scheduleId: body.schedule_id ?? null,
      });
      return reply(200, {
        run_id: run.id,
        status: run.status,
        summary: run.summary,
        output: run.output,
        output_type: run.output_type,
        exit_code: run.process?.exit_code ?? null,
        ...(run.validation_failures?.length ? { validation_failures: run.validation_failures } : {}),
      });
    }

    // Exactly the caller's, even when null: the engine adds a barry's bags
    // and bound only for a session that records one, so substituting a
    // default here would hand the run access its caller never had.
    const callerBarryId = authority.actsFor === "caller" ? authority.caller.session.identity_id : null;

    // Credentials live on a barry — its env map, resolved through vault and
    // keychain — and nowhere else. A run with no barry therefore had no keys:
    // the SDK saw only PATH and HOME, so every z.ai model got a 401 and
    // retried until the executor timeout. Resolved the same way the trigger
    // route resolves it, so a detached run and a triggered session for the
    // same user act for the same barry.
    const identityFreeSchedule = Boolean((body.executionContext || body.bags || body.bounds) && !body.identity && !body.identity_id && (body.trigger === "schedule" || body.trigger === "job" || body.schedule_id));
    if (identityFreeSchedule && Boolean(body.executionContext && !body.identity && !body.identity_id) && (!action.agent?.agent || !action.agent.model)) return reply(400, { error: "explicit_agent_required", message: "Identity-free agent schedules require an explicit agent and model in the action." });
    let selection: { barry: IdentityRecord | null };
    if (Boolean(body.executionContext && !body.identity && !body.identity_id)) {
      selection = { barry: null };
    } else {
      try {
        selection = await identityRecords.resolve(
          authority.actsFor === "caller"
            ? callerBarryId !== null ? { id: callerBarryId } : {}
            : {
                ...(body.identity ? { name: body.identity } : {}),
                ...(body.identity_id ? { id: body.identity_id } : {}),
              },
          requestCaller(principal),
        );
      } catch (error) {
        if (!isBarryError(error)) throw error;
        return reply(404, { error: "unknown_identity", message: error.message });
      }
    }
    const identityId = selection.barry ? (await identityRecords.rowId(selection.barry)) ?? undefined : undefined;
    const identityConfig = selection.barry ? identityRecords.config(selection.barry) : { env: {}, vault: undefined, bounds: [], bags: [], bag_configs: {}, secrets: {}, bound: undefined, adapters: {}, status_notify: undefined };

    // Resolved before the row is written so the row can record the decision,
    // and before the concurrency slot is taken so a refusal below costs none.
    const runAgent = resolveRunAgent({
      request: { agent: body.provider ? providerFieldId(body.provider) : undefined, model: body.model },
      manifest: action.agent ? { ...action.agent, agent: action.agent.agent ? providerFieldId(action.agent.agent) : undefined } : undefined,
      identity: {
        agent: body.provider || action.agent?.agent ? undefined : providerFieldId(defaultHarness(identityConfig.adapters) ?? FALLBACK_HARNESS),
        modelFor: agent => adapterSettings(identityConfig.adapters, getDescribeAdapter()?.(agent) ?? { id: agent })?.model,
      },
      fallbackAgent: providerFieldId(FALLBACK_HARNESS),
    });
    let identityEnv: IdentityEnv | null = null;
    if (!Boolean(body.executionContext && !body.identity && !body.identity_id)) {
      try {
        identityEnv = await resolveEnvForBarry(identityId);
      } catch (error) {
        if (!(error instanceof IdentityEnvironmentError)) throw error;
        return reply(424, { error: "identity_environment_failed", message: error.message });
      }
    }
    const runEnv = identityEnv ? identityEnv.vars : {};

    // Refuse now rather than start a run that cannot authenticate: without
    // the key the endpoint 401s, the SDK retries, and the caller waits out
    // the whole timeout for a 504 indistinguishable from a hung suite.
    const harnessRecord = getDescribeAdapter()?.(runAgent.agent);
    // The manifest checks an agent id's shape only: whether that harness is
    // installed is a fact about this host, so it is asked here, before a row
    // or a concurrency slot exists.
    if (!harnessRecord) {
      return reply(400, {
        error: "unknown_harness",
        message: `No adapter is installed for "${runAgent.agent}". \`barry adapter list\` shows the ones that are.`,
      });
    }
    if (authority.actsFor === "caller" && harnessRecord.modes.hosted?.guarantees.gating !== "per-call") {
      return reply(409, { error: "unenforceable_grant", message: `${runAgent.agent} cannot enforce a per-call native-tool ruling. Choose a per-call hosted adapter, such as claude.` });
    }
    const routedVendor =
      runAgent.model ? routedVendorOf(harnessRecord, runAgent.model, installedModels().vendors()) : undefined;
    const required = requiredCredentials({
      harness: { id: harnessRecord.id, credentials: harnessRecord.bag?.manifest.credentials },
      routedVendors: routedVendor ? [routedVendor] : [],
    });
    for (const { env: name } of required) {
      const secret = identityEnv?.environment?.vars[name];
      if (!secret) return reply(424, { error: "missing_credential", message: `${name} is unavailable from "${selection.barry?.name ?? "identity-free schedule"}" declared secrets` });
      runEnv[name] = secret;
    }

    const adhoc = action.source === "adhoc";
    let grant: RunBounds;
    if (authority.actsFor === "caller") {
      const agent = runAgent.agent;
      // A denied-tools list restricts only an agent that enforces it. On any
      // other, the subagent's own shell would reach past every bound its
      // caller has, so the run is refused rather than started looser.
      if (!canDenyNativeTools(agent)) {
        return reply(409, {
          error: "unenforceable_grant",
          message:
            `${agent} cannot deny its own native tools, so a subagent on it could reach ` +
            "past this session's bounds. Choose an agent that can, such as claude.",
        });
      }
      const cwd = body.cwd ?? action.dir;
      // An installed action's directory comes from the catalog. An ad-hoc
      // one's comes from the request, or from where its session was working
      // when it created the action, and either may not exist any more.
      if (adhoc && (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory())) {
        return reply(400, { error: "invalid_cwd", message: `"${cwd}" is not an existing absolute directory.` });
      }
      const native = await resolveSessionNativeTools(
        { id: authority.caller.session.id, provider: runAgent.agent, identityId: callerBarryId },
        { bags: authority.caller.bags, bound: authority.caller.bound },
      );
      if (Object.keys(native.conflicts).length) return reply(409, { error: "unenforceable_grant", message: `session bounds cannot take back ${Object.keys(native.conflicts).join(", ")} on ${runAgent.agent} (hosted): ${[...new Set(Object.values(native.conflicts))].join("; ")}` });
      grant = {
        identityId: callerBarryId ?? undefined,
        bags: authority.caller.bags,
        bound: authority.caller.bound,
        bounds: authority.caller.bounds.filter((b): b is string => typeof b === "string"),
        cwd,
        maxTurns: adhoc ? ADHOC_RUN_MAX_TURNS : BAG_RUN_MAX_TURNS,
        timeoutCeilingS: adhoc ? MAX_ADHOC_TIMEOUT_S : MAX_DECLARED_TIMEOUT_S,
        caller: {
          agent,
          deniedTools: native.denied,
          allowedNativeTools: native.allowed,
          sessionId: authority.caller.session.id,
          narrowed: authority.caller.narrowed,
        },
      };
    } else {
      const requestedBags = body.bags ?? body.executionContext?.bags ?? [...new Set(["actions", authority.action.bag])];
      const requestedBounds = body.bounds ?? [];
      let pinnedBound: Bound | null = body.executionContext?.bound ? { ...body.executionContext.bound } : null;
      if (!pinnedBound && requestedBounds.length > 0) {
        try {
          const resolved = await Barry.as(requestCaller(principal)).bound(identityId ?? null, requestedBounds);
          if (resolved && Object.keys(resolved).length > 0) {
            pinnedBound = resolved;
          }
        } catch {
          pinnedBound = null;
        }
      }
      grant = {
        identityId,
        bags: requestedBags,
        bound: pinnedBound,
        bounds: requestedBounds.filter((b): b is string => typeof b === "string"),
        cwd: authority.action.dir,
        maxTurns: BAG_RUN_MAX_TURNS,
        timeoutCeilingS: MAX_DECLARED_TIMEOUT_S,
      };
    }

    // The MCP server filters tools by the SESSION's bags and pinned bound (looked up via
    // ?sessionId=), so the one-shot agent needs a real sessions row — an
    // anonymous connection gets only unbound tools. A run a session started copies
    // that session's row (see RunApproval), which is what makes its access the caller's
    // exactly. A run with no caller gets its bag's tools alongside `actions`.
    //
    // A session that runs an agent action itself is starting a subagent, and
    // a subagent is a job run: recorded as one, with the session that asked
    // for it, so `barry action runs --trigger job` finds it beside the
    // scheduler's. A job run that reaches here already names its trigger.
    const subagent = grant.caller !== undefined && body.trigger === undefined && !body.schedule_id;
    const trigger = body.trigger ?? (body.schedule_id ? "schedule" : subagent ? "job" : "api");
    const acquired = detachedRunSlots.acquire({
      scheduled: trigger === "schedule",
      callerSessionId: grant.caller?.sessionId ?? null,
    });
    if ("refused" in acquired) {
      return reply(429, { error: "executor_busy", message: acquired.refused });
    }
    const slot = acquired.slot;
    // Exactly one release per acquire. The `wait_s` early return hands the
    // release to the run's own settlement, which happens after this function
    // has already returned — so both paths check this flag, and the loser also
    // skips ending the session a second time.
    let slotReleased = false;
    // Set only on the `wait_s` early return, where the slot must outlive the
    // response. See the seam below for why a plain `return` is not enough.
    let deferSlotRelease = false;

    const sessionId = randomUUID().replace(/-/g, "").slice(0, 21);
    let runId: string | undefined;
    // Why the agent stopped, when Barry stopped it: set before the abort, so
    // the error the aborted agent throws is recorded as what caused it.
    let timedOutAfterS: number | null = null;
    let cancelRequested = false;
    try {
      await Sessions.create({
        id: sessionId,
        // Nothing created this run on an agent's behalf — it is an action
        // the API executes itself, so there is no actor to name.
        agent_token: null,
        ...(grant.identityId !== undefined ? { identity_id: grant.identityId } : {}),
        bags: grant.bags,
        ...(grant.bound ? { bound: grant.bound } : {}),
        bounds: grant.bounds,
        metadata: {
          source: "action-executor",
          ...(body.executionContext ? { execution_context: body.executionContext } : {}),
          action: action.qualifiedName,
          working_directory: grant.cwd,
          ...(grant.caller ? { caller_session_id: grant.caller.sessionId } : {}),
          // This session has no process of its own: it runs in-process here, as
          // an SDK query driven by an AbortController. The API IS its owner, so
          // the API's pid is the honest answer to "is it still running?" — if
          // this process dies mid-run the session is genuinely gone, and the
          // reaper can then see that instead of waiting out a 24h idle TTL.
          //
          hostname: hostname(),
        },
      });

      await Processes.recordStart({
        sessionId,
        pid: process.pid,
        pidStartedAt: readProcessStartTime(process.pid),
        hostname: hostname(),
        source: "api",
        appName: "api",
      });
      // Resolved from the row just written, by the same code a session's own
      // agent is sandboxed by, so a subagent's network scope is its caller's.
      const egressSandbox = grant.caller
        ? await resolveEgressSandbox(
            { id: sessionId },
            { provider: grant.caller.agent, model: runAgent.model },
          )
        : undefined;

      // Composed before the row is created so the prompt can be recorded on
      // it, matching begin_action. Composition is pure and warn-and-continue, so
      // moving it earlier cannot strand an open run.
      // Curried rather than changing composeActionPrompt's contract: it wants
      // a `(ref) => instruction` resolver and has no business knowing about
      // bags. The registry is bound here, where it is already loaded.
      const composed = await composeActionPrompt(action, body.inputs, (ref) =>
        findInstruction(registeredBags, ref),
      );
      if (composed.warnings.length) {
        log.warn("actions.run_compose_warnings", {
          action: action.qualifiedName,
          warnings: composed.warnings,
        });
      }

      // The probe matters MORE here than inline: a detached run has nobody to
      // read a warning mid-flight, so an unreachable dependency would surface
      // only as a confidently-wrong deliverable. It still does not block — a
      // detached run cannot ask a human to re-auth, and refusing to start would
      // trade a bad report for no report plus no record of why. Instead the
      // verdict is recorded on the run so a reader can tell "this ran without
      // its access" from "this ran fine".
      const preflight = await runActionPreflight(action.preflight, action.dir);
      if (preflight.warning) {
        log.warn("actions.run_preflight", {
          action: action.qualifiedName,
          unknown: preflight.unknown,
          warning: preflight.warning,
        });
      }

      // The caller's bound wins when given (capped as before); otherwise the
      // action's own, which is the one a schedule relies on. Resolved BEFORE
      // the row is written so the row can carry it: a poller reading a started
      // run needs to know when it will be abandoned, and deriving that from
      // `timeout_s` client-side is wrong whenever the action declared its own.
      const timeoutS = body.timeout_s
        ? Math.min(body.timeout_s, MAX_TIMEOUT_S)
        : Math.min(action.timeout ?? DEFAULT_TIMEOUT_S, grant.timeoutCeilingS);

      // Snapshot the output contract into the run row (same rule as
      // begin_action): completion honors the contract the run started with even
      // if the action is edited mid-flight. The input side is recorded through
      // the SAME helper begin_action uses, so a viewer never has to know which
      // path wrote the row.
      const run = await ActionRuns.create({
        action: action.qualifiedName,
        bag: action.source === "bag" ? action.bag : null,
        session_id: sessionId,
        trigger,
        schedule_id: body.schedule_id ?? null,
        metadata: {
          ...describeActionSource(action),
          ...(body.caller_session_id ? { caller_session_id: body.caller_session_id } : {}),
          ...(subagent && grant.caller ? { job: { kind: "subagent", caller_session_id: grant.caller.sessionId } } : {}),
          // What a session's run was allowed, since nothing else records it:
          // the row it ran as is ended when the run is.
          ...(grant.caller
            ? {
                grant: {
                  bags: grant.bags,
                  bounds: grant.bounds,
                  narrowed: grant.caller.narrowed,
                  native_tools_denied: grant.caller.deniedTools,
                  sandboxed: egressSandbox !== undefined,
                },
              }
            : {}),
          ...(action.outputSchema ? { output_schema: action.outputSchema } : {}),
          executor: true,
          // The deadline this run will actually be abandoned at, so a poller
          // can pace itself against the bound that applies rather than guess.
          timeout_s: timeoutS,
          provider: runAgent.agent,
          // The model this run ACTUALLY used, with where each half came from.
          // The row previously stored only the provider, so a manifest model
          // that was overridden looked exactly like one that applied.
          ...(runAgent.model ? { model: runAgent.model } : {}),
          agent_from: runAgent.agentFrom,
          model_from: runAgent.modelFrom,
          // Whose credentials the run had — a 401 is otherwise untraceable.
          identity: selection.barry?.name ?? null,
          // Three-valued, and absent when nothing was declared — "not checked"
          // and "checked and fine" must not read alike on the stored run.
          ...(preflight.skipped
            ? {}
            : { preflight: preflight.unknown ? "unknown" : preflight.passed }),
          ...describeActionInvocation(body.inputs, composed.prompt),
        },
      });

      // From here on the row exists, and every way out must close it.
      runId = run.id;

      // buildMcpConfig() already includes the always-on barry server; no
      // per-namespace split here — a one-shot run has no picker UI, and the
      // aggregate endpoint serves every granted tool under mcp__barry__*.
      const mcpServers = buildMcpConfig();
      for (const [name, server] of Object.entries(mcpServers)) {
        if ("url" in server && server.url && server.url.includes("/mcp")) {
          const sep = server.url.includes("?") ? "&" : "?";
          mcpServers[name] = { ...server, url: `${server.url}${sep}sessionId=${sessionId}` };
        }
      }

      const outputSchema = action.outputSchema ?? REPORT_SCHEMA;
      const { runSchema, wrapped } = wrapSchemaRoot(outputSchema);

      const abort = new AbortController();

      // Reject executor-spawned recursive execution even when it targets the same action.
      // Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-019
      const detachedTrailer =
        "\n\n---\n\nYou are running as a detached action run. Do NOT call " +
        "`run_action` — do the work in this session with the tools you have.";

      // Absent means "pass no model flag and let the agent's CLI decide" —
      // the same meaning the catalog gives a null default.
      const model = modelRefFor(runAgent.agent, runAgent.model);
      const runPromise = getRunStructured()({
        harness: runAgent.agent,
        prompt: composed.prompt + detachedTrailer,
        schema: runSchema,
        config: {
          sessionId,
          cwd: grant.cwd,
          env: runEnv,
          ...(model ? { model } : {}),
          mcpServers,
          maxTurns: grant.maxTurns,
          ...(grant.caller ? { deniedTools: grant.caller.deniedTools, allowedNativeTools: grant.caller.allowedNativeTools } : {}),
          ...(egressSandbox ? { egressSandbox } : {}),
          // What the harness asks about before running it: refused where the
          // caller's denials name it, run otherwise.
          decide: refuseDeniedTools(grant.caller?.deniedTools),
        },
        signal: abort.signal,
      });
      // A run that loses the race may still reject later (the abort landing);
      // mark that rejection handled so it cannot become an unhandledRejection
      // crash after the response has already gone out.
      void runPromise.catch(() => {});

      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOutAfterS = timeoutS;
          abort.abort();
          reject(new ExecutorTimeout());
        }, timeoutS * 1000);
      });
      // Rejected before the abort lands, so the race settles as a cancel and not
      // as whatever error the aborted agent throws.
      const cancelled = new Promise<never>((_, reject) => {
        runningAgents.set(run.id, (reason) => {
          cancelRequested = true;
          reject(new ExecutorCancelled(reason));
          abort.abort();
        });
      });
      void cancelled.catch(() => {});

      /** Persist settled run output even after the caller's wait ends; see docs/decisions/0020-session-route-and-cache-invariants.md. */
      const recordResult = async (settled: Awaited<typeof runPromise>): Promise<DetachedRunResult> => {
        // Unwrap the synthetic object root, then serialize by the same rule
        // resolveOutput applies at the complete_action boundary: a string-typed
        // root stores the string itself as `text`; everything else stores
        // serialized JSON as `json`.
        const data = wrapped
          ? (settled.data as Record<string, unknown>).value
          : settled.data;
        let output: string;
        let outputType: "json" | "text";
        if (outputSchema.type === "string" && typeof data === "string") {
          output = data;
          outputType = "text";
        } else {
          output = JSON.stringify(data) ?? "null";
          outputType = "json";
        }

        // Same cap complete_action enforces (see MAX_OUTPUT_CHARS' doc comment:
        // the executor boundary is the second enforcement point). Rejected, not
        // truncated — a silently truncated declared output is a violated
        // contract.
        if (output.length > MAX_OUTPUT_CHARS) {
          const message = `output is ${output.length} chars, over the ${MAX_OUTPUT_CHARS} cap — the action should store a pointer (file/artifact) instead`;
          await ActionRuns.fail(run.id, `The run failed: ${message}`);
          return reply(502, { error: "run_failed", message });
        }

        // Barry checks the post-conditions, not the agent: a failed check still
        // closes the run (status "failed"), with output recorded either way.
        const validation = await runActionValidation(action.validate, action.dir);
        const completed = await ActionRuns.complete(
          run.id,
          action.outputSchema
            ? "Executed detached"
            : output.slice(0, MAX_REPORT_SUMMARY_CHARS),
          validation.skipped ? null : { failures: validation.failures },
          action.outputSchema ? { type: outputType, value: output } : null,
        );
        if (!completed) {
          return reply(502, {
            error: "run_failed",
            message: `run row "${run.id}" disappeared before completion`,
          });
        }

        return reply(200, {
          run_id: run.id,
          status: completed.status === "failed" ? "failed" : "complete",
          summary: completed.summary,
          output: action.outputSchema ? output : null,
          output_type: action.outputSchema ? outputType : null,
          ...(validation.failures.length ? { validation_failures: validation.failures } : {}),
        });
      };

      // `wait_s` joins the race as a fourth participant. It is the only one
      // that is not a verdict on the run: the other three mean finished, timed
      // out or cancelled, while this one means only "stop waiting".
      let structured;
      try {
        structured = await Promise.race([
          runPromise,
          timedOut,
          cancelled,
          ...(body.wait_s ? [waitElapsed(body.wait_s)] : []),
        ]);
      } catch (raceErr) {
        // A real verdict (timeout, cancel, agent error): the run is over, so
        // tear down its timer and cancel handle before rethrowing.
        clearTimeout(timer);
        runningAgents.delete(run.id);
        throw raceErr;
      }

      // THE WAIT/RUN SEAM. `wait_s` bounds how long the RESPONSE is held open;
      // it never shortens the run.
      //
      // A won wait is NOT a settled run:
      //   - `timer` stays armed, or a waited run would lose its timeout.
      //   - the `runningAgents` entry stays, or `cancel_action` could not find
      //     a run that is still going.
      //   - the slot stays HELD until the run settles, so four waited runs
      //     still fill the executor and a fifth is refused.
      //
      // `deferSlotRelease` is what makes that last one work. Returning from
      // inside a `try` runs its `finally` on the way out — JS guarantees it —
      // so the outer release fires the instant this responds, which would free
      // a slot whose agent is still burning. The flag makes that `finally` skip
      // the release and hand it to the run's own settlement instead.
      if (structured === WAIT_ELAPSED) {
        deferSlotRelease = true;
        void runPromise
          .then(
            (settled) => recordResult(settled),
            async (err: unknown) => {
              // A cancel's row was closed by the cancel route, with its reason.
              if (cancelRequested) return;
              log.error("actions.run_failed", {
                action: action.qualifiedName,
                run_id: run.id,
                error: err instanceof Error ? err.message : String(err),
              });
              await ActionRuns.fail(run.id, agentFailureReason(err, timedOutAfterS));
            },
          )
          .catch((err: unknown) => {
            log.error("actions.run_record_failed", {
              run_id: run.id,
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            clearTimeout(timer);
            runningAgents.delete(run.id);
            if (slotReleased) return;
            slotReleased = true;
            slot.release();
            void Sessions.end(sessionId, "action-executor-complete").catch(() => {});
          });
        return reply(200, { run_id: run.id, status: "started" });
      }

      clearTimeout(timer);
      runningAgents.delete(run.id);
      return await recordResult(structured);
    } catch (err) {
      // The cancel route closed the row; this only answers whoever was awaiting it.
      if (err instanceof ExecutorCancelled) {
        log.info("actions.run_cancelled", { action: action.qualifiedName, run_id: runId });
        return reply(409, { error: "cancelled", run_id: runId, message: err.reason });
      }
      // Closed `failed` with the cause. Left `started`, the run was closed
      // later by the session sweep as "the session ended without calling
      // complete_action", and the real cause survived only in this log. A run
      // the API never got to close (it died mid-run) still reaches the sweep.
      if (runId && !cancelRequested) {
        try {
          await ActionRuns.fail(runId, agentFailureReason(err, timedOutAfterS));
        } catch (recordErr) {
          // The caller still hears the run's own failure below.
          log.error("actions.run_record_failed", {
            run_id: runId,
            error: recordErr instanceof Error ? recordErr.message : String(recordErr),
          });
        }
      }
      // Each names its run, as the cancel reply does, so a schedule reading
      // the reply can find the row that says why.
      if (err instanceof ExecutorTimeout) {
        log.warn("actions.run_timeout", { action: action.qualifiedName, run_id: runId });
        return reply(504, { error: "timeout", ...(runId ? { run_id: runId } : {}) });
      }
      log.error("actions.run_failed", {
        action: action.qualifiedName,
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return reply(502, {
        error: "run_failed",
        ...(runId ? { run_id: runId } : {}),
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Skipped when `wait_s` handed the release to the run's own settlement.
      // On every other path this is still the only release.
      if (!slotReleased && !deferSlotRelease) {
        slotReleased = true;
        slot.release();
        // Close the synthetic session either way — mirrors cli/src/sdk.ts, so
        // one-shot runs don't accumulate rows that look active to `session list`
        // and the menu-bar apps.
        try {
          await Sessions.end(sessionId, "action-executor-complete");
        } catch {
          /* best-effort */
        }
      }
    }
}
