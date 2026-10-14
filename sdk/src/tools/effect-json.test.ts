import { expect, it } from "vitest";
import { encodeEffectJson } from "./effect-json.js";
it("rejects values that would lose evidence or exhaust receipt encoding", () => {
  expect(encodeEffectJson({ value: [null, true, 1] })).toBe('{"value":[null,true,1]}');
  for (const value of [undefined, NaN, Infinity, { value: undefined }, new Date(), Array(1)]) expect(() => encodeEffectJson(value)).toThrow();
  const cycle: { value?: unknown } = {}; cycle.value = cycle;
  expect(() => encodeEffectJson(cycle)).toThrow("cycle");
  let nested: unknown = null; for (let index = 0; index < 66; index++) nested = [nested];
  expect(() => encodeEffectJson(nested)).toThrow("nesting");
  expect(() => encodeEffectJson("x".repeat(262_144))).toThrow("payload");
});
