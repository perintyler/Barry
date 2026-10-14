import { describe, expect, it } from "vitest";
import { mintWorkflowSessionCredential, verifyWorkflowSessionCredential, verifyWorkflowSessionCredentialForSession } from "./workflow-session-credential.js";
import { approveExecutionScope } from "../bounds/execution-scope.js";

const secret = "barry_session_test_secret_with_sufficient_entropy";
const claims = { credentialId: "11111111-1111-4111-8111-111111111111", actorId: 1, identityId: 7, sessionId: "job-review", identity: "identity-stable", scopeFingerprint: "a".repeat(64), expiresAt: 50_000 };

describe("workflow session MCP credentials", () => {
  it("binds one session, identity and frozen scope under a domain-separated signature", () => {
    const token = mintWorkflowSessionCredential(secret, claims, 1_000);
    expect(verifyWorkflowSessionCredential(token, secret, 1_001)).toEqual({ version: 3, ...claims });
    expect(() => verifyWorkflowSessionCredential(token, "other_secret_with_enough_entropy", 1_001)).toThrow("invalid");
  });

  it("rejects malformed claims, expiry, and lifetimes beyond one day", () => {
    expect(() => mintWorkflowSessionCredential(secret, { ...claims, sessionId: "" }, 1_000)).toThrow();
    expect(() => mintWorkflowSessionCredential(secret, { ...claims, expiresAt: 1_000 }, 1_000)).toThrow("expiry");
    expect(() => mintWorkflowSessionCredential(secret, { ...claims, expiresAt: 90_000_000 }, 1_000)).toThrow("expiry");
    const token = mintWorkflowSessionCredential(secret, claims, 1_000);
    expect(() => verifyWorkflowSessionCredential(token, secret, 50_000)).toThrow("expired");
  });

  it("does not accept edits to the payload or signature", () => {
    const token = mintWorkflowSessionCredential(secret, claims, 1_000);
    const [, payload, signature] = token.split(".");
    expect(() => verifyWorkflowSessionCredential(`bws3.${payload.slice(0, -1)}A.${signature}`, secret, 1_001)).toThrow("invalid");
    expect(() => verifyWorkflowSessionCredential(`bws3.${payload}.${"A".repeat(signature.length)}`, secret, 1_001)).toThrow("invalid");
  });

  it("checks the credential against the persisted identity and scope ceiling", async () => {
    const scope = await approveExecutionScope({ identity: "identity-stable", traitNames: [], traits: {}, tools: [], boundByName: async () => undefined });
    const scopedClaims = { ...claims, scopeFingerprint: scope.fingerprint };
    const token = mintWorkflowSessionCredential(secret, scopedClaims, 1_000);
    const record = { id: claims.sessionId, state: "open", ended_at: null, workflow_credential_id: claims.credentialId, user_id: 1, identity_id: 7, metadata: { workflow_scope: scope, workflow_identity_id: 7 } };
    expect(verifyWorkflowSessionCredentialForSession(token, secret, claims.sessionId, record, 1_001)).toMatchObject(scopedClaims);
    expect(() => verifyWorkflowSessionCredentialForSession(token, secret, "another-session", record, 1_001)).toThrow("record binding");
    expect(() => verifyWorkflowSessionCredentialForSession(token, secret, claims.sessionId, { ...record, identity_id: 8 }, 1_001)).toThrow("record binding");
    expect(() => verifyWorkflowSessionCredentialForSession(token, secret, claims.sessionId, { ...record, user_id: 2 }, 1_001)).toThrow("record binding");
    expect(() => verifyWorkflowSessionCredentialForSession(token, secret, claims.sessionId, { ...record, user_id: null }, 1_001)).toThrow("record binding");
    expect(() => verifyWorkflowSessionCredentialForSession(token, secret, claims.sessionId, { ...record, metadata: { ...record.metadata, workflow_scope: { ...scope, tools: { "filesystem:write": "write" } } } }, 1_001)).toThrow("identity or scope");
  });
  it("requires the live run binding and never accepts an earlier token after resume", async () => {
    const scope = await approveExecutionScope({ identity: "identity-stable", traitNames: [], traits: {}, tools: [], boundByName: async () => undefined });
    const token = mintWorkflowSessionCredential(secret, { ...claims, scopeFingerprint: scope.fingerprint }, 1_000);
    const record = { id: claims.sessionId, user_id: 1, identity_id: 7, state: "open", ended_at: null, workflow_credential_id: claims.credentialId, metadata: { workflow_scope: scope, workflow_identity_id: 7 } };
    for (const changed of [{ state: "closed" }, { state: "archived" }, { ended_at: "2026-10-03T00:00:00Z" }, { workflow_credential_id: null }, { workflow_credential_id: "22222222-2222-4222-8222-222222222222" }]) {
      expect(() => verifyWorkflowSessionCredentialForSession(token, secret, claims.sessionId, { ...record, ...changed }, 1_001)).toThrow("record binding");
    }
    expect(() => verifyWorkflowSessionCredential(token.replace(/^bws3/, "bws2"), secret, 1_001)).toThrow("invalid");
    expect(() => mintWorkflowSessionCredential(secret, { ...claims, credentialId: "" }, 1_000)).toThrow();
  });

});
