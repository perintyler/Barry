import { z } from "zod";

const OpaqueEntity = z.record(z.string(), z.unknown());

// Action runs are the ONE snake_case surface in this contract. The actions
// router is mounted before apiContractMiddleware on purpose (bags/sessions/api's
// index.ts says why: the middleware would camelCase a wire format that mirrors
// the run_action MCP tool verbatim), so these schemas describe the keys the
// route really emits rather than the house style. Declaring them here is what
// lets the Swift client be generated instead of hand-rolled.
// A plain string, NOT an enum, and deliberately so.
//
// `action_runs.status` has no CHECK constraint, and the table holds a legacy
// `completed` row written before the vocabulary settled. A generated client
// decodes an out-of-set enum as a hard error, so that ONE row made the entire
// run list fail to decode — a 100-row response lost to a value the reader
// did not need to understand. Documented values are listed in the
// description; consumers map unknown ones to their own fallback (the macOS
// app treats anything unrecognised as still-open, which is the safe read).
const ActionRunStatus = z
  .string()
  .describe("Run status: started | complete | failed. Unknown values may appear on legacy rows.");
// `bag` is null for a run of an ad-hoc action, which no bag ships. A client
// that required it would fail to decode the whole page on the first such row,
// the failure the status note above describes.
const RunBag = z.string().nullable().describe("The bag that ships the action; null for an ad-hoc action.");
export const ActionRunSummarySchema = z.object({
  run_id: z.string(),
  action: z.string(),
  bag: RunBag,
  session_id: z.string().nullable(),
  status: ActionRunStatus,
  summary: z.string().nullable(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  has_output: z.boolean(),
  // String for the same reason as status: an unrecognised value must not cost
  // the caller the whole page.
  output_type: z.string().nullable().describe("json | text"),
  trigger: z.string().nullable().optional(),
  schedule_id: z.string().nullable().optional(),
  // The executed process's, for runs Barry ran itself; null otherwise.
  exit_code: z.int().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
}).strict();
// The detail shape drops has_output (the output itself is here) and adds the
// input side: `metadata` carries the inputs and composed prompt.
//
// `metadata` and `validated_at` are OPTIONAL here even though the server now
// always sends them. A generated client treats a required field as a hard
// decode failure, so declaring them required means a freshly built app cannot
// read runs from an API that has not been restarted yet — the whole detail
// view dies with "the data couldn't be read" rather than degrading. Optional
// costs nothing: an absent metadata reads as "not recorded", which is exactly
// what a pre-capture server means.
export const ActionRunRecordSchema = z.object({
  run_id: z.string(),
  action: z.string(),
  bag: RunBag,
  session_id: z.string().nullable(),
  status: ActionRunStatus,
  summary: z.string().nullable(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  trigger: z.string().nullable().optional(),
  schedule_id: z.string().nullable().optional(),
  process: z.record(z.string(), z.unknown()).nullable().optional(),
  validated_at: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  output: z.string().nullable(),
  output_type: z.string().nullable().describe("json | text"),
  validation_failures: z.array(z.string()).optional(),
}).strict();
export const ActionRunListResponseSchema = z.object({
  count: z.int().nonnegative(),
  runs: z.array(ActionRunSummarySchema),
}).strict();
export const ActionCatalogEntrySchema = z.object({
  name: z.string(),
  qualified_name: z.string(),
  bag: z.string(),
  description: z.string(),
  /** True when the generated instruction runs the action detached, via run_action. */
  executable: z.boolean(),
  /**
   * Property names only. Superseded by `input_schema` — kept so a client
   * shipped before the form still renders its hint row.
   */
  input_names: z.array(z.string()),
  /**
   * The action's declared input_schema, verbatim, so a GUI can build a form
   * from types, titles, defaults and suggestions. Optional: absent means the
   * action declares no inputs, and an older API sends nothing at all.
   */
  input_schema: OpaqueEntity.optional(),
}).strict();
/**
 * Which catalog the caller just got.
 *
 * `identity` — filtered to that identity's packed bags (composition expanded).
 * `all` — the unfiltered catalog, because no identity could be resolved.
 *
 * Present so the empty case is readable: an identity with nothing packed and a
 * failed resolution both return zero actions, and a client that cannot tell
 * them apart renders a broken install as an empty one.
 */
export const ActionCatalogScopeSchema = z.object({
  kind: z.enum(["identity", "all"]),
  /** The resolved identity's name; null when `kind` is "all". */
  identity: z.string().nullable(),
  /** The bags the filter used — empty when `kind` is "all". */
  bags: z.array(z.string()),
}).strict();
export const ActionCatalogResponseSchema = z.object({
  count: z.int().nonnegative(),
  actions: z.array(ActionCatalogEntrySchema),
  /**
   * Optional so a newly built client can still read an API that has not been
   * restarted yet. A generated client treats a required field as a hard decode
   * failure, which would turn a deploy-ordering gap into "the data couldn't be
   * read" — the same trap `metadata`/`validated_at` document on the run types.
   */
  scope: ActionCatalogScopeSchema.optional(),
}).strict();
export const TriggerBodySchema = z.object({
  action: z.string().min(1),
  repo_path: z.string().min(1).optional(),
  extra: z.string().max(10_000).optional(),
  /**
   * Values the caller decided, validated against the action's input_schema
   * before the session is created. Only fields a human actually set: an
   * omitted field is one the agent should infer.
   */
  inputs: OpaqueEntity.optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
}).strict();
// The response hands back a session and the prompt to send it, rather than
// spawning: the caller POSTs `prompt` to /sessions/{id}/message, which lets it
// subscribe to the session's socket first so no early output is missed.
export const ActionTriggerResponseSchema = z.object({
  session_id: z.string(),
  action: z.string(),
  prompt: z.string(),
  executable: z.boolean(),
}).strict();

export const ActionBeginResponseSchema = z.object({
  run_id: z.string(),
  action: z.string(),
  action_dir: z.string(),
  prompt: z.string(),
  warnings: z.array(z.string()).optional(),
  scoring: z.object({ adapter: z.string(), questions: z.array(z.string()) }).optional(),
  preflight_passed: z.union([z.boolean(), z.literal("unknown")]).optional(),
  will_be_checked: z.array(z.string()).optional(),
  expected_output: z.object({ schema: z.record(z.string(), z.unknown()) }).optional(),
  next: z.string(),
}).strict();

export const ActionRunResponseSchema = z.strictObject({
  run_id: z.string().nullable(), status: z.enum(["complete", "failed"]),
  summary: z.string().nullable().optional(), output: z.string().nullable(), output_type: z.enum(["json", "text"]).nullable(),
  job_run_id: z.string().optional(), exit_code: z.int().nullable().optional(), validation_failures: z.array(z.unknown()).optional(),
});
export const ActionRunPendingResponseSchema = z.strictObject({ run_id: z.string(), status: z.literal("started") });
export const ActionJobPendingResponseSchema = z.strictObject({ run_id: z.string().nullable(), job_run_id: z.string(), status: z.literal("started"), summary: z.string().nullable(), output: z.string().nullable(), output_type: z.enum(["json", "text"]).nullable() });
export const ActionExecutionResponseSchema = z.union([ActionRunResponseSchema, ActionRunPendingResponseSchema]);

export const RunActionBodySchema = z.strictObject({
  inputs: z.record(z.string(), z.unknown()).optional(),
  provider: z.string().min(1).optional(),
  // The request half of the agent chain. `provider` alone could only switch
  // agents, which forced the manifest's model to be dropped wholesale (the
  // carrier rule) with no way to name a replacement.
  model: z.string().min(1).optional(),
  timeout_s: z.number().int().positive().optional(),
  /**
   * How long to hold the HTTP response open before answering
   * `{ run_id, status: "started" }` and letting the run finish in the
   * background. Distinct from `timeout_s`, which bounds the RUN; this bounds
   * only the WAIT.
   *
   * ABSENT MEANS BLOCK TILL DONE — today's behaviour, unchanged. That default
   * is load-bearing: schedules (routes/schedules.ts:191,249) and the CLI call
   * this route without it and need the finished result in the response.
   */
  wait_s: z.number().int().positive().max(600).optional(),
  /**
   * Which barry the run acts for, by name: whose credentials it gets and whose
   * defaults fill an agent or model nobody else named. Absent resolves the
   * way POST /actions/trigger does — BARRY_IDENTITY, then the user's default.
   */
  identity: z.string().min(1).optional(),
  /**
   * The same choice by id — what run_action sends, since a session records
   * its barry as an id. Naming both is ambiguous and refused.
   */
  identity_id: z.number().int().positive().optional(),
  /** The schedule firing this run, recorded on the row. Set by the scheduler. */
  schedule_id: z.string().min(1).optional(),
  /**
   * The session asking, as run_action resolves it from its connection. An
   * ad-hoc action is looked up among this session's own, and runs with this
   * session's access; for an installed action it is recorded as lineage.
   */
  caller_session_id: z.string().min(1).optional(),
  /** Ad-hoc only: run with a subset of the caller's traits. Never more. */
  traits: z.array(z.string().min(1)).optional(),
  /** Ad-hoc only: where the run starts. Absent: where the action was created. */
  cwd: z.string().min(1).optional(),
}).refine((b) => !(b.identity && b.identity_id), {
  message: "pass identity or identity_id, not both",
});

export const BeginBodySchema = z.strictObject({
  inputs: z.record(z.string(), z.unknown()).optional(),
  /** The session the run belongs to. Absent means unattributed, as for a CLI caller. */
  session_id: z.string().min(1).optional(),
});

export const ActionErrorSchema = z.object({ error: z.string(), message: z.string().optional(), details: z.array(z.string()).optional() });
