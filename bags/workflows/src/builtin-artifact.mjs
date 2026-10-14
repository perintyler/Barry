// Self-contained artifact: no imports, ambient clocks, credentials or owner access.
export const definitions = [{
  type: "echo", version: "1",
  *run(input) {
    if (!input || typeof input !== "object" || !("message" in input)) throw new Error("message is required");
    if (input.delayMs) yield { kind: "timer", delayMs: input.delayMs };
    if (input.waitForSignal) yield { kind: "signal", name: "continue", timeoutMs: 86400000 };
    return yield { kind: "activity", type: "echo@1", input: input.message };
  },
}];
export const activities = { "echo@1": async input => input };
