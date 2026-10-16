// The owner retains the exact composed input and execution budget at admission.
export const definitions = [{
  type: "action-agent", version: "1",
  *run(input) {
    if (!input || typeof input !== "object" || typeof input.activity_type !== "string" || !("input" in input) ||
      !Number.isSafeInteger(input.execution_budget_ms) || input.execution_budget_ms <= 0)
      throw new Error("A retained agent dispatch envelope is required");
    return yield { kind: "activity", type: input.activity_type, input: input.input, attemptTimeoutMs: input.execution_budget_ms };
  },
}];
