import { describe, expect, it } from "vitest";
import { AuthPrincipalSchema, InstallationPrincipalSchema, DevicePrincipalSchema, DeviceScopesSchema, IdentityGrantsSchema, hasIdentityGrant, hasScope } from "./principal.js";

describe("verified principal contracts", () => {
  it("validates installation ownership without accepting device-shaped operator authority", () => {
    const principal = InstallationPrincipalSchema.parse({ kind: "installation", actorId: 1, credentialId: "installation" });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(hasScope(principal, "sessions:write")).toBe(true);
    expect(AuthPrincipalSchema.safeParse({ ...principal, scopes: ["admin"] }).success).toBe(false);
    expect(AuthPrincipalSchema.safeParse({ ...principal, actorId: 0 }).success).toBe(false);
    expect(AuthPrincipalSchema.safeParse({ ...principal, credentialId: "device-token" }).success).toBe(false);
  });
  it("retains only explicit device scope and identity grants", () => {
    const principal = DevicePrincipalSchema.parse({ kind: "device", credentialId: "fixture", actorId: 1, scopes: ["sessions:read"], identityIds: [1] });
    expect(hasScope(principal, "sessions:read")).toBe(true);
    expect(hasScope(principal, "sessions:turn")).toBe(false);
    expect(hasIdentityGrant(principal, 1)).toBe(true);
    expect(hasIdentityGrant(principal, 2)).toBe(false);
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.scopes)).toBe(true);
    expect(Object.isFrozen(principal.identityIds)).toBe(true);
  });

  it("does not allow wildcard/admin/unknown scopes or incomplete share authority", () => {
    for (const scopes of [["admin"], ["*"], ["sessions:*"], ["artifacts:share"], [], ["sessions:read", "sessions:read"]]) {
      expect(DeviceScopesSchema.safeParse(scopes).success).toBe(false);
    }
    expect(DeviceScopesSchema.safeParse(["artifacts:read", "artifacts:share"]).success).toBe(true);
  });

  it("requires bounded unique positive identity grants", () => {
    for (const ids of [[], [0], [-1], [1.5], [1, 1], [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: 65 }, (_, i) => i + 1)]) {
      expect(IdentityGrantsSchema.safeParse(ids).success).toBe(false);
    }
    expect(IdentityGrantsSchema.safeParse([1, 1_000_000_000]).success).toBe(true);
  });
});
