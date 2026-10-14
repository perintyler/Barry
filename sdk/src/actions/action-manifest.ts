import { SecretNamesSchema } from "../env/secret-names.js";
/**
 * Parse and validate action.yaml manifests.
 *
 * An action is one prompt plus the requirements needed to run it. A SKILL.md
 * body is the same shape, which is what makes actions a replacement for skills
 * rather than a parallel format — a SKILL.md *is* an action.
 *
 * `steps` is the one exception, added deliberately and narrowly. This file used
 * to argue there should be no step array at all: stages belong in prose, the way
 * a SKILL.md walks an agent through them. That holds for an action whose stages
 * are its own work. It does NOT hold when the stages are OTHER ACTIONS, because
 * prose naming a child action is a reference nothing checks — rename the child
 * and the parent breaks at runtime, silently, which is what the whole catalog
 * exists to prevent.
 *
 * So a composite declares its children as data and keeps its prose for the part
 * that is genuinely judgment: how to run them together. A composite has no
 * SKILL.md equivalent, and that is the cost — paid because a checkable edge
 * between two actions is worth more than format symmetry for the handful of
 * actions built out of others.
 *
 * What actions add over skills is the metadata around the prompt: declared
 * requirements (checkable before the agent starts), a run row (the seam
 * validation hooks into), and a resolved directory so scripts an action ships
 * are runnable on every provider rather than only where the Claude Code runtime
 * sets ${CLAUDE_SKILL_ROOT}.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, isAbsolute, normalize } from "path";
import { homedir } from "os";
import { parse } from "yaml";
import { z } from "zod";
import { isHarnessId, type HarnessId } from "../ids.js";
import { ActionRunSchema, normalizeActionRun, type ActionRunSpec } from "./action-run-spec.js";
import { LiteralEnvSchema, normalizeLiteralEnv, type LiteralEnvValue } from "../services/literal-env.js";
import { ContractShape, checkContract, normalizeContract, type ContractPreflight, type ContractValidate } from "./work-contract.js";

export type { ActionRunSpec } from "./action-run-spec.js";

const ACTION_FILENAME = "action.yaml";

/**
 * Descriptions land in the actions index injected into every session prompt, so
 * the budget is Barry's to own — cap at parse time rather than ellipsizing a
 * surprise-length description downstream.
 */
const MAX_DESCRIPTION_CHARS = 1024;

function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

/**
 * The prompt, in one of three spellings:
 *
 *   prompt: |            # shorthand — every pre-existing manifest
 *     ...
 *
 *   prompt:              # block, inline
 *     format: markdown
 *     content: ...
 *
 *   prompt:              # block, file reference (relative to the action dir)
 *     format: file
 *     path: wrap-up.md
 *
 * The string shorthand is permanent, not legacy: forcing the block form onto
 * ~100 existing manifests (most in submodule repos) buys nothing — a bare
 * string IS the inline-markdown case, and string|block unions are ordinary
 * manifest vocabulary. `promptFile:` is gone; the file form replaces it.
 *
 * The file form is the skills-interop seam: an action.yaml can point `path` at
 * an existing SKILL.md without modifying it (leading frontmatter is stripped
 * at read time), so pulling a skills repo keeps both worlds working — the file
 * stays a valid skill AND powers the action. The naming standard for new
 * actions is `<action-name>.md`, not SKILL.md.
 */
const PromptBlockSchema = z.discriminatedUnion("format", [
  z.object({ format: z.literal("markdown"), content: z.string().min(1) }).strict(),
  z.object({ format: z.literal("file"), path: z.string().min(1) }).strict(),
]);

