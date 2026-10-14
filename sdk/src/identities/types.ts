/**
 * Identities as the API serves them: the identity record, the requests that
 * create and update one, the traits it can carry and the bags it can pack.
 * The identities bag validates every write against these, whichever door the
 * write came through.
 */
import { z } from "zod";
import { IdentityAdaptersSchema } from "./adapters.js";
import { ApiWarningSchema } from "../errors.js";

export const IdentitySchema = z.object({
  id: z.int(),
  token: z.string(),
  name: z.string(),
  /** Human-readable label. `name` remains the identifier commands address. */
  displayName: z.string().nullable(),
  bags: z.array(z.string()),
  traits: z.array(z.string()),
  bounds: z.array(z.string()),
  adapters: IdentityAdaptersSchema,
  envKeys: z.array(z.string()),
  /**
   * Per key, where its value resolves from: `file` for a literal in the
   * directory's `.env`, or `keychain` / `vault` for a stored reference.
   *
   * The discriminator only — values never cross this API. A client shows the
   * keys and their provenance and defers setting a secret to
   * `barry vault set-env`, so no secret appears in a response or on screen.
   */
  envSources: z.record(z.string(), z.string()).optional(),
  vaultEmail: z.string().nullable(),
  /** Tool that announces status updates, and optionally where it posts. */
  statusNotify: z.object({ tool: z.string(), target: z.string().optional() }).nullable().optional(),
  /** GitHub App installation this Barry acts through. */
  githubInstallationId: z.int().nullable().optional(),
  isDefault: z.boolean(),
  createdAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  /**
   * Where this Barry's configuration lives: `file` for a directory under
   * `~/.barry/identities/`, `db` for a row in the identities table.
   */
  source: z.enum(["db", "file"]).optional(),
  /** The identity's directory, where its identity.yaml lives; null for a row with none. */
  directory: z.string().nullable().optional(),
  /** Legacy inline restrictions, read-only until doctor names them. */
  bound: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

export const IdentityListResponseSchema = z.object({ identities: z.array(IdentitySchema) }).strict();
export const IdentityResponseSchema = z.object({
  identity: IdentitySchema,
  warnings: z.array(ApiWarningSchema).optional(),
}).strict();
export const EffectiveIdentityResponseSchema = z.object({
  identity: IdentitySchema,
  source: z.enum(["explicit", "repo", "default", "file"]),
  repoRoot: z.string().nullable(),
}).strict();
export const UpdateIdentityRequestSchema = z.object({
  adapters: IdentityAdaptersSchema.nullable().optional(),
  name: z.string().min(1).optional(),
  displayName: z.string().nullable().optional(),
  bags: z.array(z.string()).optional(),
  traits: z.array(z.string()).optional(),
  bounds: z.array(z.string().min(1)).nullable().optional(),
  /** Status-update notifier; null clears it. */
  statusNotify: z.object({ tool: z.string(), target: z.string().optional() }).nullable().optional(),
  /** GitHub App installation id; null clears it. */
  githubInstallationId: z.int().nullable().optional(),
}).strict();
export const CreateIdentityRequestSchema = z.object({
  adapters: IdentityAdaptersSchema.optional(),
  name: z.string().min(1).max(100),
  bags: z.array(z.string()).optional(),
  traits: z.array(z.string()).optional(),
  bounds: z.array(z.string().min(1)).optional(),
  /** Human-readable label. */
  displayName: z.string().optional(),
  /**
   * Where to create this Barry. `file` scaffolds a directory under
   * `~/.barry/identities/`; `db` inserts a identities row. Defaults to `db` so
   * existing clients keep their behaviour.
   */
  source: z.enum(["db", "file"]).optional(),
}).strict();

export const TraitSchema = z.object({
  optional: z.boolean().optional(),
  nativeTools: z.record(z.string(), z.array(z.string())).optional(),
  name: z.string(),
  description: z.string().nullable(),
  access: z.enum(["read", "readwrite"]),
  namespaces: z.array(z.string()),
  /** Skill names granted to sessions carrying this trait (mounted at spawn) */
  skills: z.array(z.string()).optional(),
  /** Individual tool names, where a trait grants tools rather than namespaces. */
  tools: z.array(z.string()).optional(),
  /** Instruction documents a session carrying this trait is given. */
  instructions: z.array(z.string()).optional(),
  /** Inline deny rules contributed to the session's effective bound. */
  bound: z.record(z.string(), z.unknown()).optional(),
  /** Named bounds this trait pulls in. */
  boundNames: z.array(z.string()).optional(),
  /** The bag that declares this trait, for auto-generated ones. */
  bag: z.string().nullable().optional(),
  /** Other traits this one grants too. */
  includes: z.array(z.string()).optional(),
  /** The trait to use instead under a given harness, by harness id. */
  harnessTraits: z.record(z.string(), z.string()).optional(),
}).strict();
export const TraitListResponseSchema = z.object({ traits: z.array(TraitSchema) }).strict();
export const TraitResponseSchema = z.object({ trait: TraitSchema.nullable() }).strict();
/**
 * A hand-authored trait. Deliberately has no `bag` field: staying bag-less is
 * what keeps it safe from `ensureTraits`, which reconciles bag-owned rows on
 * every bag sync.
 */
export const CreateTraitRequestSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().nullable().optional(),
  namespaces: z.array(z.string()).min(1),
  access: z.enum(["read", "readwrite"]),
  skills: z.array(z.string()).optional(),
  instructions: z.array(z.string()).optional(),
  boundNames: z.array(z.string()).optional(),
}).strict();

export const BagInfoSchema = z.object({
  name: z.string(),
  type: z.enum(["local", "remote"]),
  description: z.string().nullable(),
}).strict();
export const AvailableBagsResponseSchema = z.object({ bags: z.array(BagInfoSchema) }).strict();
