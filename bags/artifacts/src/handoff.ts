import { createArtifact, createArtifactShare, type CreateArtifactInput } from "./index.js";
import type { ArtifactRecord, ShareMetadata } from "./types.js";
import { createHash } from "node:crypto";

export interface PublishHandoffInput {
  title: string;
  markdown: string;
  summary?: string;
  sessionId?: string;
  tags?: string[];
  share?: boolean | { expiresInSeconds?: number; password?: string };
}

export interface PublishHandoffResult {
  artifact: ArtifactRecord;
  share?: { metadata: ShareMetadata; token: string };
}

/**
 * In-code handoff publisher: allows sessions and producers to publish a completed
 * handoff document as an immutable artifact with an optional share grant, avoiding
 * an extra tool round-trip.
 */
export async function publishHandoff(
  input: PublishHandoffInput,
  options?: {
    signal?: AbortSignal;
    actorId?: number;
    credentialId?: string;
  },
): Promise<PublishHandoffResult> {
  const title = input.title.trim();
  if (!title) {
    throw new Error("Handoff title must not be empty.");
  }
  const markdown = input.markdown;
  if (!markdown || !markdown.trim()) {
    throw new Error("Handoff markdown content must not be empty.");
  }

  const hash = createHash("sha256").update(markdown, "utf8").digest("hex");
  const idempotencyKey = `handoff:${input.sessionId ?? "session"}:${title}:${hash.slice(0, 16)}`;

  async function* toStream(bytes: Uint8Array) {
    yield bytes;
  }

  const artifactInput: CreateArtifactInput = {
    filename: `${title.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}.md`,
    mimeType: "text/markdown",
    kind: "markdown",
    title,
    tags: ["handoff", ...(input.tags ?? [])],
    idempotencyKey,
    sessionId: input.sessionId ?? null,
  };

  const artifact = await createArtifact(artifactInput, toStream(Buffer.from(markdown, "utf8")), options);

  let share: { metadata: ShareMetadata; token: string } | undefined;
  if (input.share) {
    const shareOpts = typeof input.share === "object" ? input.share : {};
    share = await createArtifactShare(
      {
        artifactId: artifact.id,
        expiresInSeconds: shareOpts.expiresInSeconds,
        password: shareOpts.password,
      },
      options,
    );
  }

  return { artifact, share };
}