const ActionSchema = z
  .object({
    version: z.union([z.string().min(1), z.number()]).optional(),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case"),
    description: z.string().min(1).max(MAX_DESCRIPTION_CHARS),
    /**
     * Which coding agent and model a DETACHED run of this action prefers.
     *
     * `agent` is checked for SHAPE here and for membership when the run
     * starts: harnesses are installed, so whether one exists is a fact about
     * the host the run lands on, not about the bag. Model ids are left
     * unvalidated on purpose — models ship faster than the catalog updates, and
     * the catalog is curated, not enforcing. An unknown id warns at spawn
     * rather than failing the manifest.
     *
     * There is deliberately no third field for z.ai/Ollama. The vendor is
     * DERIVED from the model id when the run is routed; naming it here would
     * be a second spelling of the same fact, free to disagree with the first.
     */
    agent: z
      .object({
        agent: z
          .string()
          .refine(isHarnessId, "a harness id is lowercase letters, digits and dashes")
          .optional(),
        model: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    /** The instructions. See PromptBlockSchema for the three spellings. */
    prompt: z.union([z.string().min(1), PromptBlockSchema]).optional(),
    /**
     * Shared instructions to prepend to this action's prompt, by name.
     *
     * Composition is the reason instructions are a primitive rather than a
     * field: guidance needed by several actions is written once and referenced,
     * instead of copied into each prompt where the copies drift.
     */
    instructions: z.array(z.string().min(1)).optional(),
    /**
     * Child actions this one is composed of, run in declared order.
     *
     * An action with `steps` is a COMPOSITE: its `prompt` stops being the work
     * and becomes the instructions for running the steps together — how to
     * merge their outputs, what to do when one reports nothing, which
     * disagreements between them matter. That prose is required, because a step
     * list with no instructions is a batch, and a batch is something a caller
     * can already write by calling each action in turn.
     *
     * Each entry names an action by bare name or `bag:name`. Existence is NOT
     * checked here: manifests are parsed one directory at a time, and the
     * catalog that could resolve a name is built from the parse results. The
     * check belongs to whoever holds the whole catalog — parsing a composite
     * before its children exist has to stay legal, or bag load order would
     * decide whether a manifest is valid.
     */
    steps: z
      .array(
        z.object({
          action: z.string().min(1),
        }).strict(),
      )
      .min(1)
      .optional(),
    /**
     * Expose this action as a `/name` slash command where the provider has one.
     *
     * Opt-in rather than automatic because a slash command spends two budgets an
     * action otherwise does not: the user's `/` menu, and a global name.
     * `find_actions` can afford to list fifty actions; a menu cannot.
     *
     * The generated command delegates to `begin_action` rather than inlining the
     * prompt. Inlining would be fewer moving parts, but it would skip the run
     * row, instruction composition, requirement warnings, and `validate` — so
     * one action would behave differently depending on how it was invoked, and
     * the open-run listing (`list-action-runs`) would stop seeing the runs it
     * exists to find.
     */
    slash_command: z.boolean().optional(),
    /**
     * Menu subtitle, when `description` is the wrong text for a menu.
     *
     * `description` is written to be MATCHED — it carries the "use when the
     * user says…" phrasing `find_actions` searches, which routinely runs to a
     * paragraph. That paragraph is correct for retrieval and wrong for a `/`
     * menu. Rather than cap `description` (retrieval would get worse) or make
     * the menu wrap, an action with both audiences can serve each.
     *
     * Ignored unless `slash_command` is true; falls back to `description`.
     */
    command_description: z.string().min(1).max(200).optional(),
    /**
     * Argument hint shown during `/` autocomplete, e.g. `[--module=PATH]`.
     *
     * Only the action knows whether it takes arguments and what they mean, so a
     * generated default can only ever be a generic placeholder.
     */
    command_hint: z.string().min(1).max(120).optional(),
    /**
     * `requires`, `preflight`, `validate`, `input_schema`, `output_schema` and
     * `timeout`: the contract actions share with jobs (work-contract.ts).
     * `timeout` bounds a `run:` process, and a detached agent run.
     */
    ...ContractShape,
    /**
     * What caller context the action needs. `session` (the default) means the
     * prompt refers to the calling conversation — wrap-up summarizes "this
     * session" — so it can only run inline. `none` marks the action
     * self-contained: the executor may run it detached in a fresh agent.
     * Defaulting to `session` is the safe direction; a wrongly-`session`
     * action merely stays inline, a wrongly-`none` one confidently
     * summarizes a conversation that does not exist.
     */
    context: z.enum(["session", "none"]).optional(),
    /**
     * The command a PROGRAMMATIC action runs, instead of a prompt an agent
     * follows. See action-run-spec.ts for the two spellings.
     *
     * Barry executes it: inputs arrive as JSON on stdin (and in
     * BARRY_ACTION_INPUTS), exit 0 means complete, and with an output_schema
     * stdout must be JSON matching it. Exclusive with `prompt` — an action is
     * done by an agent or by code, and one that claimed both would leave the
     * reader guessing which ran.
     */
    run: ActionRunSchema.optional(),
    /**
     * Non-secret KEY=VALUE literals for the process. Credential bindings are
     * selected separately through secrets.
     */
    env: LiteralEnvSchema.optional(),
    secrets: SecretNamesSchema.optional(),
    /**
     * A job (`jobs:` in bag.yaml) this action is, offered to agents: `name`
     * (this bag's) or `bag:name[@version]`. The job does the work and owns
     * its contract — its inputs, output and timeout are the action's — so an
     * action can put a bag's code in front of agents without restating it.
     * Exclusive with `prompt` and `run`, and it must name a `node` or
     * `process` job: a job that runs an action back would be a loop.
     */
    job: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const bodies = (["prompt", "run", "job"] as const).filter((field) => a[field] !== undefined);
    if (bodies.length === 0) {
      // Required for composites too, not just prose actions: the prompt IS the
      // instructions for combining the steps, and a step list without them is
      // a batch the caller could have run themselves.
      ctx.addIssue({ code: "custom", message: "`prompt` is required (or `run` for an action Barry executes itself, or `job` for one of a bag's jobs)" });
      return;
    }
    if (bodies.length > 1) {
      ctx.addIssue({ code: "custom", message: `declare only one of \`prompt\`, \`run\` or \`job\`: an action is done by an agent or by code (got ${bodies.join(" and ")})` });
      return;
    }
    if (a.job !== undefined) {
      // The job owns all of these; a second copy here could disagree with it.
      for (const field of ["steps", "instructions", "agent", "env", "secrets", "requires", "input_schema", "output_schema", "timeout", "preflight", "validate"] as const) {
        if (a[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: `\`${field}\` belongs to the job; a \`job:\` action takes it from there` });
        }
      }
      if (a.context === "session") {
        ctx.addIssue({ code: "custom", path: ["context"], message: "a `job:` action has no conversation to need; it is always `context: none`" });
      }
      return;
    }
    if (a.run !== undefined) {
      // Every one of these configures the agent a `run:` action does not have.
      // Accepting them would be a field that parses and does nothing.
      for (const field of ["steps", "instructions", "agent"] as const) {
        if (a[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: `\`${field}\` configures an agent; a \`run:\` action has none` });
        }
      }
      if (a.context === "session") {
        ctx.addIssue({ code: "custom", path: ["context"], message: "a `run:` action has no conversation to need; it is always `context: none`" });
      }
    } else {
      for (const field of ["env", "secrets"] as const) {
        if (a[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: `\`${field}\` sets a \`run:\` process's environment; a prompt action has none` });
        }
      }
    }
  });

