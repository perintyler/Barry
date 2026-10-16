/** Installation-owned, nonsecret agent definitions. Never accepted from a work caller. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { workArtifactSchema, workValidationSchema } from "./work-contracts.js";
import { workResourceLimitsSchema } from "./work-resource-broker.js";
import type { WorkArtifactStore, WorkArtifactRef } from "./work-artifacts.js";

const ref = z.string().min(1).max(200), digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes("\0"));
const source = workArtifactSchema.refine(value => value.purpose === "source" && value.owner_identity === null);
/** Initial executable profile deliberately declares one tool-free turn. Its
 * endpoint reservation is accounting; provider budget enforcement is a separate gate. */
export const workAgentProfileSchema = z.strictObject({
  version: z.literal(1), installation: ref, reference: ref.regex(/^[^:@]+:[^:@]+$/), title: z.string().min(1).max(200),
  harness: z.literal("pi"), model: ref, endpoint: z.string().url(),
  generation: z.uuid(), record_hash: digest,
  runtime: z.strictObject({ version: z.literal(1), digest, bytes: z.number().int().positive(), protocol: z.literal(1) }),
  // Static vendor DATA, validated/rebuilt by Sessions before credential delivery.
  provider: z.record(z.string(), z.json()),
  cwd: z.strictObject({ path: absolute, device: z.number().int().nonnegative(), inode: z.number().int().nonnegative() }),
  input_schema: z.record(z.string(), z.json()).optional(), validation: workValidationSchema,
  prompt: z.string().min(1).max(65536), max_turns: z.literal(1), execution_budget_ms: z.number().int().positive().max(600000),
  budget_policy: z.literal("reservation-only"),
  endpoint_resource: ref, max_input_tokens: z.number().int().positive(), max_output_tokens: z.literal(4096), max_cost: z.number().finite().nonnegative(),
  sources: z.array(source).min(2).max(990),
}).superRefine((profile, context) => {
  const url = new URL(profile.endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    context.addIssue({ code: "custom", message: "agent endpoint must be a static credential-free HTTP address" });
  if (new Set(profile.sources.map(item => item.digest)).size !== profile.sources.length
    || !profile.sources.some(item => item.digest === profile.runtime.digest && item.bytes === profile.runtime.bytes))
    context.addIssue({ code: "custom", message: "agent runtime closure is incomplete or duplicated" });
});
export type WorkAgentProfile = z.infer<typeof workAgentProfileSchema>;
export const workAgentCatalogSchema = z.strictObject({
  version: z.literal(1), installation: ref, worker_id: z.uuid(), artifact_root: absolute,
  // One installation-owned SQLite arbiter per shared endpoint. Every owner
  // referencing it opens this exact path and immutable broker/limits identity.
  endpoint_broker: z.strictObject({ id: ref, path: absolute, limits: workResourceLimitsSchema }),
  profiles: z.array(source).min(1).max(100),
}).superRefine((catalog, context) => {
  if (Object.values(catalog.endpoint_broker.limits).some(limit => limit.kind !== "endpoint"))
    context.addIssue({ code: "custom", message: "agent endpoint arbiter may own only endpoints" });
});
export type WorkAgentCatalog = z.infer<typeof workAgentCatalogSchema>;

/** Read private installation configuration without following a replaced leaf or
 * accepting a mutable/incomplete read. Does not confer caller authority. */
export function readWorkAgentConfiguration(path: string): unknown {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error("WorkAgentConfigurationUnavailable");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024 || before.mode & 0o077 || process.getuid && before.uid !== process.getuid())
      throw new Error("WorkAgentConfigurationUnavailable");
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
    const after = fstatSync(fd), current = lstatSync(path);
    if (length !== before.size || after.size !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs
      || current.isSymbolicLink() || current.ino !== after.ino || current.dev !== after.dev || realpathSync(path) !== path)
      throw new Error("WorkAgentConfigurationChanged");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { closeSync(fd); }
}

export interface InstalledWorkAgent { profile: WorkAgentProfile; source: WorkArtifactRef; sources: WorkArtifactRef[] }
/** Validate immutable profile bytes and derive/verify their entire runtime custody.
 * This reads no current catalog and confers no grant or execution authority. */
export function verifyWorkAgentProfile(reference: WorkArtifactRef, artifacts: WorkArtifactStore): InstalledWorkAgent {
  const retainedSource = source.parse(reference);
  const profile = workAgentProfileSchema.parse(JSON.parse(artifacts.verify(retainedSource).toString("utf8")));
  // Derive custody from the verified runtime manifest, rather than trusting
  // a producer-supplied list that could omit one of its nested chunks.
  const manifest = z.object({ version: z.literal(2), protocol: z.literal(1), harness: z.string(), chunks: z.array(z.strictObject({ digest, bytes: z.number().int().nonnegative() })).min(1).max(989),
    files: z.array(z.object({ storage: z.object({ chunk: digest }) })).min(4).max(100000) }).parse(JSON.parse(artifacts.verify(profile.sources.find(item => item.digest === profile.runtime.digest)!).toString("utf8")));
  const expected = new Map([[profile.runtime.digest, profile.runtime.bytes], ...manifest.chunks.map(chunk => [chunk.digest, chunk.bytes] as const)]);
  if (manifest.harness !== profile.harness || expected.size !== manifest.chunks.length + 1 || expected.size !== profile.sources.length
    || profile.sources.some(item => expected.get(item.digest) !== item.bytes || item.media_type !== "application/octet-stream")
    || manifest.files.some(file => !manifest.chunks.some(chunk => chunk.digest === file.storage.chunk))) throw new Error("WorkAgentRuntimeClosureIncomplete");
  for (const reference of profile.sources) artifacts.verify(reference);
  return { profile, source: retainedSource, sources: [...profile.sources, retainedSource] };
}
/** Verify and COPY all captured runtime chunks into the owner's artifact store.
 * The profile/manifest digest alone is never treated as closure custody. */
export function importWorkAgentCatalog(catalog: WorkAgentCatalog, from: WorkArtifactStore, into: WorkArtifactStore): InstalledWorkAgent[] {
  catalog = workAgentCatalogSchema.parse(catalog);
  if (realpathSync(catalog.artifact_root) !== from.root) throw new Error("WorkAgentArtifactRootMismatch");
  const retain = (reference: WorkArtifactRef) => {
    const copied = into.stage(from.verify(reference), reference);
    if (copied.digest !== reference.digest || copied.bytes !== reference.bytes) throw new Error("WorkAgentArtifactChanged");
    into.retainExecutor(copied); return copied;
  };
  const installed = catalog.profiles.map(source => {
    const verified = verifyWorkAgentProfile(source, from), profile = verified.profile;
    if (profile.installation !== catalog.installation || catalog.endpoint_broker.limits[profile.endpoint_resource]?.kind !== "endpoint")
      throw new Error("WorkAgentProfileInstallationMismatch");
    // No publication occurs until every reference has been verified and copied.
    const sources = profile.sources.map(retain); return { profile, source: retain(source), sources: [...sources, source] };
  });
  if (new Set(installed.map(item => item.profile.reference)).size !== installed.length) throw new Error("WorkAgentDefinitionConflict");
  return installed;
}
