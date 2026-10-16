export const definitions = [{
  type: "echo", version: "1",
  *run(input) {
    yield { kind: "timer", delayMs: input.delay_ms };
    const value = yield { kind: "activity", type: "echo", input: input.value };
    if (input.repeat_delay_ms !== undefined) {
      yield { kind: "timer", delayMs: input.repeat_delay_ms };
      return yield { kind: "activity", type: "echo", input: value };
    }
    return value;
  },
}];
export const activities = { echo: async input => input };
