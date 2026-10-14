import { validateAgainstSchema } from "@barry-rocks/sdk/bags";
import type { ActionRunOutputType } from "./action-runs.js";

/**
 * Check a supplied output against the run's snapshotted contract and decide
 * how it is stored.
 *
 * The param is always a string (tool params are), but the contract may want a
 * string OR a JSON value. The rule, in order:
 *
 * 1. Validate the raw string. A markdown report against `{type: string}`
 *    passes here and stores as `text`. Checked FIRST so a report that happens
 *    to also parse as JSON (say, the single line `42`) is not mis-stored as a
 *    number.
 * 2. Otherwise parse as JSON and validate the parsed value; stores as `json`
 *    (the serialized form as given — the column is TEXT).
 * 3. Otherwise the call is malformed: throw with the more informative error
 *    set so the agent can fix and retry.
 */
export function resolveOutput(
  schema: Record<string, unknown>,
  output: string,
): { type: ActionRunOutputType; value: string } {
  const asString = validateAgainstSchema(schema, output);
  if (asString.ok) return { type: "text", value: output };

  let parsed: unknown;
  let parseFailed = false;
  try {
    parsed = JSON.parse(output);
  } catch {
    parseFailed = true;
  }
  if (!parseFailed) {
    const asJson = validateAgainstSchema(schema, parsed);
    if (asJson.ok) return { type: "json", value: output };
    throw new Error(
      `output does not conform to the action's declared output_schema: ${asJson.errors.join("; ")}`,
    );
  }
  throw new Error(
    `output does not conform to the action's declared output_schema: ${asString.errors.join("; ")}`,
  );
}
