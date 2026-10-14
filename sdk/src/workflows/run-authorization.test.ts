import { expect, it } from "vitest";
import { createRunAuthorization, createRunScopeRefresh, type RunPolicySources } from "./run-authorization.js";
import { authorizeRun } from "./grants.js";
import { resolveExecutionContext } from "../bounds/execution-context.js";
import type { Bound, AgentTrait } from "../bounds/types.js";

it("records and refreshes the original delegation basis without adding identity defaults", async () => {
  const tools = [{ namespace: "documents", toolName: "read", access: "read" as const }];
  const traits: Record<string, AgentTrait> = {
    issuer: { name: "issuer", namespaces: ["documents"], access: "read" },
    reader: { name: "reader", namespaces: ["documents"], access: "read" },
  };
  let bound: Bound | null = null, exists = true;
  const sources: RunPolicySources = {
    catalog: async () => ({ tools, traits }), identity: async id => exists && id === "alice" ? { bound } : undefined,
    boundByName: async () => undefined, mayRunAs: async (principal, identity) => principal === "alice" && (identity === undefined || identity === principal),
    operator: () => false,
  };
  const delegator = await resolveExecutionContext({ identity: "alice", traitNames: ["issuer"], tools, traits, boundByName: sources.boundByName });
  const request = { traits: ["reader"] };
  const grant = await authorizeRun(request, "alice", createRunAuthorization(sources), 100, delegator);
  expect(grant.delegation).toEqual({ identity: "alice", traits: ["issuer"] });
  const refresh = createRunScopeRefresh(sources);
  expect((await refresh(grant.job, grant.authorizer, grant.delegation)).tools).toEqual({ "documents:read": "read" });
  bound = { deniedTools: ["read"] };
  expect((await refresh(grant.job, grant.authorizer, grant.delegation)).tools).toEqual({});
  bound = null; traits.issuer = { ...traits.issuer, namespaces: [] };
  expect((await refresh(grant.job, grant.authorizer, grant.delegation)).tools).toEqual({});
  exists = false;
  await expect(refresh(grant.job, grant.authorizer, grant.delegation)).rejects.toThrow("authorizing identity");
  await expect(createRunAuthorization(sources)(request, "alice", delegator)).rejects.toThrow("authorizing identity");
});
