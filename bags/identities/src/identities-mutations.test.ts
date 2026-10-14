/**
 * The pure parts of the identities routes and operations: how an API request
 * body becomes an identity change, and where the default goes when an
 * identity is removed. The routes themselves are tested end to end in
 * identities.test.ts.
 */
import { describe, expect, it } from "vitest";
import { IdentityChangesSchema } from "@barry-rocks/sdk/internal/identities";
import { identityUpdateOf } from "@barry-rocks/sdk/internal/routes";
import { changesOf } from "./operations/identities.js";
import { nextDefaultIdentity } from "./operations/identity-records.js";

describe("nextDefaultIdentity", () => {
  it("leaves the pointer alone when another identity was removed", () => {
    expect(nextDefaultIdentity("old", "current", ["a", "b"])).toBeUndefined();
  });
  it("hands the pointer to the oldest remaining identity", () => {
    expect(nextDefaultIdentity("old", "old", ["first", "second"])).toBe("first");
  });
  it("clears the pointer when nothing remains", () => {
    expect(nextDefaultIdentity("old", "old", [])).toBeNull();
  });
});

describe("identityUpdateOf, then changesOf", () => {
  const changesFromRequest = (body: Parameters<typeof identityUpdateOf>[0]) => changesOf(identityUpdateOf(body));
  it("maps the API's fields onto identity.yaml's vocabulary", () => {
    expect(changesFromRequest({
      displayName: "Ops", bags: ["linear"], traits: ["reviewer"], bounds: ["readonly"],
      adapters: { codex: { default: true, model: "gpt", mode: "hosted" } }, statusNotify: { tool: "notify" }, githubInstallationId: 9,
    })).toEqual({
      display_name: "Ops", bags: ["linear"], traits: ["reviewer"], bounds: ["readonly"],
      adapters: { codex: { default: true, model: "gpt", mode: "hosted" } }, status_notify: { tool: "notify" }, github: { installationId: 9 },
    });
  });
  it("turns an explicit null into a clear, and leaves an absent field alone", () => {
    expect(changesFromRequest({ githubInstallationId: null, statusNotify: null })).toEqual({ github: null, status_notify: null });
    expect(changesFromRequest({})).toEqual({});
  });
  it("produces only changes the operation's schema accepts", () => {
    const changes = changesFromRequest({ displayName: null, bounds: ["readonly"], adapters: null });
    expect(IdentityChangesSchema.safeParse(changes).success).toBe(true);
  });
});
