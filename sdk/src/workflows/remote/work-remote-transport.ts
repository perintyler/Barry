import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { boundFingerprint } from "../../bounds/workflow-bounds.js";
import { WorkflowError } from "../errors.js";
import type { WorkOwnerConnection } from "../work-activity-worker.js";
import type {
  WorkArtifactRef,
  WorkArtifactStore,
} from "../work-artifacts.js";
import {
  executionBindingSchema,
  logicalStageEffectKey,
  stageReceiptSchema,
  workArtifactSchema,
  workPlanHash,
} from "../work-contracts.js";
import {
  workExecutionDelegationSchema,
  type WorkExecutionDelegation,
} from "../work-execution-delegation.js";
import { WORKER_CREDENTIAL_PREFIX, WorkerCredentialRejected } from "../worker-client.js";

export type RemoteExecutionStage = z.infer<typeof stageReceiptSchema>["stage"];
export type ExecutionBinding = z.infer<typeof executionBindingSchema>;

export const REMOTE_ARTIFACT_FEATURE = "remote-artifacts-v1" as const;
export const DEFAULT_MAX_REMOTE_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_REMOTE_CHUNK_BYTES = 64 * 1024;

export interface ExecutionAccessV1 {
  readonly version: 1;
  readonly delegation: WorkExecutionDelegation;
  readonly connection: Pick<WorkOwnerConnection, "effect"> & Partial<WorkOwnerConnection>;
  readonly signal: AbortSignal;
  readonly workerInstallation?: string;
}

export interface RemoteStageMetadataV1 {
  readonly stage: RemoteExecutionStage;
  readonly logicalEffectKey: string;
  readonly purpose: WorkArtifactRef["purpose"];
  readonly ownerIdentity: string | null;
  readonly digest: string;
  readonly bytes: number;
  readonly mediaType: string;
}

export interface RemoteArtifactPortV1 {
  download(
    access: ExecutionAccessV1,
    ref: WorkArtifactRef,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>;
  stage(
    access: ExecutionAccessV1,
    metadata: RemoteStageMetadataV1,
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<WorkArtifactRef>;
}

const stageNameSchema = stageReceiptSchema.shape.stage;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const effectKeySchema = z.string().regex(/^eff_[a-f0-9]{64}$/);

export const remoteStageMetadataSchema = z.strictObject({
  stage: stageNameSchema,
  logicalEffectKey: effectKeySchema,
  purpose: workArtifactSchema.shape.purpose,
  ownerIdentity: z.string().min(1).max(200).nullable(),
  digest: sha256Schema,
  bytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1).max(200),
});

export function assertRemoteOwnerUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WorkflowError("WorkRemoteConfigurationInvalid", "Owner URL must be a valid URL.", 400);
  }
  const isLoopbackHttp =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !isLoopbackHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new WorkflowError(
      "WorkRemoteConfigurationInvalid",
      "Remote owner URL must use HTTPS or loopback HTTP without embedded credentials or query strings.",
      400,
    );
  }
  return url;
}

/**
 * Read a private 0600 worker credential file with O_NOFOLLOW and stability checks.
 * Never reads ambient environment variables or follows symlinks.
 */
export function readWorkerCredentialFile(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new WorkflowError(
      "WorkRemoteCredentialUnavailable",
      "Worker credential path must be absolute.",
      403,
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new WorkflowError(
      "WorkRemoteCredentialUnavailable",
      "Worker credential file does not exist.",
      403,
    );
  }
  if (canonical !== path) {
    throw new WorkflowError(
      "WorkRemoteCredentialUnavailable",
      "Worker credential path must not traverse symlinks.",
      403,
    );
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.size <= 0 ||
      before.size > 4096 ||
      (process.getuid && before.uid !== process.getuid())
    ) {
      throw new WorkflowError(
        "WorkRemoteCredentialUnavailable",
        "Worker credential file must be a private 0600 regular file owned by the worker user.",
        403,
      );
    }
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    const leaf = lstatSync(path);
    if (
      length !== before.size ||
      after.ctimeMs !== before.ctimeMs ||
      after.mtimeMs !== before.mtimeMs ||
      after.size !== before.size ||
      leaf.dev !== after.dev ||
      leaf.ino !== after.ino ||
      leaf.isSymbolicLink()
    ) {
      throw new WorkflowError(
        "WorkRemoteCredentialChanged",
        "Worker credential file changed during bounded read.",
        409,
      );
    }
    const value = bytes.subarray(0, length).toString("utf8").trim();
    if (!value.startsWith(WORKER_CREDENTIAL_PREFIX) || !/^\S+$/.test(value)) {
      throw new WorkflowError(
        "WorkRemoteCredentialUnavailable",
        "Worker credential does not carry a valid barry_wk_ prefix.",
        403,
      );
    }
    return value;
  } finally {
    closeSync(fd);
  }
}

