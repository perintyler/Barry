import { createArtifact } from "@barry-rocks/artifacts-bag";
import { createHash } from "node:crypto";

export interface PublishInstructionInput {
  name: string;
  description: string;
  content: string;
  source?: string;
  revision?: number;
  tags?: string[];
}

export interface PublishInstructionResult {
  name: string;
  qualifiedName: string;
  revision: number;
  artifactId: string;
  contentHash: string;
  publishedAt: string;
}

/**
 * Explicit instruction publication API.
 *
 * Persists and captures the authored instruction markdown as an immutable,
 * content-addressed artifact with provenance and revision metadata.
 */
export async function publishInstruction(
  input: PublishInstructionInput,
): Promise<PublishInstructionResult> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Instruction name must not be empty.");
  }
  const content = input.content;
  if (!content || !content.trim()) {
    throw new Error("Instruction content must not be empty.");
  }
  const source = input.source ?? "adhoc";
  const contentHash = createHash("sha256").update(content, "utf-8").digest("hex");
  const revision = input.revision ?? 1;
  const idempotencyKey = `instruction:${source}:${name}:${revision}:${contentHash.slice(0, 16)}`;
  const now = new Date().toISOString();

  async function* toStream(bytes: Uint8Array) {
    yield bytes;
  }

  const record = await createArtifact(
    {
      filename: `${name}.md`,
      mimeType: "text/markdown",
      kind: "markdown",
      title: `Instruction: ${name}`,
      tags: ["instruction", name, source, ...(input.tags ?? [])],
      idempotencyKey,
    },
    toStream(Buffer.from(content, "utf-8")),
  );

  return {
    name,
    qualifiedName: `${source}:${name}`,
    revision,
    artifactId: record.id,
    contentHash,
    publishedAt: now,
  };
}
