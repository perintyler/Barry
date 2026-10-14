import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, basename, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";

export interface AttachmentRecord {
  id: string;
  sessionId: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
}

/** 25 MB file size ceiling per attachment. */
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * Allowed MIME prefixes and exact types.
 * Covers code, text, documents, images, and common structured data.
 */
export const ALLOWED_MIME_TYPES: readonly string[] = [
  "text/",
  "image/",
  "application/json",
  "application/xml",
  "application/pdf",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/x-yaml",
  "text/yaml",
  "text/x-yaml",
  "application/zip",
  "application/gzip",
  "application/tar",
];

export function isAllowedMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().trim();
  return ALLOWED_MIME_TYPES.some((pattern) =>
    pattern.endsWith("/") ? normalized.startsWith(pattern) : normalized === pattern,
  );
}

export function validateAttachment(file: { name: string; mimeType: string; size: number }):
  | { ok: true }
  | { ok: false; status: number; error: string } {
  if (!file.name || typeof file.name !== "string") {
    return { ok: false, status: 400, error: "Attachment name is required" };
  }
  if (!isAllowedMimeType(file.mimeType)) {
    return {
      ok: false,
      status: 415,
      error: `Unsupported media type: "${file.mimeType}". Permitted types include text, code, images, PDF, and JSON.`,
    };
  }
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Attachment size (${(file.size / (1024 * 1024)).toFixed(1)}MB) exceeds 25MB ceiling`,
    };
  }
  return { ok: true };
}

function sessionAttachmentsDir(sessionId: string): string {
  const root = resolve(barryAppSupportDir(), "attachments");
  const dir = resolve(root, sessionId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !dir.startsWith(root + sep)) {
    throw new Error("Invalid attachment session path: outside attachments root");
  }
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!realpathSync(dir).startsWith(realpathSync(root) + sep)) {
    throw new Error("Attachment session path escapes attachments root");
  }
  return dir;
}

function manifestPath(sessionId: string): string {
  return join(sessionAttachmentsDir(sessionId), "attachments.json");
}

function loadManifest(sessionId: string): Record<string, AttachmentRecord> {
  const file = manifestPath(sessionId);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, AttachmentRecord>;
  } catch {
    return {};
  }
}

function saveManifest(sessionId: string, manifest: Record<string, AttachmentRecord>): void {
  const file = manifestPath(sessionId);
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/**
 * Store an uploaded attachment blob on disk under app support and record its metadata.
 */
export async function saveAttachment(
  sessionId: string,
  file: { name: string; mimeType: string; data: Buffer },
): Promise<AttachmentRecord> {
  const validation = validateAttachment({
    name: file.name,
    mimeType: file.mimeType,
    size: file.data.length,
  });
  if (!validation.ok) {
    const err = Object.assign(new Error(validation.error), { status: validation.status });
    throw err;
  }

  const dir = sessionAttachmentsDir(sessionId);
  const id = `att_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const safeName = basename(file.name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const blobPath = join(dir, `${id}_${safeName}`);

  writeFileSync(blobPath, file.data);

  const record: AttachmentRecord = {
    id,
    sessionId,
    name: file.name,
    mimeType: file.mimeType,
    size: file.data.length,
    path: blobPath,
    createdAt: new Date().toISOString(),
  };

  const manifest = loadManifest(sessionId);
  manifest[id] = record;
  saveManifest(sessionId, manifest);

  return record;
}

/**
 * Read attachment metadata.
 */
export async function getAttachmentMetadata(
  sessionId: string,
  attachmentId: string,
): Promise<AttachmentRecord | null> {
  const manifest = loadManifest(sessionId);
  return manifest[attachmentId] ?? null;
}

/**
 * Read attachment record and binary blob.
 */
export async function getAttachment(
  sessionId: string,
  attachmentId: string,
): Promise<{ meta: AttachmentRecord; data: Buffer } | null> {
  const meta = await getAttachmentMetadata(sessionId, attachmentId);
  if (!meta || !existsSync(meta.path)) return null;
  const data = readFileSync(meta.path);
  return { meta, data };
}

/**
 * List all attachments uploaded for a session.
 */
export async function listAttachments(sessionId: string): Promise<AttachmentRecord[]> {
  const manifest = loadManifest(sessionId);
  return Object.values(manifest);
}
