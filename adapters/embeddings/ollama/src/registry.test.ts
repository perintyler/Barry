/**
 * The package's registry contract: which vendors this kind serves. A vendor
 * spelled differently here than in `vendors.yaml` shows up here as a missing
 * key rather than as a model that never becomes callable.
 */
import { describe, expect, it } from "vitest";
import { EMBEDDING_FACTORIES } from "./index.js";

describe("the embedding registry", () => {
  it("serves exactly the vendors with embedding call code", () => {
    expect(Object.keys(EMBEDDING_FACTORIES.embedding ?? {})).toEqual(["ollama"]);
    expect(EMBEDDING_FACTORIES.completion).toBeUndefined();
    expect(EMBEDDING_FACTORIES.decision).toBeUndefined();
  });
});
