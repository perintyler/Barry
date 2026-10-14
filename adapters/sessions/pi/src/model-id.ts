/**
 * A model ref as pi names models: `provider/model`, the whole ref.
 *
 * pi connects to providers itself, so like opencode there is no bare-id form
 * to translate: a ref that names no provider is not pi's spelling, and
 * guessing a provider for it would start a session on a vendor nobody chose.
 */
import { modelRef, parseModelRef } from "@barry-rocks/sdk/ids";

export class ModelRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRefused";
  }
}

/** The provider and model pi will be asked for, or a refusal naming the ref. */
export function piModel(ref: string): { provider: string; model: string } {
  const parsed = parseModelRef(ref);
  if (!parsed) {
    throw new ModelRefused(
      `pi names models provider/model; "${ref}" names no provider, so no pi session can run it`,
    );
  }
  return { provider: parsed.vendor, model: parsed.model };
}

/** For tests that need a valid ref without caring which. */
export function asModelRef(provider: string, model: string): ReturnType<typeof modelRef> {
  return modelRef(provider, model);
}
