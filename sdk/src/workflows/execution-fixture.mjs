export const definitions = [
  { type: "echo", version: "1", *run(input) { return yield { kind: "activity", type: "echo", input }; } },
  { type: "loop", version: "1", *run() { yield* []; while (true) { /* Deliberately non-yielding application code. */ } } },
  { type: "finish", version: "1", *run(input) { yield* []; return input; } },
  { type: "stuck-activity", version: "1", *run() { return yield { kind: "activity", type: "loop", input: null, attemptTimeoutMs: 5000, heartbeatTimeoutMs: 500 }; } },
];
export const activities = { echo: async input => input, loop: async () => { while (true) { /* Deliberately uncooperative. */ } } };