export function extractExecutionBinding(delegation: WorkExecutionDelegation): ExecutionBinding {
  const { start } = delegation;
  return executionBindingSchema.parse({
    version: 2,
    owner: start.owner,
    work_id: start.work_id,
    workflow_id: start.workflow_id,
    activity_id: start.activity_id,
    attempt_id: start.attempt_id,
    request_hash: start.request_hash,
    plan_digest: start.plan_digest,
    grant_ref: start.grant_ref,
    grant_revision: start.grant_revision,
    source: start.source,
    execution_fence: start.execution_fence,
    deadline: start.deadline,
  });
}

export function sameExecutionBinding(a: ExecutionBinding, b: ExecutionBinding): boolean {
  return (
    a.version === b.version &&
    a.owner === b.owner &&
    a.work_id === b.work_id &&
    a.workflow_id === b.workflow_id &&
    a.activity_id === b.activity_id &&
    a.attempt_id === b.attempt_id &&
    a.request_hash === b.request_hash &&
    a.plan_digest === b.plan_digest &&
    a.grant_ref === b.grant_ref &&
    a.grant_revision === b.grant_revision &&
    a.execution_fence === b.execution_fence &&
    a.deadline === b.deadline &&
    boundFingerprint(a.source) === boundFingerprint(b.source)
  );
}

/**
 * Validate `ExecutionAccessV1` structure, cryptographic plan/grant binding, deadline,
 * abort signal, and online authority (`connection.effect`).
 * Cached `WorkExecutionDelegation` is never offline launch or transfer permission.
 */
