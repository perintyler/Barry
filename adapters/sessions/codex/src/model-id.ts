/**
 * The id codex is given for a session's model: the model half of its ref.
 *
 * Endpoint and credential routing happen before launch; this function only
 * extracts the model component passed to Codex's selected provider.
 */
import { parseModelRef } from "@barry-rocks/sdk/ids";

export function codexModelId(ref: string): string {
  return parseModelRef(ref)?.model ?? ref;
}
