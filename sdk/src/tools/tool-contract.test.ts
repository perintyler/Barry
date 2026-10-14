import { expect, it } from "vitest";
import { z } from "zod";
import { toolContractHash } from "./tool-contract.js";

it("fingerprints normalized input/output declarations deterministically", () => {
  const first = toolContractHash({ namespace: "docs", name: "write", access: "write", schema: { title: z.string(), count: z.number().optional() }, outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } });
  const reordered = toolContractHash({ namespace: "docs", name: "write", access: "write", schema: { count: z.number().optional(), title: z.string() }, outputSchema: { properties: { ok: { type: "boolean" } }, type: "object" } });
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(reordered).toBe(first);
});

it("changes when callable authority or schema changes", () => {
  const base = { namespace: "docs", name: "write", access: "write" as const, schema: { title: z.string() } };
  const hash = toolContractHash(base);
  expect(toolContractHash({ ...base, access: "read" })).not.toBe(hash);
  expect(toolContractHash({ ...base, schema: { title: z.string().min(2) } })).not.toBe(hash);
});