export async function assertExecutionAccessV1(
  access: ExecutionAccessV1,
  options: {
    now?: () => number;
    workerInstallation?: string;
    expectedBinding?: ExecutionBinding;
    requireOnlineAuthority?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<WorkExecutionDelegation> {
  if (!access || access.version !== 1) {
    throw new WorkflowError(
      "WorkExecutionAccessInvalid",
      "ExecutionAccessV1 version 1 is required.",
      400,
    );
  }
  if (access.signal?.aborted || options.signal?.aborted) {
    throw new WorkflowError("WorkExecutionAborted", "Execution access was aborted.", 409);
  }
  const parsed = workExecutionDelegationSchema.safeParse(access.delegation);
  if (!parsed.success) {
    throw new WorkflowError(
      "WorkExecutionDelegationInvalid",
      `Invalid execution delegation: ${parsed.error.issues[0]?.message ?? "schema failure"}.`,
      403,
    );
  }
  const delegation = parsed.data;
  const { start, plan, grant } = delegation;
  if (!start.launch_authorized) {
    throw new WorkflowError(
      "WorkLaunchNotAuthorized",
      "Execution start is not launch-authorized.",
      403,
    );
  }
  if (workPlanHash(plan) !== start.plan_digest) {
    throw new WorkflowError(
      "WorkPlanHashMismatch",
      "Execution plan digest does not match accepted plan.",
      409,
    );
  }
  if (grant.revision !== start.grant_revision || grant.grant_ref !== start.grant_ref) {
    throw new WorkflowError(
      "WorkGrantBindingMismatch",
      "Execution grant revision or ref mismatch.",
      409,
    );
  }
  const binding = extractExecutionBinding(delegation);
  if (options.expectedBinding && !sameExecutionBinding(binding, options.expectedBinding)) {
    throw new WorkflowError(
      "ExecutorBindingConflict",
      "Execution access binding does not match expected binding.",
      409,
    );
  }
  const currentNow = (options.now ?? Date.now)();
  if (currentNow >= start.deadline) {
    throw new WorkflowError("WorkDeadlineExpired", "Execution deadline has expired.", 409);
  }
  if (options.requireOnlineAuthority !== false) {
    const active = await access.connection.effect(start.attempt_id);
    if (!active) {
      throw new WorkflowError(
        "WorkAuthorityFenced",
        "Online owner rejected effect lease for this attempt (fenced, stopped, or expired).",
        409,
      );
    }
  }
  return delegation;
}

/**
 * Collect all immutable input/source/runtime artifacts authorized by the accepted
 * `WorkExecutionDelegation` closure, plus any explicitly verified supplemental closure
 * refs (such as verified agent profile chunks or isolated workspace input bundles).
 */
export function acceptedInputArtifactMap(
  delegation: WorkExecutionDelegation,
  supplementalClosure: readonly WorkArtifactRef[] = [],
): Map<string, WorkArtifactRef> {
  const map = new Map<string, WorkArtifactRef>();
  const add = (ref: WorkArtifactRef | undefined) => {
    if (!ref) return;
    const parsed = workArtifactSchema.parse(ref);
    const existing = map.get(parsed.digest);
    if (
      existing &&
      (existing.bytes !== parsed.bytes ||
        existing.purpose !== parsed.purpose ||
        existing.owner_identity !== parsed.owner_identity ||
        existing.media_type !== parsed.media_type)
    ) {
      throw new WorkflowError(
        "WorkArtifactClosureConflict",
        `Conflicting metadata for closure artifact ${parsed.digest}.`,
        409,
      );
    }
    map.set(parsed.digest, parsed);
  };

  add(delegation.start.source);
  for (const ref of delegation.plan.source_closure) add(ref);
  if (delegation.plan.workspace.kind === "isolated") {
    add(delegation.plan.workspace.input_bundle);
  }
  if (delegation.start.process_program) {
    const prog = delegation.start.process_program;
    add(prog.runtime);
    add(prog.bundle?.source);
    add(prog.commands?.preflight?.runtime);
    add(prog.commands?.postcondition?.runtime);
  }
  if (delegation.start.agent_program) {
    add(delegation.start.agent_program.profile);
  }
  for (const ref of supplementalClosure) add(ref);
  return map;
}

export function assertArtifactInAcceptedClosure(
  delegation: WorkExecutionDelegation,
  ref: WorkArtifactRef,
  supplementalClosure: readonly WorkArtifactRef[] = [],
): WorkArtifactRef {
  const parsed = workArtifactSchema.parse(ref);
  const closure = acceptedInputArtifactMap(delegation, supplementalClosure);
  const expected = closure.get(parsed.digest);
  if (!expected) {
    throw new WorkflowError(
      "WorkArtifactNotInClosure",
      `Artifact ${parsed.digest} is not in the accepted execution source/input closure.`,
      403,
    );
  }
  if (
    expected.bytes !== parsed.bytes ||
    expected.purpose !== parsed.purpose ||
    expected.owner_identity !== parsed.owner_identity ||
    expected.media_type !== parsed.media_type
  ) {
    throw new WorkflowError(
      "WorkArtifactMetadataMismatch",
      `Artifact ${parsed.digest} metadata differs from accepted closure.`,
      409,
    );
  }
  const allowedOwnerIdentity = delegation.start.output_identity ?? delegation.namespace.identity_id;
  if (parsed.owner_identity !== null && parsed.owner_identity !== allowedOwnerIdentity) {
    throw new WorkflowError(
      "WorkArtifactOwnerMismatch",
      `Artifact ${parsed.digest} belongs to unauthorized identity ${parsed.owner_identity}.`,
      403,
    );
  }
  return expected;
}

export function assertStageMetadataForAccess(
  delegation: WorkExecutionDelegation,
  metadata: RemoteStageMetadataV1,
  maxArtifactBytes = DEFAULT_MAX_REMOTE_ARTIFACT_BYTES,
): RemoteStageMetadataV1 {
  const parsed = remoteStageMetadataSchema.parse(metadata);
  const { start, namespace } = delegation;
  const expectedKey = logicalStageEffectKey(
    start.owner,
    start.workflow_id,
    start.activity_id,
    parsed.stage,
  );
  if (parsed.logicalEffectKey !== expectedKey) {
    throw new WorkflowError(
      "WorkStageEffectKeyMismatch",
      `Stage metadata logicalEffectKey ${parsed.logicalEffectKey} does not match expected ${expectedKey}.`,
      409,
    );
  }
  if (parsed.purpose === "source" || parsed.purpose === "input") {
    throw new WorkflowError(
      "WorkStagePurposeForbidden",
      "Workers may not stage new source or input artifacts during execution.",
      403,
    );
  }
  const expectedOwnerIdentity =
    start.output_identity !== undefined ? start.output_identity : namespace.identity_id;
  if (parsed.ownerIdentity !== expectedOwnerIdentity) {
    throw new WorkflowError(
      "WorkStageOwnerIdentityMismatch",
      `Staged artifact ownerIdentity ${String(parsed.ownerIdentity)} must match accepted output_identity ${String(expectedOwnerIdentity)}.`,
      403,
    );
  }
  if (!Number.isSafeInteger(parsed.bytes) || parsed.bytes < 0 || parsed.bytes > maxArtifactBytes) {
    throw new WorkflowError(
      "WorkArtifactSizeExceeded",
      `Artifact size ${parsed.bytes} exceeds maxArtifactBytes (${maxArtifactBytes}).`,
      413,
    );
  }
  return parsed;
}

export async function* verifyByteStream(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  expected: { digest: string; bytes: number; maxBytes?: number; maxChunkBytes?: number },
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array, void, undefined> {
  const maxBytes = expected.maxBytes ?? DEFAULT_MAX_REMOTE_ARTIFACT_BYTES;
  const maxChunkBytes = expected.maxChunkBytes ?? 4 * 1024 * 1024;
  if (expected.bytes < 0 || expected.bytes > maxBytes) {
    throw new WorkflowError(
      "WorkArtifactSizeExceeded",
      `Expected byte length ${expected.bytes} exceeds allowed limit ${maxBytes}.`,
      413,
    );
  }
  const hash = createHash("sha256");
  let total = 0;
  for await (const raw of chunks) {
    if (signal?.aborted) {
      throw new WorkflowError("WorkTransferAborted", "Artifact stream aborted.", 409);
    }
    const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (chunk.byteLength > maxChunkBytes) {
      throw new WorkflowError(
        "WorkArtifactChunkTooLarge",
        `Stream chunk of ${chunk.byteLength} bytes exceeds maxChunkBytes (${maxChunkBytes}).`,
        413,
      );
    }
    total += chunk.byteLength;
    if (total > expected.bytes || total > maxBytes) {
      throw new WorkflowError(
        "WorkArtifactSizeMismatch",
        `Artifact stream exceeded expected byte count (${expected.bytes}).`,
        409,
      );
    }
    hash.update(chunk);
    if (chunk.byteLength > 0) {
      yield chunk;
    }
  }
  if (signal?.aborted) {
    throw new WorkflowError("WorkTransferAborted", "Artifact stream aborted.", 409);
  }
  if (total !== expected.bytes) {
    throw new WorkflowError(
      "WorkArtifactTruncated",
      `Artifact stream truncated: received ${total} of ${expected.bytes} bytes.`,
      409,
    );
  }
  const actualDigest = hash.digest("hex");
  if (actualDigest !== expected.digest) {
    throw new WorkflowError(
      "WorkArtifactDigestMismatch",
      `Artifact stream digest ${actualDigest} does not match expected ${expected.digest}.`,
      409,
    );
  }
}

export interface RemoteArtifactClientOptions {
  readonly ownerUrl: string;
  readonly credential: string | (() => string);
  readonly maxArtifactBytes?: number;
  readonly chunkBytes?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly supplementalClosure?: readonly WorkArtifactRef[];
  readonly now?: () => number;
}

/**
 * HTTP/HTTPS client implementation of `RemoteArtifactPortV1`.
 * Streams verified artifacts from/to the workflow owner's worker artifact endpoint
 * using the worker's scoped `barry_wk_` credential and online execution authority.
 */
export class HttpRemoteArtifactTransport implements RemoteArtifactPortV1 {
  private readonly baseUrl: string;
  private readonly maxArtifactBytes: number;
  private readonly chunkBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RemoteArtifactClientOptions) {
    const parsedUrl = assertRemoteOwnerUrl(options.ownerUrl);
    this.baseUrl = parsedUrl.toString().replace(/\/$/, "");
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_REMOTE_ARTIFACT_BYTES;
    this.chunkBytes = options.chunkBytes ?? DEFAULT_REMOTE_CHUNK_BYTES;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private resolveCredential(): string {
    const raw =
      typeof this.options.credential === "function"
        ? this.options.credential()
        : this.options.credential;
    const trimmed = raw.trim();
    if (!trimmed.startsWith(WORKER_CREDENTIAL_PREFIX) || !/^\S+$/.test(trimmed)) {
      throw new WorkflowError(
        "WorkRemoteCredentialUnavailable",
        "Worker credential must carry the barry_wk_ prefix.",
        403,
      );
    }
    return trimmed;
  }

  private commonHeaders(
    delegation: WorkExecutionDelegation,
    credential: string,
  ): Record<string, string> {
    const binding = extractExecutionBinding(delegation);
    return {
      Authorization: `Bearer ${credential}`,
      "x-barry-remote-feature": REMOTE_ARTIFACT_FEATURE,
      "x-barry-binding-json": Buffer.from(JSON.stringify(binding), "utf8").toString("base64"),
      "x-barry-plan-digest": binding.plan_digest,
    };
  }

  async *download(
    access: ExecutionAccessV1,
    ref: WorkArtifactRef,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const combinedSignal = signal
      ? AbortSignal.any([access.signal, signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.any([access.signal, AbortSignal.timeout(this.timeoutMs)]);
    const delegation = await assertExecutionAccessV1(access, {
      ...(this.options.now ? { now: this.options.now } : {}),
      requireOnlineAuthority: true,
      signal: combinedSignal,
    });
    const verifiedRef = assertArtifactInAcceptedClosure(
      delegation,
      ref,
      this.options.supplementalClosure ?? [],
    );
    if (verifiedRef.bytes > this.maxArtifactBytes) {
      throw new WorkflowError(
        "WorkArtifactSizeExceeded",
        `Artifact ${verifiedRef.digest} (${verifiedRef.bytes} bytes) exceeds maxArtifactBytes (${this.maxArtifactBytes}).`,
        413,
      );
    }
    const credential = this.resolveCredential();
    const binding = extractExecutionBinding(delegation);
    const response = await this.fetchImpl(`${this.baseUrl}/api/worker/artifacts/download`, {
      method: "POST",
      headers: {
        ...this.commonHeaders(delegation, credential),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        feature: REMOTE_ARTIFACT_FEATURE,
        binding,
        plan_digest: binding.plan_digest,
        artifact: verifiedRef,
      }),
      signal: combinedSignal,
    });

    if (response.status === 401 || response.status === 403) {
      const text = await response.text().catch(() => "");
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string };
        if (parsed.code && parsed.code !== "WorkerCredentialRejected") {
          throw new WorkflowError(
            parsed.code,
            parsed.message ?? "Remote artifact access denied.",
            response.status,
          );
        }
      } catch (err) {
        if (err instanceof WorkflowError) throw err;
      }
      throw new WorkerCredentialRejected(response.status);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let code = "WorkRemoteTransferFailed";
      let message = `Remote artifact download failed with HTTP ${response.status}.`;
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string };
        if (parsed.code) code = parsed.code;
        if (parsed.message) message = parsed.message;
      } catch {
        if (text) message = text.slice(0, 300);
      }
      throw new WorkflowError(code, message, response.status);
    }

    const advertisedFeature = response.headers.get("x-barry-remote-feature");
    if (advertisedFeature !== REMOTE_ARTIFACT_FEATURE) {
      throw new WorkflowError(
        "WorkRemoteFeatureUnsupported",
        "Workflow owner does not advertise remote-artifacts-v1.",
        409,
      );
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null && Number(contentLengthHeader) !== verifiedRef.bytes) {
      throw new WorkflowError(
        "WorkArtifactSizeMismatch",
        `Content-Length ${contentLengthHeader} does not match expected ${verifiedRef.bytes}.`,
        409,
      );
    }

    const chunkBytes = this.chunkBytes;
    async function* rawResponseChunks(): AsyncGenerator<Uint8Array, void, undefined> {
      if (!response.body) {
        const buf = new Uint8Array(await response.arrayBuffer());
        for (let offset = 0; offset < buf.byteLength; offset += chunkBytes) {
          yield buf.subarray(offset, Math.min(buf.byteLength, offset + chunkBytes));
        }
        return;
      }
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            for (let offset = 0; offset < value.byteLength; offset += chunkBytes) {
              yield value.subarray(offset, Math.min(value.byteLength, offset + chunkBytes));
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }

    for await (const chunk of verifyByteStream(
      rawResponseChunks(),
      {
        digest: verifiedRef.digest,
        bytes: verifiedRef.bytes,
        maxBytes: this.maxArtifactBytes,
      },
      combinedSignal,
    )) {
      yield chunk;
    }
  }

  async stage(
    access: ExecutionAccessV1,
    metadata: RemoteStageMetadataV1,
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<WorkArtifactRef> {
    const combinedSignal = signal
      ? AbortSignal.any([access.signal, signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.any([access.signal, AbortSignal.timeout(this.timeoutMs)]);
    const delegation = await assertExecutionAccessV1(access, {
      ...(this.options.now ? { now: this.options.now } : {}),
      requireOnlineAuthority: true,
      signal: combinedSignal,
    });
    const verifiedMeta = assertStageMetadataForAccess(delegation, metadata, this.maxArtifactBytes);
    const credential = this.resolveCredential();

    const pieces: Buffer[] = [];
    for await (const chunk of verifyByteStream(
      chunks,
      {
        digest: verifiedMeta.digest,
        bytes: verifiedMeta.bytes,
        maxBytes: this.maxArtifactBytes,
      },
      combinedSignal,
    )) {
      pieces.push(Buffer.from(chunk));
    }
    const payload = Buffer.concat(pieces);

    const response = await this.fetchImpl(`${this.baseUrl}/api/worker/artifacts/stage`, {
      method: "POST",
      headers: {
        ...this.commonHeaders(delegation, credential),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(payload.byteLength),
        "x-barry-stage": verifiedMeta.stage,
        "x-barry-effect-key": verifiedMeta.logicalEffectKey,
        "x-barry-artifact-digest": verifiedMeta.digest,
        "x-barry-artifact-bytes": String(verifiedMeta.bytes),
        "x-barry-artifact-purpose": verifiedMeta.purpose,
        "x-barry-artifact-media-type": verifiedMeta.mediaType,
        "x-barry-artifact-owner-identity":
          verifiedMeta.ownerIdentity === null ? "" : verifiedMeta.ownerIdentity,
      },
      body: payload,
      signal: combinedSignal,
    });

    if (response.status === 401 || response.status === 403) {
      const text = await response.text().catch(() => "");
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string };
        if (parsed.code && parsed.code !== "WorkerCredentialRejected") {
          throw new WorkflowError(
            parsed.code,
            parsed.message ?? "Remote artifact stage denied.",
            response.status,
          );
        }
      } catch (err) {
        if (err instanceof WorkflowError) throw err;
      }
      throw new WorkerCredentialRejected(response.status);
    }

    const text = await response.text();
    if (!response.ok) {
      let code = "WorkRemoteStageFailed";
      let message = `Remote artifact stage failed with HTTP ${response.status}.`;
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string };
        if (parsed.code) code = parsed.code;
        if (parsed.message) message = parsed.message;
      } catch {
        if (text) message = text.slice(0, 300);
      }
      throw new WorkflowError(code, message, response.status);
    }

    const advertisedFeature = response.headers.get("x-barry-remote-feature");
    if (advertisedFeature !== REMOTE_ARTIFACT_FEATURE) {
      throw new WorkflowError(
        "WorkRemoteFeatureUnsupported",
        "Workflow owner does not advertise remote-artifacts-v1 on stage.",
        409,
      );
    }

    const staged = workArtifactSchema.parse(JSON.parse(text));
    if (
      staged.digest !== verifiedMeta.digest ||
      staged.bytes !== verifiedMeta.bytes ||
      staged.purpose !== verifiedMeta.purpose ||
      staged.owner_identity !== verifiedMeta.ownerIdentity ||
      staged.media_type !== verifiedMeta.mediaType
    ) {
      throw new WorkflowError(
        "WorkArtifactMetadataMismatch",
        "Owner returned a staged WorkArtifactRef that does not match verified upload metadata.",
        409,
      );
    }
    return staged;
  }
}

