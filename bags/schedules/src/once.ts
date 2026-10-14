import { BarryError } from "@barry-rocks/sdk";
import { findAction, validateActionInputs } from "@barry-rocks/sdk/internal/actions";
import { loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";
import type { OneOffRequest } from "@barry-rocks/sdk/internal/schedules";
import { createOneOff, IdempotencyConflictError, InputTooLargeError, MAX_INPUT_BYTES } from "./one-offs.js";

/** Validate before accepting durable work; the scheduler validates again at execution. */
export async function scheduleOnce(input: OneOffRequest, identityId?: number) {
  if (Buffer.byteLength(JSON.stringify(input.inputs ?? {})) > MAX_INPUT_BYTES) {
    throw new BarryError("invalid", `inputs are limited to ${MAX_INPUT_BYTES} bytes of JSON`);
  }
  const { bags } = await loadBagRegistrySnapshot();
  const action = await findAction(bags, input.action);
  if (!action) throw new BarryError("not_found", `no action "${input.action}"`);
  const errors = validateActionInputs(action, input.inputs);
  if (errors.length) throw new BarryError("invalid", errors.join(" "));
  if (action.context !== "none") throw new BarryError("invalid", `action "${action.qualifiedName}" needs a calling conversation (context: session)`);
  try {
    return createOneOff({
      bag: action.bag, action: action.qualifiedName, inputs: input.inputs ?? {},
      permissions: { identity: input.identity, identityId, traits: input.traits, bounds: input.bounds },
      dueAt: new Date(input.dueAt),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.timeoutS ? { timeoutS: input.timeoutS } : {}),
      ...(input.retry ? { retryAttempts: input.retry.attempts } : {}),
      createdBy: "api",
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) throw new BarryError("conflict", error.message);
    if (error instanceof InputTooLargeError) throw new BarryError("invalid", error.message);
    throw new BarryError("unavailable", error instanceof Error ? error.message : String(error));
  }
}
