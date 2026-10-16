import { expect, it } from "vitest";
import { createRunAuthorization, createRunBoundRefresh, type RunBoundSources } from "./run-authorization.js";
import { authorizeRun } from "./approvals.js";
import { resolveToolCallBounds } from "../bounds/resolve-bound.js";
import type { Bound } from "../bounds/types.js";

it("records and refreshes the original delegation basis without adding identity defaults", async () => {
  let tools = [{ namespace: "documents", toolName: "read", access: "read" as const }];
  let bound: Bound | null = null, exists = true;
  const sources: RunBoundSources = {
    catalog: async () => ({ tools }), identity: async id => exists && id === "alice" ? { bound } : undefined,
    boundByName: async () => undefined, mayRunAs: async (principal, identity) => principal === "alice" && (identity === undefined || identity === principal),
    operator: () => false,
  };
  const delegator = await resolveToolCallBounds({ identity: "alice", bags: ["documents"], tools, boundByName: sources.boundByName });
  const request = { bags: ["documents"] };
  const grant = await authorizeRun(request, "alice", createRunAuthorization(sources), 100, delegator);
  expect(grant.delegation).toEqual({ identity: "alice", bags: ["documents"], bounds: [], traits: [] });
  const refresh = createRunBoundRefresh(sources);
  expect((await refresh(grant.job, grant.authorizer, grant.delegation)).tools).toEqual({ "documents:read": "read" });
  bound = { tools: { deny: ["*:read"] } };
  expect((await refresh(grant.job, grant.authorizer, grant.delegation)).tools).toEqual({});
  bound = null; tools = [];
  expect((await refresh(grant.job, grant.authorizer, grant.delegation)).tools).toEqual({});
  exists = false;
  await expect(refresh(grant.job, grant.authorizer, grant.delegation)).rejects.toThrow("authorizing identity");
  await expect(createRunAuthorization(sources)(request, "alice", delegator)).rejects.toThrow("authorizing identity");
});