export interface RemoteArtifactServerOptions {
  readonly artifacts: WorkArtifactStore;
  readonly authenticateWorker: (credential: string) => string | null;
  readonly authorizeExecution: (
    workerId: string,
    binding: ExecutionBinding,
    planDigest: string,
  ) => {
    delegation: WorkExecutionDelegation;
    supplementalClosure?: readonly WorkArtifactRef[];
  };
  readonly maxArtifactBytes?: number;
  readonly chunkBytes?: number;
}

/**
 * Loopback / HTTP request handler for `/api/worker/artifacts/download` and `/api/worker/artifacts/stage`.
 * Enforces worker credential authentication, attempt/fence/epoch binding, closure restriction on downloads,
 * and idempotent logicalEffectKey deduplication on stage uploads.
 */
export function createRemoteArtifactHttpHandler(options: RemoteArtifactServerOptions) {
  const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_REMOTE_ARTIFACT_BYTES;
  const chunkBytes = options.chunkBytes ?? DEFAULT_REMOTE_CHUNK_BYTES;
  const stagedByEffectKey = new Map<string, WorkArtifactRef>();

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.byteLength),
      "x-barry-remote-feature": REMOTE_ARTIFACT_FEATURE,
    });
    res.end(payload);
  };

  const readRequestBytes = (req: IncomingMessage, maxBytes: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (chunk: Buffer | Uint8Array) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.byteLength;
        if (total > maxBytes) {
          reject(
            new WorkflowError(
              "WorkArtifactSizeExceeded",
              `Request body exceeds ${maxBytes} bytes.`,
              413,
            ),
          );
          req.destroy();
          return;
        }
        chunks.push(buf);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = req.url ?? "";
    if (
      req.method !== "POST" ||
      (url !== "/api/worker/artifacts/download" && url !== "/api/worker/artifacts/stage")
    ) {
      return false;
    }

    try {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ")) {
        sendJson(res, 401, {
          code: "WorkerCredentialRejected",
          message: "Missing bearer token.",
        });
        return true;
      }
      const token = auth.slice("Bearer ".length).trim();
      if (!token.startsWith(WORKER_CREDENTIAL_PREFIX)) {
        sendJson(res, 401, {
          code: "WorkerCredentialRejected",
          message: "Invalid worker credential prefix.",
        });
        return true;
      }
      const workerId = options.authenticateWorker(token);
      if (!workerId) {
        sendJson(res, 403, {
          code: "WorkerCredentialRejected",
          message: "Revoked or unknown worker credential.",
        });
        return true;
      }

      if (req.headers["x-barry-remote-feature"] !== REMOTE_ARTIFACT_FEATURE) {
        sendJson(res, 409, {
          code: "WorkRemoteFeatureUnsupported",
          message: "Client must request remote-artifacts-v1.",
        });
        return true;
      }

      if (url === "/api/worker/artifacts/download") {
        const rawBody = await readRequestBytes(req, 128 * 1024);
        const parsed = z
          .strictObject({
            version: z.literal(1),
            feature: z.literal(REMOTE_ARTIFACT_FEATURE),
            binding: executionBindingSchema,
            plan_digest: sha256Schema,
            artifact: workArtifactSchema,
          })
          .parse(JSON.parse(rawBody.toString("utf8")));

        const { delegation, supplementalClosure } = options.authorizeExecution(
          workerId,
          parsed.binding,
          parsed.plan_digest,
        );
        const verifiedRef = assertArtifactInAcceptedClosure(
          delegation,
          parsed.artifact,
          supplementalClosure ?? [],
        );
        if (verifiedRef.bytes > maxArtifactBytes) {
          throw new WorkflowError(
            "WorkArtifactSizeExceeded",
            "Requested artifact exceeds size limit.",
            413,
          );
        }
        const bytes = options.artifacts.verify(verifiedRef);
        res.writeHead(200, {
          "Content-Type": verifiedRef.media_type,
          "Content-Length": String(bytes.byteLength),
          "x-barry-remote-feature": REMOTE_ARTIFACT_FEATURE,
          "x-barry-artifact-digest": verifiedRef.digest,
        });
        for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
          res.write(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes)));
        }
        res.end();
        return true;
      }

      // Stage upload path
      const rawBindingB64 = String(req.headers["x-barry-binding-json"] ?? "");
      const binding = executionBindingSchema.parse(
        JSON.parse(Buffer.from(rawBindingB64, "base64").toString("utf8")),
      );
      const planDigest = sha256Schema.parse(String(req.headers["x-barry-plan-digest"] ?? ""));
      const { delegation } = options.authorizeExecution(workerId, binding, planDigest);

      const ownerIdentityHeader = String(req.headers["x-barry-artifact-owner-identity"] ?? "");
      const metadata = assertStageMetadataForAccess(
        delegation,
        {
          stage: stageNameSchema.parse(String(req.headers["x-barry-stage"] ?? "")),
          logicalEffectKey: effectKeySchema.parse(String(req.headers["x-barry-effect-key"] ?? "")),
          purpose: workArtifactSchema.shape.purpose.parse(
            String(req.headers["x-barry-artifact-purpose"] ?? ""),
          ),
          ownerIdentity: ownerIdentityHeader === "" ? null : ownerIdentityHeader,
          digest: sha256Schema.parse(String(req.headers["x-barry-artifact-digest"] ?? "")),
          bytes: Number(req.headers["x-barry-artifact-bytes"]),
          mediaType: String(req.headers["x-barry-artifact-media-type"] ?? ""),
        },
        maxArtifactBytes,
      );

      const payload = await readRequestBytes(req, metadata.bytes);
      if (payload.byteLength !== metadata.bytes) {
        throw new WorkflowError(
          "WorkArtifactTruncated",
          `Stage upload received ${payload.byteLength} of ${metadata.bytes} bytes.`,
          409,
        );
      }
      const actualDigest = createHash("sha256").update(payload).digest("hex");
      if (actualDigest !== metadata.digest) {
        throw new WorkflowError(
          "WorkArtifactDigestMismatch",
          `Stage upload digest ${actualDigest} does not match declared ${metadata.digest}.`,
          409,
        );
      }

      const idempotencySlot = `${binding.owner}:${binding.workflow_id}:${binding.activity_id}:${binding.attempt_id}:${metadata.logicalEffectKey}:${metadata.purpose}`;
      const existing = stagedByEffectKey.get(idempotencySlot);
      if (existing) {
        if (
          existing.digest !== metadata.digest ||
          existing.bytes !== metadata.bytes ||
          existing.owner_identity !== metadata.ownerIdentity ||
          existing.media_type !== metadata.mediaType
        ) {
          throw new WorkflowError(
            "WorkStageEffectConflict",
            "Stage upload conflicts with an already-committed artifact for this logical effect key.",
            409,
          );
        }
        sendJson(res, 200, existing);
        return true;
      }

      const staged = options.artifacts.stage(payload, {
        purpose: metadata.purpose,
        owner_identity: metadata.ownerIdentity,
        media_type: metadata.mediaType,
      });
      options.artifacts.retainExecutor(staged);
      stagedByEffectKey.set(idempotencySlot, staged);
      sendJson(res, 200, staged);
      return true;
    } catch (error) {
      if (error instanceof WorkflowError) {
        sendJson(res, error.status, { code: error.code, message: error.message });
        return true;
      }
      if (error instanceof z.ZodError) {
        sendJson(res, 400, {
          code: "InvalidRequest",
          message: "Invalid remote artifact request.",
        });
        return true;
      }
      sendJson(res, 500, { code: "InternalError", message: "Remote artifact operation failed." });
      return true;
    }
  };
}
