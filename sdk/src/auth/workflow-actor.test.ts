import { expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { workflowActorSigner, verifyWorkflowActor } from "./workflow-actor.js";

const key = "test-only-key-with-at-least-thirty-two-bytes";
const context = { identity: "alice", traits: [], bound: null, allowedToolIds: ["workflows:start", "workflows:get"] };
it("binds verified identity, operation, request and expiry", () => {
  const sign = workflowActorSigner(context, key), body = { type: "echo", id: "job", input: null };
  const token = sign("/api/runs", body);
  expect(verifyWorkflowActor(token, key, "/api/runs", body).principal).toBe("alice");
  expect(() => verifyWorkflowActor(token, key, "/api/runs", { ...body, id: "other" })).toThrow();
  expect(() => verifyWorkflowActor(token, key, "/api/runs/other", undefined)).toThrow();
  expect(() => verifyWorkflowActor(token, "different-key-with-thirty-two-bytes", "/api/runs", body)).toThrow();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
  try { expect(() => verifyWorkflowActor(token, key, "/api/runs", body)).toThrow(); } finally { vi.restoreAllMocks(); }
});
it("refuses missing identity, unconfigured signing and operations outside the bound", () => {
  expect(() => workflowActorSigner({ ...context, identity: undefined }, key)("/api/runs")).toThrow();
  expect(() => workflowActorSigner(context, undefined)("/api/runs")).toThrow();
  expect(() => workflowActorSigner(context, key)("/api/runs/job/cancel", {})).toThrow();
});
it("normalizes optional policy fields and refuses oversized header credentials", () => {
  const body = { id: "job", input: null };
  const sign = workflowActorSigner({ ...context, harness: undefined }, key);
  expect(verifyWorkflowActor(sign("/api/runs", body), key, "/api/runs", body).execution).toEqual(context);
  const large = { ...context, allowedToolIds: [...context.allowedToolIds, ...Array.from({ length: 1000 }, (_, index) => `documents:${index}-${"x".repeat(150)}`)] };
  expect(() => workflowActorSigner(large, key)("/api/runs", body)).toThrow();
});
it("maps a malformed payload to the uniform error, not a raw SyntaxError (SDK-15)", () => {
  // A valid signature over a payload that is not JSON must fail the SAME way
  // every other rejection does, rather than leaking a parser error.
  const payload = Buffer.from("not json{").toString("base64url");
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  const token = `${payload}.${signature}`;
  expect(() => verifyWorkflowActor(token, key, "/api/runs", { id: "job", input: null })).toThrow(
    "invalid workflow actor",
  );
});