export type ActionValidate = ContractValidate;

export type ActionPreflight = ContractPreflight;

export type ActionContext = "session" | "none";

/**
 * One child of a composite action.
 *
 * An object rather than a bare string so a step can grow fields — input
 * mapping, a run-only-if condition — without a breaking format change. Today
 * `action` is the only one, and every step runs.
 */
export type ActionStep = {
  /** Child action, by bare name or `bag:name`. Resolved by the catalog. */
  action: string;
};

/** An action reference split into its parts. `bag` is absent for a bare name. */
export type ActionRef = {
  bag?: string;
  name: string;
};

/**
 * Split an action reference — `name` or `bag:name` — into its parts.
 *
 * The one place this grammar is decoded. It was three: the self-reference check
 * below matched with `endsWith(":" + name)`, the catalog's step resolver
 * branched on `includes(":")`, and a test helper used `split(":").pop()`. Each
 * was correct in isolation, and they would not have stayed agreed — the day a
 * reference is spelled differently, one of them silently stops matching while
 * the others keep working, and the failure surfaces as a composite that parses
 * but never resolves.
 *
 * Splits on the FIRST colon: the bag name is the part that cannot contain one,
 * so a colon inside an action name stays with the name rather than being
 * swallowed as a second separator.
 */
export function parseActionRef(ref: string): ActionRef {
  const sep = ref.indexOf(":");
  if (sep <= 0) return { name: ref };
  return { bag: ref.slice(0, sep), name: ref.slice(sep + 1) };
}

