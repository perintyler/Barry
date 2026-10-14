/**
 * The contract a piece of Barry work declares: what it needs, what it takes,
 * what it produces, and how long it may run.
 *
 * Shared by actions (`action.yaml`) and jobs (`jobs:` in bag.yaml) so the two
 * cannot drift. They differ in what does the work — an agent following a
 * prompt, or code — not in how that work is described, and a field spelled
 * one way in an action and another in a job would be a second vocabulary for
 * the same fact.
 *
 * The field names are the authored YAML spellings (`input_schema`, not
 * `inputSchema`); `normalizeContract` is the one place they become the
 * camelCase the rest of Barry reads.
 */

import { z } from "zod";
import { assertCompilableSchema } from "../tools/validate.js";
import { SecretNamesSchema } from "../env/secret-names.js";
import { DurationSchema } from "../schedules/duration.js";

/**
 * What must exist for the work to run.
 *
 * ADVISORY ONLY for an action — this never grants and never bags. Barry's MCP
 * layer already enforces tool access by *not registering* ungranted tools
 * (resolveSessionBound -> filterTools, then the tools/list filter), so an
 * action naming a tool the session lacks simply cannot invoke it. A second
 * check here would be a redundant enforcement point that drifts from the real
 * one. What this buys is a good early warning: find_actions can say "this
 * action calls a tool this session can't invoke" before any work starts.
 *
 * `tools` replaces the traits/bags fields an earlier draft had: a trait is
 * merely *how* a tool gets granted, so naming the tool is both more precise and
 * survives a tool moving between bags.
 */
