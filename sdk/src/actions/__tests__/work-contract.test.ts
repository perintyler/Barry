import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ContractShape, JobRequiresSchema, ActionRequiresSchema, checkContract, normalizeContract } from "../work-contract.js";
import { validateAction, validateAdhocAction } from "../action-manifest.js";

const Contract = z.object(ContractShape).strict();

describe("the work contract", () => {
  it("normalizes the authored spellings to the camelCase Barry reads", () => {
    const raw = Contract.parse({
      requires: { bins: ["uv"] },
      preflight: { command: "true" },
      validate: { command: "true" },
      input_schema: { type: "object", properties: { id: { type: "string" } } },
      output_schema: { type: "string" },
      timeout: "10m",
    });
    expect(normalizeContract(raw)).toEqual({
      requires: { tools: [], secrets: [], bins: ["uv"] },
      preflight: { command: "true" },
      validate: { command: "true" },
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      outputSchema: { type: "string" },
      timeout: 600,
    });
  });

  it("leaves absent fields absent rather than undefined", () => {
    expect(Object.keys(normalizeContract({}))).toEqual(["requires"]);
  });

  it("refuses a non-object input root and a schema that does not compile", () => {
    expect(() => checkContract({ input_schema: { type: "string" } }, "job x")).toThrow(/job x: input_schema must have "type": "object"/);
    expect(() => checkContract({ output_schema: { type: "no-such-type" } }, "job x")).toThrow(/output_schema is not a valid JSON Schema/);
  });

  it("gives labels to jobs only", () => {
    expect(JobRequiresSchema.parse({ labels: { model: "local" } })).toEqual({ labels: { model: "local" } });
    // An action has no placement; a label there would parse and do nothing.
    expect(ActionRequiresSchema.safeParse({ labels: { model: "local" } }).success).toBe(false);
  });

  it("is the contract action.yaml parses", () => {
    const action = validateAction({
      name: "x",
      description: "d",
      run: "run.sh",
      requires: { bins: ["uv"] },
      input_schema: { type: "object" },
      timeout: 30,
    }, "/tmp", "x");
    expect(action.requires).toEqual({ tools: [], secrets: [], bins: ["uv"] });
    expect(action.inputSchema).toEqual({ type: "object" });
    expect(action.timeout).toBe(30);
    expect(() => validateAction({ name: "x", description: "d", prompt: "p", input_schema: { type: "array" } }, "/tmp", "x"))
      .toThrow(/Invalid action x: input_schema must have "type": "object"/);
  });
});

describe("a job: action", () => {
  it("names a job and takes its contract from it", () => {
    const action = validateAction({ name: "name-session", description: "Name a session", job: "sessions:name-session" }, "/tmp", "x");
    expect(action.job).toBe("sessions:name-session");
    expect(action.prompt).toBeUndefined();
    expect(action.context).toBe("none");
  });

  it("refuses a second body, and fields that belong to the job", () => {
    expect(() => validateAction({ name: "x", description: "d", job: "j", prompt: "p" }, "/tmp", "x")).toThrow(/only one of `prompt`, `run` or `job`/);
    expect(() => validateAction({ name: "x", description: "d", job: "j", input_schema: { type: "object" } }, "/tmp", "x")).toThrow(/`input_schema` belongs to the job/);
    expect(() => validateAction({ name: "x", description: "d", job: "j", context: "session" }, "/tmp", "x")).toThrow(/always `context: none`/);
  });

  it("is closed to ad-hoc actions", () => {
    expect(() => validateAdhocAction({ name: "x", prompt: "p", job: "ops:j" }, "x")).toThrow(/`job` is not allowed/);
  });
});