/** An ad-hoc action reference split into its parts. */
export type AdhocActionRef = {
  name: string;
  ownerSessionId: string;
};

/**
 * The full reference to an ad-hoc action: `<name>@<owner-session-id>`.
 *
 * Unlike a bare name, it is unique across sessions, which is what run history
 * and logs need: two sessions each defining `survey-auth` must not share one.
 * `@` rather than a colon because `x:y` already means `bag:name`, and a
 * colon form would read as an action of whichever bag shares its first segment.
 */
export function formatAdhocRef(name: string, ownerSessionId: string): string {
  return `${name}@${ownerSessionId}`;
}

/**
 * Split `<name>@<owner-session-id>`, or return null for any other reference.
 *
 * Decoded here, beside parseActionRef, for the reason that function's comment
 * gives: two decoders of one grammar drift. Action names are kebab-case, so a
 * name can hold neither `@` nor `:`, and the two formats cannot overlap.
 */
export function parseAdhocRef(ref: string): AdhocActionRef | null {
  if (ref.includes(":")) return null;
  const at = ref.indexOf("@");
  if (at <= 0 || at === ref.length - 1) return null;
  return { name: ref.slice(0, at), ownerSessionId: ref.slice(at + 1) };
}

/**
 * The manifest's `agent:` block — which coding agent and model a detached run
 * prefers. Both optional and resolved independently; see the schema for why
 * there is no model-provider field.
 */
export type ActionAgent = {
  agent?: HarnessId;
  model?: string;
};

/**
 * How an action's work is done: by an agent following `prompt`, or by Barry
 * running `run`. A union so every consumer of `prompt` has to say what it does
 * with an action that has none, instead of rendering an empty string.
 */
export type ActionBody =
  | {
      /** Prompt body, already resolved from the file form when that was used. */
      prompt: string;
      run?: undefined;
      job?: undefined;
    }
  | {
      prompt?: undefined;
      run: ActionRunSpec;
      job?: undefined;
      /** Declared env for the process, resolved at run time. */
      env?: LiteralEnvValue[];
      secrets?: string[];

    }
  | {
      prompt?: undefined;
      run?: undefined;
      /** The job this action runs, as written: `name` or `bag:name[@version]`. */
      job: string;
    };

