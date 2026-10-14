import { expect, it } from "vitest";
import { isScriptAction, validateActionInputs, type RunnableAction } from "./action-catalog.js";

it("checks required, unknown and undeclared action inputs", () => {
  const action = { name: "test", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
  expect(validateActionInputs(action, { path: "a" })).toEqual([]);
  expect(validateActionInputs(action, {})).not.toEqual([]);
  expect(validateActionInputs(action, { typo: "a" })[0]).toContain("Declared inputs: path");
  expect(validateActionInputs({ name: "test" }, { path: "a" })[0]).toContain("declares no inputs");
});

it("recognizes script actions by their run body", () => {
  expect(isScriptAction({ run: { command: "echo" } } as RunnableAction)).toBe(true);
  expect(isScriptAction({ prompt: "do work" } as RunnableAction)).toBe(false);
});