export const ActionRequiresSchema = z
  .object({
    /** Tool names the action's prompt tells the agent to call. */
    tools: z.array(z.string().min(1)).optional(),
    /**
     * Env keys a script this action ships needs. Only meaningful for actions
     * whose prompt invokes a script: a tool-shaped action declares nothing here
     * because the tool it calls already declares its own secrets and Barry
     * resolves them per-session from the barry (vault or Keychain).
     */
    secrets: SecretNamesSchema.optional(),
    /** Host binaries a script this action ships needs, e.g. `uv`. */
    bins: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * A job's requirements: an action's, plus the worker labels it needs.
 *
 * `labels` is job-only on purpose. A label says which machine may run the
 * work (`model: local`), and an action has no placement — it runs where it
 * is asked. Accepting the field on an action would be a field that parses and
 * does nothing, which the manifests refuse everywhere else.
 */
export const JobRequiresSchema = ActionRequiresSchema.extend({
  labels: z.record(z.string().min(1), z.string().min(1)).optional(),
}).strict();

/**
 * Post-conditions a run is checked against when it completes.
 *
 * The point is that these are checked by BARRY, not self-reported by the agent.
 * `complete_action` already takes a summary, and a summary is exactly the thing
 * a model will happily write for work it did not do — so a check worth having
 * must be observable from outside the conversation.
 *
 * Hence the two forms, both objective:
 *
 * - `files_exist` — paths that must be on disk afterwards. The cheap, honest
 *   check for any action whose job is to produce something.
 * - `command` — a shell command that must exit 0. The general escape hatch:
 *   run the test suite, grep for the thing, curl the endpoint.
 *
 * Deliberately NOT included: anything phrased as "the agent should confirm…".
 * That is a prompt instruction, and the prompt already exists.
 *
 * A failing check does not undo the work — it records `status: "failed"` with
 * the reason. Refusing to close the run would strand it open, which is worse:
 * listing open runs (`list-action-runs`) exists precisely to find runs nobody
 * closed.
 */
export const ValidateSchema = z
  .object({
    /**
     * Paths that must exist when the run completes. Relative paths resolve
     * against the action's directory, matching how ${ACTION_DIR} scripts do.
     */
    files_exist: z.array(z.string().min(1)).optional(),
    /** A command that must exit 0. Run with cwd = the action's directory. */
    command: z.string().min(1).optional(),
    /**
     * Seconds before the command is killed and the check fails. Without a
     * bound, a hanging validation hangs `complete_action` — the one tool an
     * agent calls when it is trying to finish.
     */
    timeout: z.number().int().positive().max(600).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.files_exist?.length) || Boolean(v.command), {
    message: "must declare files_exist or command",
  });

/**
 * A precondition probe run BEFORE the work starts.
 *
 * `requires` asks *is it installed*; this asks *does it work here, right now,
 * for me*. Only the second catches the case that motivated it: valid AWS
 * credentials resolving to a role that cannot `kubectl exec`, where every
 * declared binary is present, the requirement warnings are silent, and the run
 * dies an hour later on a 403 indistinguishable from an empty result.
 *
 * ADVISORY for an action, like `requires` and for the same stated reason — an
 * unreachable cluster is not the caller's to fix mid-call, so blocking would
 * strand the run while telling the agent nothing actionable. The probe reports
 * what it observed; the agent decides. A JOB has no agent to decide, so a job
 * whose probe does not pass does not start.
 *
 * Authoring hazard worth stating in the manifest: a probe must be written so it
 * can actually FAIL. `kubectl auth can-i … | tail -2` exits 0 no matter what,
 * because `$?` reports the tail — the probe passes while the cluster is
 * unreachable. No pipes.
 */
export const PreflightSchema = z
  .object({
    /**
     * A cheap probe that must exit 0. Run with cwd = the action's directory,
     * with ${ACTION_DIR} substituted so it can invoke a script the action ships.
     *
     * Required, unlike validate's optional command: a preflight block that
     * declares no probe checks nothing, and an empty check that reports success
     * is the exact failure this feature exists to prevent.
     */
    command: z.string().min(1),
    /**
     * Seconds before the probe is killed and reported as UNKNOWN (never as
     * passed). Capped far below validate's 600: this runs before every
     * `begin_action`, and a preflight slower than a few seconds costs more than
     * the failure it prevents.
     */
    timeout: z.number().int().positive().max(60).optional(),
    /**
     * What to do about a failure, in the author's words — the remediation the
     * probe's own stderr cannot supply ("re-auth with `granted sso login …`").
     * Surfaced verbatim in the warning.
     */
    hint: z.string().min(1).max(500).optional(),
  })
  .strict();

/**
 * The contract fields, as zod shape entries, for a manifest schema to spread.
 * `requires` is the action form; a job replaces it with JobRequiresSchema.
 */
export const ContractShape = {
  requires: ActionRequiresSchema.optional(),
  preflight: PreflightSchema.optional(),
  validate: ValidateSchema.optional(),
  /**
   * JSON Schema for the inputs a caller may hand the work — the same shape an
   * MCP tool's inputSchema takes, and raw JSON Schema on purpose: the
   * workspace is split across zod 3 and zod 4, and a manifest is data, not
   * code. Must be an object schema (inputs are named). Validated for
   * compilability at parse time so a broken schema fails the manifest, not
   * the first live run.
   */
  input_schema: z.record(z.string(), z.unknown()).optional(),
  /**
   * JSON Schema for what the work produces. Any root is legal — wrap-up's
   * output is `{type: string}` (a markdown report). The executor wraps
   * non-object roots for providers whose native enforcement wants an object,
   * and unwraps transparently; declaring the wrapper here would leak a
   * provider quirk into every manifest.
   */
  output_schema: z.record(z.string(), z.unknown()).optional(),
  /**
   * How long a run may take before it is killed and recorded failed:
   * seconds or `10m`.
   */
  timeout: DurationSchema.optional(),
};

export type ContractValidate = {
  files_exist?: string[];
  command?: string;
  timeout?: number;
};

export type ContractPreflight = {
  command: string;
  timeout?: number;
  hint?: string;
};

/** The authored contract fields, as a manifest schema parsed them. */
export interface RawContract {
  requires?: { tools?: string[]; secrets?: string[]; bins?: string[]; labels?: Record<string, string> };
  preflight?: ContractPreflight;
  validate?: ContractValidate;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  timeout?: number;
}

/** The contract as the rest of Barry reads it. */
export interface WorkContract {
  requires: { tools: string[]; secrets: string[]; bins: string[]; labels?: Record<string, string> };
  preflight?: ContractPreflight;
  validate?: ContractValidate;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Run timeout in seconds, when declared. */
  timeout?: number;
}

/**
 * The checks a contract needs beyond its zod shape: both schemas must compile,
 * and inputs must be an object, because inputs are NAMED values and a
 * non-object root has no property names to hand them by. Throws with `label`
 * leading the message, the way every manifest error reads.
 */
export function checkContract(raw: RawContract, label: string): void {
  // A schema that does not compile is a manifest error, not a runtime one:
  // failing here means the shipped-manifest tests catch it, instead of the
  // first live run erroring.
  for (const [field, schema] of [
    ["input_schema", raw.input_schema],
    ["output_schema", raw.output_schema],
  ] as const) {
    if (!schema) continue;
    try {
      assertCompilableSchema(schema);
    } catch (error) {
      throw new Error(
        `${label}: ${field} is not a valid JSON Schema ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  if (raw.input_schema && raw.input_schema.type !== "object") {
    throw new Error(`${label}: input_schema must have "type": "object"`);
  }
}

/** The one snake_case → camelCase mapping of a contract. */
export function normalizeContract(raw: RawContract): WorkContract {
  return {
    requires: {
      tools: raw.requires?.tools ?? [],
      secrets: raw.requires?.secrets ?? [],
      bins: raw.requires?.bins ?? [],
      ...(raw.requires?.labels ? { labels: raw.requires.labels } : {}),
    },
    ...(raw.preflight !== undefined ? { preflight: raw.preflight } : {}),
    ...(raw.validate !== undefined ? { validate: raw.validate } : {}),
    ...(raw.input_schema !== undefined ? { inputSchema: raw.input_schema } : {}),
    ...(raw.output_schema !== undefined ? { outputSchema: raw.output_schema } : {}),
    ...(raw.timeout !== undefined ? { timeout: raw.timeout } : {}),
  };
}

/**
 * Copy the contract fields of an already-normalized manifest, leaving out
 * absent ones rather than writing `undefined`. One copy for every place a
 * manifest becomes catalog metadata — a field copied on one path and forgotten
 * on another is parsed, validated, then silently absent at run time.
 */
export function contractFields(contract: WorkContract): WorkContract {
  return {
    requires: contract.requires,
    ...(contract.preflight !== undefined ? { preflight: contract.preflight } : {}),
    ...(contract.validate !== undefined ? { validate: contract.validate } : {}),
    ...(contract.inputSchema !== undefined ? { inputSchema: contract.inputSchema } : {}),
    ...(contract.outputSchema !== undefined ? { outputSchema: contract.outputSchema } : {}),
    ...(contract.timeout !== undefined ? { timeout: contract.timeout } : {}),
  };
}