export type ActionManifest = ActionBody & {
  version?: string;
  name: string;
  description: string;
  agent?: ActionAgent;
  /** Run timeout in seconds, when declared. */
  timeout?: number;
  /**
   * JSON Schema for caller-supplied inputs (object root, named properties).
   * Absent = the action takes no declared inputs.
   */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema for the declared output. Absent = the action declares none. */
  outputSchema?: Record<string, unknown>;
  /** Caller-context requirement; `session` unless the manifest says `none`. */
  context: ActionContext;
  /** Names of shared instructions to prepend, in declared order. */
  instructions: string[];
  /**
   * Child actions, in declared order. Empty for an ordinary action — a
   * non-empty array is what makes this one a composite, so callers test length
   * rather than needing a separate flag that could disagree with it.
   */
  steps: ActionStep[];
  /** Expose as a `/name` slash command where the provider supports one. */
  slashCommand: boolean;
  /** Menu subtitle for the slash command. Falls back to `description`. */
  commandDescription?: string;
  /** Argument hint shown during `/` autocomplete. */
  commandHint?: string;
  requires: {
    tools: string[];
    secrets: string[];
    bins: string[];
  };
  /** Pre-run reachability probe. Absent = the action claims nothing. */
  preflight?: ActionPreflight;
  validate?: ActionValidate;
};

type PromptField = string | { format: "markdown"; content: string } | { format: "file"; path: string };

/**
 * Strip a LEADING YAML frontmatter block. Only at offset zero: composed
 * prompts legitimately contain `---` separators mid-document, and eating one
 * of those would silently truncate the body.
 *
 * This is what lets `format: file` point at an existing SKILL.md unmodified —
 * the frontmatter is skill metadata, not prompt text.
 */
function stripLeadingFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  const afterClose = text.indexOf("\n", end + 1);
  return afterClose === -1 ? "" : text.slice(afterClose + 1).replace(/^\s*\n/, "");
}

/** Resolve the three prompt spellings to the prompt body. */
function resolvePrompt(field: PromptField | undefined, actionDir: string, label: string): string {
  if (field === undefined) return "";
  if (typeof field === "string") return field;
  if (field.format === "markdown") return field.content;

  // format: file. The path must stay inside the action dir: an action is the
  // directory, and a prompt reaching outside it would make the action's
  // behavior depend on files its packaging never ships.
  const rel = field.path;
  if (isAbsolute(rel) || normalize(rel).startsWith("..")) {
    throw new Error(`Invalid action ${label}: prompt path must be relative to the action dir: ${rel}`);
  }
  const promptPath = join(resolvePath(actionDir), rel);
  if (!existsSync(promptPath)) {
    throw new Error(`Invalid action ${label}: prompt file not found: ${rel}`);
  }
  return stripLeadingFrontmatter(readFileSync(promptPath, "utf8"));
}

export function findActionFile(actionDir: string): string | null {
  const resolved = resolvePath(actionDir);
  const file = join(resolved, ACTION_FILENAME);
  return existsSync(file) ? file : null;
}

/**
 * Validate an already-parsed action object.
 *
 * Split from parseActionFile for the same reason parseManifest is: an action
 * arriving from a remote bag should get identical strict treatment to one read
 * from disk. `label` only shapes the error message.
 */
