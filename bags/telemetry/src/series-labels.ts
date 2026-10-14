import { z } from "zod";

/**
 * Labels on the `/api/series` query string arrive as a JSON object in the
 * `labels` parameter. BAG-22: this used to be `JSON.parse(...) as Record<...>`,
 * so malformed JSON threw a 500 and non-string values flowed in on an
 * assertion alone. Validate through zod and distinguish three outcomes so the
 * route can answer 400 instead of 500.
 */
const LabelsSchema = z.record(z.string(), z.string());

export type ParseLabelsResult =
  | { ok: true; labels: Record<string, string> | undefined }
  | { ok: false; error: string };

export function parseLabelsParam(raw: string | null): ParseLabelsResult {
  if (raw === null || raw === "") return { ok: true, labels: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "labels must be a JSON object of string values" };
  }

  const result = LabelsSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: "labels must be a JSON object of string values" };
  }
  return { ok: true, labels: result.data };
}
