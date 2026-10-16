import { createHash } from "node:crypto";
import { WorkflowError } from "../errors.js";
import { verifyWorkAgentProfile, workAgentProfileSchema } from "../work-agent-profile.js";
import type {
  WorkArtifactRef,
  WorkArtifactStore,
} from "../work-artifacts.js";
import { logicalStageEffectKey, workArtifactSchema } from "../work-contracts.js";
import {
  DEFAULT_MAX_REMOTE_ARTIFACT_BYTES,
  DEFAULT_REMOTE_CHUNK_BYTES,
  assertArtifactInAcceptedClosure,
  assertExecutionAccessV1,
  assertStageMetadataForAccess,
  extractExecutionBinding,
  verifyByteStream,
  type ExecutionAccessV1,
  type RemoteArtifactPortV1,
  type RemoteExecutionStage,
  type RemoteStageMetadataV1,
} from "./work-remote-transport.js";

function bufferChunks(
  bytes: Buffer | Uint8Array,
  chunkBytes = DEFAULT_REMOTE_CHUNK_BYTES,
): Uint8Array[] {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength === 0) return [new Uint8Array(0)];
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < view.byteLength; offset += chunkBytes) {
    out.push(view.subarray(offset, Math.min(view.byteLength, offset + chunkBytes)));
  }
  return out;
}

export interface OwnerStoreArtifactPortOptions {
  readonly ownerStore: WorkArtifactStore;
  readonly supplementalClosure?: readonly WorkArtifactRef[];
  readonly maxArtifactBytes?: number;
  readonly chunkBytes?: number;
  readonly now?: () => number;
}

/**
 * Direct owner-store implementation of `RemoteArtifactPortV1` for loopback/in-process
 * orchestration or testing, enforcing identical online authority, closure, stream verification,
 * and idempotent logicalEffectKey deduplication rules as the HTTP transport.
 */
export class OwnerStoreArtifactPort implements RemoteArtifactPortV1 {
  private readonly maxArtifactBytes: number;
  private readonly chunkBytes: number;
  private readonly stagedBySlot = new Map<string, WorkArtifactRef>();
  private readonly dynamicClosure = new Map<string, WorkArtifactRef>();

  constructor(private readonly options: OwnerStoreArtifactPortOptions) {
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_REMOTE_ARTIFACT_BYTES;
    this.chunkBytes = options.chunkBytes ?? DEFAULT_REMOTE_CHUNK_BYTES;
    for (const ref of options.supplementalClosure ?? []) {
      const parsed = workArtifactSchema.parse(ref);
      this.dynamicClosure.set(parsed.digest, parsed);
    }
  }

  allowSupplementalArtifact(ref: WorkArtifactRef): void {
    const parsed = workArtifactSchema.parse(ref);
    this.dynamicClosure.set(parsed.digest, parsed);
  }

