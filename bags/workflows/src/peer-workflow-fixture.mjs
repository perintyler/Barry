export const definitions = [{ type: "effect", version: "1", *run(input) {
  return yield { kind: "activity", type: "effect@1", input, heartbeatTimeoutMs: 2000, attemptTimeoutMs: 5000, retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50 } };
} }];
