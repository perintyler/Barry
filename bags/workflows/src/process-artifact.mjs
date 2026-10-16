// Owner-created envelope keeps dispatch metadata separate from application input.
// A separate version preserves any retained direct-input action-script@1 artifact.
export const definitions = [{
  type: "action-script", version: "2",
  *run(input) {
    if (!input || typeof input !== "object" || typeof input.activity_type !== "string" || !("input" in input) ||
        !Number.isSafeInteger(input.execution_budget_ms) || input.execution_budget_ms <= 0)
      throw new Error("A retained script dispatch envelope is required");
    return yield { kind: "activity", type: input.activity_type, input: input.input, attemptTimeoutMs: input.execution_budget_ms };
  },
}];
