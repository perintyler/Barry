import { z } from "zod";

const resourceName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/i)
  .max(128);
const resourcePath = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      value
        .split("/")
        .every((part) => /^[a-z0-9][a-z0-9._-]*$/i.test(part) && part !== "." && part !== ".."),
    "unsafe resource path",
  );
export const SnapshotResourceSchema = z.strictObject({
  name: resourceName,
  files: z
    .array(
      z.strictObject({
        path: resourcePath,
        bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(100_000)
    .refine(
      (files) => new Set(files.map((file) => file.path)).size === files.length,
      "duplicate resource file",
    ),
});
export type SnapshotResource = z.infer<typeof SnapshotResourceSchema>;
export const SnapshotManifestSchema = z.strictObject({
  format: z.literal(1),
  node: z.string().min(1),
  identity: z.string().min(1).optional(),
  bag: z.string().min(1),
  store: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  revision: z.string(),
  capturedAt: z.iso.datetime(),
  bytes: z.number().int().nonnegative(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  resources: z
    .array(SnapshotResourceSchema)
    .max(128)
    .refine(
      (resources) => new Set(resources.map((resource) => resource.name)).size === resources.length,
      "duplicate snapshot resource",
    )
    .refine(
      (resources) =>
        resources.reduce((count, resource) => count + resource.files.length, 0) <= 100_000,
      "snapshot resource file limit exceeded",
    )
    .optional(),
});
