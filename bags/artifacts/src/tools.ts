import { Barry } from "@barry-rocks/sdk";
import { z } from "zod";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ArtifactKindSchema,
  type ArtifactKind,
  type CreateShareInput,
  type UpdateShareInput,
} from "./types.js";
import {
  createArtifact,
  readArtifact,
  listArtifacts,
  searchArtifacts,
  updateArtifactMetadata,
  streamArtifactContent,
  listArtifactShares,
  createArtifactShare,
  updateArtifactShare,
  revokeArtifactShare,
} from "./index.js";

import { artifactLink, artifactWebAddress } from "./links.js";

function inferKindAndMime(filename: string, explicitKind?: ArtifactKind, explicitMime?: string): { kind: ArtifactKind; mimeType: string } {
  const ext = extname(filename).toLowerCase();
  let kind: ArtifactKind = explicitKind ?? "text";
  let mimeType = explicitMime;

  if (!explicitKind) {
    if (ext === ".md") kind = "markdown";
    else if (ext === ".html" || ext === ".htm") kind = "html";
    else if (ext === ".svg") kind = "svg";
    else if (ext === ".csv") kind = "csv";
    else if (ext === ".diff" || ext === ".patch") kind = "diff";
    else if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) kind = "image";
    else if ([".js", ".ts", ".jsx", ".tsx", ".json", ".py", ".rs", ".go", ".c", ".cpp", ".sh", ".yaml", ".yml"].includes(ext)) kind = "code";
    else if ([".zip", ".tar", ".gz", ".bin", ".wasm"].includes(ext)) kind = "binary";
  }

  if (!mimeType) {
    switch (kind) {
      case "markdown": mimeType = "text/markdown"; break;
      case "html": mimeType = "text/html"; break;
      case "svg": mimeType = "image/svg+xml"; break;
      case "csv": mimeType = "text/csv"; break;
      case "diff": mimeType = "text/x-diff"; break;
      case "code": mimeType = ext === ".json" ? "application/json" : "text/plain"; break;
      case "image":
        if (ext === ".png") mimeType = "image/png";
        else if (ext === ".jpg" || ext === ".jpeg") mimeType = "image/jpeg";
        else if (ext === ".gif") mimeType = "image/gif";
        else if (ext === ".webp") mimeType = "image/webp";
        else mimeType = "application/octet-stream";
        break;
      case "binary": mimeType = "application/octet-stream"; break;
      default: mimeType = "text/plain"; break;
    }
  }

  return { kind, mimeType };
}

export const artifactCreate = Barry.Tool({
  namespace: "artifacts",
  access: "write",
  name: "artifact_create",
  description: "Create an artifact from inline text or an authorized local file. Returns artifact metadata and a link served by the artifacts web service.",
  schema: {
    filename: z.string().min(1).max(512).describe("Original filename, e.g. 'summary.md' or 'chart.svg'."),
    text: z.string().optional().describe("Inline text content. Either text or path must be provided."),
    path: z.string().optional().describe("Local file path to import as an artifact."),
    kind: ArtifactKindSchema.optional().describe("Artifact kind (markdown, text, code, html, svg, image, csv, diff, binary)."),
    mimeType: z.string().optional().describe("MIME type. Inferred if omitted."),
    title: z.string().min(1).max(500).optional().describe("Optional human title."),
    tags: z.array(z.string().min(1).max(64)).optional().describe("Optional tags."),
    derivedFrom: z.string().optional().describe("Optional ID of predecessor artifact."),
    idempotencyKey: z.string().optional().describe("Optional idempotency key (generated if omitted)."),
  },
  handler: async ({ filename, text, path, kind: explicitKind, mimeType: explicitMime, title, tags, derivedFrom, idempotencyKey }, context) => {
    if ((text === undefined && !path) || (text !== undefined && path)) {
      throw new Error("Exactly one of 'text' or 'path' must be provided");
    }

    const { kind, mimeType } = inferKindAndMime(filename, explicitKind, explicitMime);
    let stream: AsyncIterable<Uint8Array>;

    if (text !== undefined) {
      const buffer = Buffer.from(text, "utf8");
      async function* generate() { yield buffer; }
      stream = generate();
    } else {
      if (!isAbsolute(path!)) throw new Error("File path must be absolute");
      const info = await stat(path!);
      if (!info.isFile()) throw new Error("Path must be a regular file");
      const nodeStream = createReadStream(path!);
      async function* generate() {
        for await (const chunk of nodeStream) yield chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      }
      stream = generate();
    }

    const record = await createArtifact(
      {
        filename,
        mimeType,
        kind,
        title: title ?? null,
        tags: tags ?? [],
        sessionId: context?.sessionId ?? null,
        derivedFrom: derivedFrom ?? null,
        idempotencyKey: idempotencyKey ?? randomUUID(),
      },
      stream,
    );

    return {
      artifact: record,
      ...artifactLink("link", `/api/v1/identities/${record.identityId}/artifacts/${record.id}`),
    };
  },
});

