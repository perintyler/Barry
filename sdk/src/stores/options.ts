import { z } from "zod";

const httpUrl = z.url().refine((value) => {
  const endpoint = new URL(value);
  return (
    ["https:", "http:"].includes(endpoint.protocol) && !endpoint.username && !endpoint.password
  );
}, "expected an HTTP(S) URL without embedded credentials");

export const StoreOptionsSchema = z
  .strictObject({
    engine: z.literal("sqlite").optional(),
    filepath: z
      .string()
      .refine(
        (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
        "store filepath must be absolute",
      )
      .optional(),
    url: z.url().optional(),
    app_url: httpUrl.optional(),
  })
  .superRefine((value, context) => {
    if (value.filepath !== undefined && value.url !== undefined)
      context.addIssue({
        code: "custom",
        message: "store filepath and url are mutually exclusive",
      });
  });

export type StoreOptions = z.infer<typeof StoreOptionsSchema>;

export function mergeStoreOptions(
  parent: StoreOptions = {},
  child: StoreOptions = {},
): StoreOptions {
  const validated = StoreOptionsSchema.parse(child);
  const merged = { ...StoreOptionsSchema.parse(parent), ...validated };
  if (validated.url !== undefined) delete merged.filepath;
  if (validated.filepath !== undefined) delete merged.url;
  return StoreOptionsSchema.parse(merged);
}