  async *download(
    access: ExecutionAccessV1,
    ref: WorkArtifactRef,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const delegation = await assertExecutionAccessV1(access, {
      ...(this.options.now ? { now: this.options.now } : {}),
      requireOnlineAuthority: true,
      ...(signal ? { signal } : {}),
    });
    const verifiedRef = assertArtifactInAcceptedClosure(delegation, ref, [
      ...this.dynamicClosure.values(),
    ]);
    if (verifiedRef.bytes > this.maxArtifactBytes) {
      throw new WorkflowError(
        "WorkArtifactSizeExceeded",
        `Artifact ${verifiedRef.digest} exceeds maxArtifactBytes (${this.maxArtifactBytes}).`,
        413,
      );
    }
    const bytes = this.options.ownerStore.verify(verifiedRef);
    const chunks = bufferChunks(bytes, this.chunkBytes);
    for await (const chunk of verifyByteStream(
      chunks,
      {
        digest: verifiedRef.digest,
        bytes: verifiedRef.bytes,
        maxBytes: this.maxArtifactBytes,
      },
      signal ?? access.signal,
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
    const delegation = await assertExecutionAccessV1(access, {
      ...(this.options.now ? { now: this.options.now } : {}),
      requireOnlineAuthority: true,
      ...(signal ? { signal } : {}),
    });
    const verifiedMeta = assertStageMetadataForAccess(delegation, metadata, this.maxArtifactBytes);
    const pieces: Buffer[] = [];
    for await (const chunk of verifyByteStream(
      chunks,
      {
        digest: verifiedMeta.digest,
        bytes: verifiedMeta.bytes,
        maxBytes: this.maxArtifactBytes,
      },
      signal ?? access.signal,
    )) {
      pieces.push(Buffer.from(chunk));
    }
    const payload = Buffer.concat(pieces);
    const binding = extractExecutionBinding(delegation);
    const slot = `${binding.owner}:${binding.workflow_id}:${binding.activity_id}:${binding.attempt_id}:${verifiedMeta.logicalEffectKey}:${verifiedMeta.purpose}`;
    const existing = this.stagedBySlot.get(slot);
    if (existing) {
      if (
        existing.digest !== verifiedMeta.digest ||
        existing.bytes !== verifiedMeta.bytes ||
        existing.owner_identity !== verifiedMeta.ownerIdentity ||
        existing.media_type !== verifiedMeta.mediaType
      ) {
        throw new WorkflowError(
          "WorkStageEffectConflict",
          "Conflicting artifact staged for identical logicalEffectKey.",
          409,
        );
      }
      return existing;
    }
    const staged = this.options.ownerStore.stage(payload, {
      purpose: verifiedMeta.purpose,
      owner_identity: verifiedMeta.ownerIdentity,
      media_type: verifiedMeta.mediaType,
    });
    this.options.ownerStore.retainExecutor(staged);
    this.stagedBySlot.set(slot, staged);
    return staged;
  }
}

export interface RemoteArtifactCoordinatorOptions {
  readonly localArtifacts: WorkArtifactStore;
  readonly port: RemoteArtifactPortV1;
  readonly supplementalClosure?: readonly WorkArtifactRef[];
  readonly maxArtifactBytes?: number;
  readonly chunkBytes?: number;
  readonly now?: () => number;
}

/**
 * Coordinates content-addressed remote artifact downloads and stage uploads between
 * a remote worker's local `WorkArtifactStore` and the owner's `RemoteArtifactPortV1`.
 */
export class RemoteArtifactCoordinator {
  private readonly maxArtifactBytes: number;
  private readonly chunkBytes: number;
  private readonly dynamicClosure = new Map<string, WorkArtifactRef>();

  constructor(private readonly options: RemoteArtifactCoordinatorOptions) {
    this.maxArtifactBytes =
      options.maxArtifactBytes ??
      Math.min(options.localArtifacts.maxArtifactBytes, DEFAULT_MAX_REMOTE_ARTIFACT_BYTES);
    this.chunkBytes = options.chunkBytes ?? DEFAULT_REMOTE_CHUNK_BYTES;
    for (const ref of options.supplementalClosure ?? []) {
      const parsed = workArtifactSchema.parse(ref);
      this.dynamicClosure.set(parsed.digest, parsed);
    }
  }

  allowSupplementalArtifact(ref: WorkArtifactRef): void {
    const parsed = workArtifactSchema.parse(ref);
    this.dynamicClosure.set(parsed.digest, parsed);
  }

  private hasLocalVerified(ref: WorkArtifactRef): Buffer | null {
    try {
      return this.options.localArtifacts.verify(ref);
    } catch {
      return null;
    }
  }

  async ensureLocalArtifact(
    access: ExecutionAccessV1,
    ref: WorkArtifactRef,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const delegation = await assertExecutionAccessV1(access, {
      ...(this.options.now ? { now: this.options.now } : {}),
      requireOnlineAuthority: true,
      ...(signal ? { signal } : {}),
    });
    const verifiedRef = assertArtifactInAcceptedClosure(delegation, ref, [
      ...this.dynamicClosure.values(),
    ]);
    if (verifiedRef.bytes > this.maxArtifactBytes) {
      throw new WorkflowError(
        "WorkArtifactSizeExceeded",
        `Artifact ${verifiedRef.digest} (${verifiedRef.bytes} bytes) exceeds coordinator limit (${this.maxArtifactBytes}).`,
        413,
      );
    }

    const existing = this.hasLocalVerified(verifiedRef);
    if (existing !== null) {
      this.options.localArtifacts.retainExecutor(verifiedRef);
      return existing;
    }

    const pieces: Buffer[] = [];
    for await (const chunk of verifyByteStream(
      this.options.port.download(access, verifiedRef, signal),
      {
        digest: verifiedRef.digest,
        bytes: verifiedRef.bytes,
        maxBytes: this.maxArtifactBytes,
      },
      signal ?? access.signal,
    )) {
      pieces.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(pieces);
    const staged = this.options.localArtifacts.stage(bytes, {
      purpose: verifiedRef.purpose,
      owner_identity: verifiedRef.owner_identity,
      media_type: verifiedRef.media_type,
    });
    if (staged.digest !== verifiedRef.digest || staged.bytes !== verifiedRef.bytes) {
      throw new WorkflowError(
        "WorkArtifactDigestMismatch",
        `Local CAS stage for ${verifiedRef.digest} produced mismatched metadata.`,
        409,
      );
    }
    this.options.localArtifacts.retainExecutor(staged);
    return this.options.localArtifacts.verify(staged);
  }

  /**
   * Ensure all artifacts in the accepted execution closure (including process source,
   * runtime, bundle, preflight/postcondition command runtimes, or structured-agent
   * profile and all nested runtime chunks) are downloaded and verified in `localArtifacts`.
   */
  async ensureExecutionClosure(
    access: ExecutionAccessV1,
    extraRefs: readonly WorkArtifactRef[] = [],
    signal?: AbortSignal,
  ): Promise<Map<string, Buffer>> {
    const delegation = await assertExecutionAccessV1(access, {
      ...(this.options.now ? { now: this.options.now } : {}),
      requireOnlineAuthority: true,
      ...(signal ? { signal } : {}),
    });
    for (const ref of extraRefs) {
      this.allowSupplementalArtifact(ref);
    }

    const required = new Map<string, WorkArtifactRef>();
    const enqueue = (ref: WorkArtifactRef | undefined) => {
      if (!ref) return;
      const parsed = workArtifactSchema.parse(ref);
      required.set(parsed.digest, parsed);
    };

    enqueue(delegation.start.source);
    for (const ref of delegation.plan.source_closure) enqueue(ref);
    if (delegation.plan.workspace.kind === "isolated") {
      enqueue(delegation.plan.workspace.input_bundle);
    }
    if (delegation.start.process_program) {
      const prog = delegation.start.process_program;
      enqueue(prog.runtime);
      enqueue(prog.bundle?.source);
      enqueue(prog.commands?.preflight?.runtime);
      enqueue(prog.commands?.postcondition?.runtime);
    }
    if (delegation.start.agent_program) {
      enqueue(delegation.start.agent_program.profile);
    }
    for (const ref of extraRefs) enqueue(ref);

    const resolved = new Map<string, Buffer>();
    for (const ref of required.values()) {
      const bytes = await this.ensureLocalArtifact(access, ref, signal);
      resolved.set(ref.digest, bytes);
    }

    if (delegation.start.agent_program) {
      const profileRef = delegation.start.agent_program.profile;
      const profileBytes = resolved.get(profileRef.digest);
      if (!profileBytes) {
        throw new WorkflowError(
          "WorkAgentProfileUnavailable",
          "Agent profile artifact was not resolved.",
          409,
        );
      }
      const parsedProfile = workAgentProfileSchema.parse(
        JSON.parse(profileBytes.toString("utf8")),
      );
      for (const nestedRef of parsedProfile.sources) {
        this.allowSupplementalArtifact(nestedRef);
        if (!resolved.has(nestedRef.digest)) {
          const chunkBytes = await this.ensureLocalArtifact(access, nestedRef, signal);
          resolved.set(nestedRef.digest, chunkBytes);
        }
      }
      verifyWorkAgentProfile(profileRef, this.options.localArtifacts);
    }

    return resolved;
  }

  /**
   * Stage an execution output/log/checkpoint artifact locally in CAS
   * and upload it through `RemoteArtifactPortV1` bound to the exact stage effect key
   * and accepted `output_identity`.
   */
  async stageExecutionArtifact(
    access: ExecutionAccessV1,
    stage: RemoteExecutionStage,
    bytes: Buffer | Uint8Array,
    options: {
      purpose: Exclude<WorkArtifactRef["purpose"], "source" | "input">;
      mediaType: string;
      logicalEffectKey?: string;
      signal?: AbortSignal;
    },
  ): Promise<WorkArtifactRef> {
    const delegation = await assertExecutionAccessV1(access, {
      ...(this.options.now ? { now: this.options.now } : {}),
      requireOnlineAuthority: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (buffer.byteLength > this.maxArtifactBytes) {
      throw new WorkflowError(
        "WorkArtifactSizeExceeded",
        `Stage artifact size ${buffer.byteLength} exceeds coordinator limit (${this.maxArtifactBytes}).`,
        413,
      );
    }
    const digest = createHash("sha256").update(buffer).digest("hex");
    const { start, namespace } = delegation;
    const effectKey =
      options.logicalEffectKey ??
      logicalStageEffectKey(start.owner, start.workflow_id, start.activity_id, stage);
    const ownerIdentity =
      start.output_identity !== undefined ? start.output_identity : namespace.identity_id;
    const metadata: RemoteStageMetadataV1 = {
      stage,
      logicalEffectKey: effectKey,
      purpose: options.purpose,
      ownerIdentity,
      digest,
      bytes: buffer.byteLength,
      mediaType: options.mediaType,
    };
    assertStageMetadataForAccess(delegation, metadata, this.maxArtifactBytes);

    const localStaged = this.options.localArtifacts.stage(buffer, {
      purpose: metadata.purpose,
      owner_identity: metadata.ownerIdentity,
      media_type: metadata.mediaType,
    });
    this.options.localArtifacts.retainExecutor(localStaged);

    const remoteStaged = await this.options.port.stage(
      access,
      metadata,
      bufferChunks(buffer, this.chunkBytes),
      options.signal,
    );
    if (
      remoteStaged.digest !== localStaged.digest ||
      remoteStaged.bytes !== localStaged.bytes ||
      remoteStaged.purpose !== localStaged.purpose ||
      remoteStaged.owner_identity !== localStaged.owner_identity ||
      remoteStaged.media_type !== localStaged.media_type
    ) {
      throw new WorkflowError(
        "WorkArtifactMetadataMismatch",
        "Remote staged artifact reference differs from local CAS artifact reference.",
        409,
      );
    }
    return remoteStaged;
  }
}
