import { z } from "zod";

export const ArtifactIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const IdentityIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const TimestampSchema = z.iso.datetime({ precision: 3 });
export const ArtifactKindSchema = z.enum(["markdown", "text", "code", "html", "svg", "image", "csv", "diff", "binary"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export const TagsSchema = z.array(z.string().min(1).max(64)).max(32)
  .refine(tags => new Set(tags).size === tags.length, "Tags must be unique").readonly();
function isOriginalFilename(filename: string): boolean {
  return filename !== "." && filename !== ".." && [...filename].every(character => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127 && character !== "/" && character !== "\\";
  });
}
export const ArtifactContentSchema = z.strictObject({
  filename: z.string().min(1).max(512).refine(isOriginalFilename, "Invalid original filename"),
  mimeType: z.string().max(255).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: ArtifactKindSchema,
  createdAt: TimestampSchema,
  creator: z.strictObject({ actorId: z.number().int().positive(), identityId: IdentityIdSchema }).readonly(),
  sessionId: z.string().min(1).max(500).nullable(),
  derivedFrom: ArtifactIdSchema.nullable(),
}).readonly();
export const ArtifactMetadataSchema = z.strictObject({
  title: z.string().min(1).max(500).nullable(), tags: TagsSchema,
  revision: z.number().int().positive(), updatedAt: TimestampSchema,
}).readonly();
export const ArtifactRecordSchema = z.strictObject({
  id: ArtifactIdSchema, identityId: IdentityIdSchema,
  content: ArtifactContentSchema, metadata: ArtifactMetadataSchema,
}).readonly();
export const UpdateArtifactMetadataSchema = z.strictObject({
  id: ArtifactIdSchema, expectedRevision: z.number().int().positive(),
  title: z.string().min(1).max(500).nullable().optional(), tags: TagsSchema.optional(),
}).refine(update => update.title !== undefined || update.tags !== undefined, "A metadata change is required");
export const ArtifactCursorSchema = z.strictObject({ createdAt: TimestampSchema, id: ArtifactIdSchema }).readonly();
export const ArtifactListSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(50), cursor: ArtifactCursorSchema.optional(),
  kind: ArtifactKindSchema.optional(), sessionId: z.string().min(1).max(500).optional(),
  query: z.string().min(1).max(500).optional(),
});
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;
export type ArtifactContent = z.infer<typeof ArtifactContentSchema>;
export type UpdateArtifactMetadata = z.infer<typeof UpdateArtifactMetadataSchema>;
export type ArtifactCursor = z.infer<typeof ArtifactCursorSchema>;
export type ArtifactList = z.infer<typeof ArtifactListSchema>;
export type ArtifactOperation = "artifacts:read" | "artifacts:write" | "artifacts:share";
export const ArtifactGrantSchema = z.strictObject({
  actorId: z.number().int().positive(), identityId: IdentityIdSchema,
  credentialId: z.string().min(1).max(500),
}).readonly();
export type ArtifactGrant = z.infer<typeof ArtifactGrantSchema>;
export type ArtifactErrorCode = "forbidden" | "not_found" | "conflict" | "unavailable" | "too_large";
export class ArtifactError extends Error {
  constructor(readonly code: ArtifactErrorCode) { super(code); this.name = "ArtifactError"; }
}

export const ShareIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const ShareTokenHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ShareGrantRecordSchema = z.strictObject({
  id: ShareIdSchema,
  artifactId: ArtifactIdSchema,
  identityId: IdentityIdSchema,
  tokenHash: ShareTokenHashSchema,
  expiresAt: TimestampSchema,
  revoked: z.boolean(),
  passwordSalt: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
  passwordHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  revision: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).readonly();
export type ShareGrantRecord = z.infer<typeof ShareGrantRecordSchema>;

export const ShareMetadataSchema = z.strictObject({
  id: ShareIdSchema,
  artifactId: ArtifactIdSchema,
  expiresAt: TimestampSchema,
  revoked: z.boolean(),
  hasPassword: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).readonly();
export type ShareMetadata = z.infer<typeof ShareMetadataSchema>;

export const CreateShareInputSchema = z.strictObject({
  artifactId: ArtifactIdSchema,
  expiresInSeconds: z.number().int().min(60).max(30 * 24 * 3600).default(30 * 24 * 3600),
  password: z.string().min(1).max(256).optional(),
});
export type CreateShareInput = z.input<typeof CreateShareInputSchema>;

export const UpdateShareInputSchema = z.strictObject({
  shareId: ShareIdSchema,
  expectedRevision: z.number().int().positive(),
  expiresInSeconds: z.number().int().min(60).max(30 * 24 * 3600).optional(),
  revoked: z.boolean().optional(),
  password: z.string().min(1).max(256).nullable().optional(),
}).refine(u => u.expiresInSeconds !== undefined || u.revoked !== undefined || u.password !== undefined, "A change is required");
export type UpdateShareInput = z.infer<typeof UpdateShareInputSchema>;