export const artifactRead = Barry.Tool({
  namespace: "artifacts",
  access: "read",
  name: "artifact_read",
  description: "Read an artifact's metadata and bounded text content or a download reference served by the artifacts web service.",
  schema: {
    id: z.string().min(1).describe("Artifact ID to read."),
    maxBytes: z.number().int().min(1).max(1_048_576).default(65_536).optional().describe("Max text bytes to return in chat response (default 64KB)."),
  },
  handler: async ({ id, maxBytes = 65_536 }) => {
    const artifact = await readArtifact(id);
    const contentLink = artifactLink("contentUrl", `/api/v1/identities/${artifact.identityId}/artifacts/${id}/content`);
    const isTextual = ["markdown", "text", "code", "html", "svg", "csv", "diff"].includes(artifact.content.kind);

    if (isTextual && artifact.content.size <= maxBytes) {
      const { stream } = await streamArtifactContent(id);
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      return { artifact, text, ...contentLink };
    }

    return {
      artifact,
      truncated: isTextual && artifact.content.size > maxBytes,
      ...contentLink,
    };
  },
});

export const artifactList = Barry.Tool({
  namespace: "artifacts",
  access: "read",
  name: "artifact_list",
  description: "List artifacts with cursor pagination and optional filters.",
  schema: {
    limit: z.number().int().min(1).max(100).default(50).optional().describe("Max items to return."),
    kind: ArtifactKindSchema.optional().describe("Filter by artifact kind."),
    sessionId: z.string().optional().describe("Filter by originating session ID."),
    cursor: z.object({ createdAt: z.string(), id: z.string() }).optional().describe("Pagination cursor."),
  },
  handler: async ({ limit, kind, sessionId, cursor }) => {
    const result = await listArtifacts({
      limit: limit ?? 50,
      kind,
      sessionId,
      cursor,
    });
    return { artifacts: result.items, nextCursor: result.nextCursor };
  },
});

export const artifactSearch = Barry.Tool({
  namespace: "artifacts",
  access: "read",
  name: "artifact_search",
  description: "Search artifacts by query match across title, tags, filename and kind.",
  schema: {
    query: z.string().min(1).max(500).describe("Search string to match."),
    limit: z.number().int().min(1).max(100).default(50).optional().describe("Max items to return."),
    kind: ArtifactKindSchema.optional().describe("Filter by artifact kind."),
    cursor: z.object({ createdAt: z.string(), id: z.string() }).optional().describe("Pagination cursor."),
  },
  handler: async ({ query, limit, kind, cursor }) => {
    const result = await searchArtifacts(query, {
      limit: limit ?? 50,
      kind,
      cursor,
    });
    return { query, artifacts: result.items, nextCursor: result.nextCursor };
  },
});

export const artifactUpdate = Barry.Tool({
  namespace: "artifacts",
  access: "write",
  name: "artifact_update",
  description: "Update mutable metadata (title, tags) of an artifact with revision concurrency check.",
  schema: {
    id: z.string().min(1).describe("Artifact ID to update."),
    expectedRevision: z.number().int().positive().describe("Current metadata revision."),
    title: z.string().min(1).max(500).nullable().optional().describe("New title or null to clear."),
    tags: z.array(z.string().min(1).max(64)).optional().describe("New tags list."),
  },
  handler: async ({ id, expectedRevision, title, tags }) => {
    const record = await updateArtifactMetadata({
      id,
      expectedRevision,
      title,
      tags,
    });
    return { metadata: record.metadata };
  },
});

export const artifactShares = Barry.Tool({
  namespace: "artifacts",
  access: "read",
  name: "artifact_shares",
  description: "List active and historical share grants for an artifact.",
  schema: {
    artifactId: z.string().min(1).describe("Artifact ID."),
  },
  handler: async ({ artifactId }) => {
    const shares = await listArtifactShares(artifactId);
    return { shares };
  },
});

export const artifactShare = Barry.Tool({
  namespace: "artifacts",
  access: "write",
  name: "artifact_share",
  description: "Create, update, or revoke a share grant for an artifact.",
  schema: {
    action: z.enum(["create", "update", "revoke"]).describe("Share grant action."),
    artifactId: z.string().optional().describe("Artifact ID (required for create)."),
    shareId: z.string().optional().describe("Share grant ID (required for update/revoke)."),
    expectedRevision: z.number().int().positive().optional().describe("Expected revision (required for update)."),
    expiresInSeconds: z.number().int().min(60).max(30 * 24 * 3600).optional().describe("Expiry duration in seconds."),
    password: z.string().min(1).max(256).nullable().optional().describe("Password protection for the share link."),
    revoked: z.boolean().optional().describe("Revoke or unrevoke flag for update."),
  },
  handler: async ({ action, artifactId, shareId, expectedRevision, expiresInSeconds, password, revoked }) => {
    if (action === "create") {
      if (!artifactId) throw new Error("artifactId is required for share create");
      const input: CreateShareInput = {
        artifactId,
        expiresInSeconds: expiresInSeconds ?? 30 * 24 * 3600,
        password: password ?? undefined,
      };
      const address = artifactWebAddress();
      const result = await createArtifactShare(input);
      return {
        metadata: result.metadata,
        token: result.token,
        shareUrl: `${address}/p/${result.identityId}/${result.token}`,
      };
    }
    if (action === "update") {
      if (!shareId || expectedRevision === undefined) throw new Error("shareId and expectedRevision are required for share update");
      const input: UpdateShareInput = {
        shareId,
        expectedRevision,
        expiresInSeconds,
        password,
        revoked,
      };
      const metadata = await updateArtifactShare(input);
      return { metadata };
    }
    if (action === "revoke") {
      if (!shareId) throw new Error("shareId is required for share revoke");
      await revokeArtifactShare(shareId);
      return { revoked: true, shareId };
    }
    throw new Error(`Unknown action: ${action}`);
  },
});