export function validateAction(raw: unknown, actionDir: string, label: string): ActionManifest {
  const result = ActionSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid action ${label}: ${issues}`);
  }

  const parsed = result.data;

  let body: ActionBody;
  if (parsed.job !== undefined) {
    body = { job: parsed.job };
  } else if (parsed.run !== undefined) {
    body = {
      run: normalizeActionRun(parsed.run, label),
      ...(parsed.secrets !== undefined ? { secrets: [...new Set(parsed.secrets)] } : {}),
      ...(parsed.env !== undefined ? { env: normalizeLiteralEnv(parsed.env) } : {}),
    };
  } else {
    const prompt = resolvePrompt(parsed.prompt, actionDir, label);
    if (!prompt.trim()) {
      throw new Error(`Invalid action ${label}: prompt is empty`);
    }
    body = { prompt };
  }

  checkContract(parsed, `Invalid action ${label}`);
  // Two step checks are decidable from this manifest alone, so they belong
  // here. Whether a named child EXISTS is not — that needs the whole catalog,
  // and is checked where the catalog is assembled.
  for (const step of parsed.steps ?? []) {
    // Direct self-reference. Deeper cycles (a → b → a) need the catalog and are
    // caught there; this is the spelling a single manifest can be sure about.
    if (parseActionRef(step.action).name === parsed.name) {
      throw new Error(`Invalid action ${label}: step "${step.action}" refers to the action itself`);
    }
  }
  // Two steps are the same child when they could resolve to the same action.
  // A bare name and a qualified one sharing a name half can (`enforce-naming`
  // and `ops:enforce-naming`), so that is the duplicate this catches — it is
  // the doubled report the check exists to prevent. Two DIFFERENT bags sharing
  // a name half cannot (`ops:x` and `other:x` are distinct actions), so those
  // stay legal: comparing name halves alone would reject a valid composite.
  const refs = (parsed.steps ?? []).map((s) => parseActionRef(s.action));
  const duplicateIndex = refs.findIndex(
    (ref, i) =>
      refs.findIndex(
        (other, j) =>
          j < i && other.name === ref.name && (!other.bag || !ref.bag || other.bag === ref.bag),
      ) !== -1,
  );
  const duplicateStep = duplicateIndex === -1 ? undefined : parsed.steps?.[duplicateIndex]?.action;
  if (duplicateStep) {
    // Running one child twice in a composite is indistinguishable from a
    // copy-paste slip, and the cost of being wrong is a doubled report the
    // reader has to reconcile. An action that genuinely needs a child twice can
    // say so when a step grows the fields to make the two calls differ.
    throw new Error(`Invalid action ${label}: step "${duplicateStep}" is listed more than once`);
  }

  return {
    ...(parsed.version !== undefined ? { version: String(parsed.version) } : {}),
    name: parsed.name,
    description: parsed.description,
    ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
    ...body,
    ...normalizeContract(parsed),
    instructions: parsed.instructions ?? [],
    steps: parsed.steps ?? [],
    slashCommand: parsed.slash_command ?? false,
    ...(parsed.command_description ? { commandDescription: parsed.command_description } : {}),
    ...(parsed.command_hint ? { commandHint: parsed.command_hint } : {}),
    // A `run:` action has no conversation to need; defaulting it to
    // `session` would make the executor refuse the one kind of action that
    // can always run detached.
    context: parsed.context ?? (parsed.run !== undefined || parsed.job !== undefined ? "none" : "session"),
  };
}

/** Read and validate `<actionDir>/action.yaml`. */
export function parseActionFile(actionDir: string): ActionManifest {
  const file = findActionFile(actionDir);
  if (!file) throw new Error(`No ${ACTION_FILENAME} in ${actionDir}`);
  const raw = parse(readFileSync(file, "utf8"));
  return validateAction(raw, actionDir, file);
}

/**
 * The longest an ad-hoc action may run, in seconds: the executor's ceiling for
 * a bound a caller supplies. The higher ceiling a bag action's manifest gets
 * exists because a reviewed author chose it; an ad-hoc definition is a caller's
 * request under another name.
 */
export const MAX_ADHOC_TIMEOUT_S = 600;

/**
 * The action.yaml fields an ad-hoc action may set.
 *
 * An allowlist, so a field added to the manifest later stays closed to ad-hoc
 * actions until someone decides it is safe there. An ad-hoc action is written
 * by the session that runs it, and several manifest fields execute things
 * outside that session's bounds.
 */
const ADHOC_ACTION_FIELDS = new Set([
  "version",
  "name",
  "description",
  "prompt",
  "instructions",
  "agent",
  "input_schema",
  "output_schema",
  "context",
  "timeout",
]);

/** Why a manifest field outside the allowlist is refused, where there is more to say. */
const ADHOC_REFUSAL_REASONS: Record<string, string> = {
  run: "it runs a process inside Barry's API, outside this session's bounds",
  secrets: "it configures a `run:` process, which an ad-hoc action cannot have",
  env: "it configures a `run:` process, which an ad-hoc action cannot have",
  vault: "it configures a `run:` process, which an ad-hoc action cannot have",
  preflight: "Barry's API runs it as a shell command, outside this session's bounds",
  validate: "Barry's API runs it as a shell command, outside this session's bounds",
  requires: "an ad-hoc action runs with this session's own tools, so there is nothing to declare",
  steps: "composite ad-hoc actions are not supported",
  job: "it runs one of a bag's jobs, which belong to installed actions",
  slash_command: "slash commands belong to installed actions",
  command_description: "slash commands belong to installed actions",
  command_hint: "slash commands belong to installed actions",
};

/**
 * Validate an action a session defines for itself with `create_action`.
 *
 * A narrower gate in front of the same `validateAction` a file goes through,
 * so an ad-hoc definition is checked exactly as strictly as a shipped one and
 * can be written out as an action.yaml unchanged. The prompt must be inline
 * text, because there is no action directory to read a file from, and
 * `context` is always `none`: the subagent sees nothing of the conversation
 * that defined it.
 */
export function validateAdhocAction(raw: unknown, label: string): ActionManifest & { prompt: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid ad-hoc action ${label}: expected an object of action.yaml fields`);
  }
  const fields = raw as Record<string, unknown>;

  const refusals = Object.keys(fields)
    .filter((key) => !ADHOC_ACTION_FIELDS.has(key))
    .map((key) => `\`${key}\` is not allowed: ${ADHOC_REFUSAL_REASONS[key] ?? "it is not an ad-hoc action field"}`);
  if (refusals.length) {
    throw new Error(`Invalid ad-hoc action ${label}: ${refusals.join("; ")}`);
  }
  if (typeof fields.prompt !== "string") {
    throw new Error(`Invalid ad-hoc action ${label}: \`prompt\` must be the prompt text itself`);
  }
  if (fields.context !== undefined && fields.context !== "none") {
    throw new Error(
      `Invalid ad-hoc action ${label}: \`context\` can only be "none" — ` +
        "the subagent sees nothing of the conversation that defined it",
    );
  }

  const name = typeof fields.name === "string" ? fields.name : "";
  // validateAction requires a description because the catalog index shows
  // one; an ad-hoc action is not indexed, so a caller need not write one.
  const withDefaults = { description: `Ad-hoc action ${name}`.trim(), ...fields, context: "none" };

  // No action dir exists: the prompt is inline, so the dir is never read.
  const manifest = validateAction(withDefaults, "", label);
  if (manifest.prompt === undefined) {
    throw new Error(`Invalid ad-hoc action ${label}: \`prompt\` is required`);
  }
  if (manifest.timeout !== undefined && manifest.timeout > MAX_ADHOC_TIMEOUT_S) {
    throw new Error(
      `Invalid ad-hoc action ${label}: \`timeout\` is ${manifest.timeout}s, over the ${MAX_ADHOC_TIMEOUT_S}s limit`,
    );
  }
  return { ...manifest, prompt: manifest.prompt };
}

/**
 * Actions dirs for a bag — the twin of getSkillsDirs, same shape so both
 * discovery paths stay symmetric.
 */
export function getActionsDirs(bagDir: string): string[] {
  const resolved = resolvePath(bagDir);
  const actionsDir = join(resolved, "actions");
  return existsSync(actionsDir) ? [actionsDir] : [];
}

/** Script files an action ships, relative to its dir. Used for `find_actions` detail. */
export function listActionScripts(actionDir: string): string[] {
  const scriptsDir = join(resolvePath(actionDir), "scripts");
  if (!existsSync(scriptsDir)) return [];
  try {
    return readdirSync(scriptsDir)
      .filter((f) => {
        try {
          return statSync(join(scriptsDir, f)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

export { MAX_DESCRIPTION_CHARS };
