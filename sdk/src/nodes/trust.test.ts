import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NodeRegistry } from "./registry.js";
import { decodeJoinToken, encodeJoinToken } from "./join-token.js";

it("expires unused invites at 24 hours, keeps joined credentials, scopes jobs and audits lifecycle", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-trust-"));
  let now = 1_700_000_000_000;
  const registry = new NodeRegistry(root, () => now);
  try {
    const expired = registry.inviteWorker("expired");
    const { worker, credential } = registry.inviteWorker("scoped", ["sessions:summarize-session@1"]);
    expect(registry.permitsJob(worker.id, "sessions:summarize-session@1")).toBe(true);
    expect(registry.permitsJob(worker.id, "other:job@1")).toBe(false);
    registry.recordHello(worker.id, false);
    now += 86_400_000;
    expect(registry.authenticate(expired.credential)).toBeNull();
    expect(registry.authenticate(credential)).toBe(worker.id);
    const rotated = registry.rotateCredential(worker.id);
    now += 299_000;
    expect(registry.authenticate(credential)).toBe(worker.id);
    now += 2000;
    expect(registry.authenticate(credential)).toBeNull();
    expect(registry.authenticate(rotated.secret)).toBe(worker.id);
    registry.recordHello(worker.id, true);
    registry.revokeWorker(worker.id);
    expect(registry.authenticate(rotated.secret)).toBeNull();
    const audit = registry.audits().filter(row => row.workerId === worker.id);
    expect(audit.map(row => row.event)).toEqual(["invite", "join", "rotate", "session-takeover", "revoke"]);
    expect(audit.map(row => row.caller)).toEqual(["local-operator", worker.id, "local-operator", worker.id, "local-operator"]);
    expect(audit.map(row => row.time)).toEqual([1_700_000_000_000, 1_700_000_000_000, 1_700_086_400_000, now, now]);
  } finally { registry.close(); rmSync(root, { recursive: true, force: true }); }
});

it("accepts v1 for compatibility and carries v2 scopes and expiry without granting extra authority", () => {
  const token = { v: 2 as const, owner: "owner", worker: "worker", name: "name", url: "https://owner.example", credential: `barry_wk_${"x".repeat(43)}`, jobs: ["sessions:job@1"], expiresAt: 1_800_000_000_000 };
  expect(decodeJoinToken(encodeJoinToken(token))).toEqual(token);
  const legacy = { owner: token.owner, worker: token.worker, name: token.name, url: token.url, credential: token.credential };
  expect(decodeJoinToken(encodeJoinToken({ ...legacy, v: 1 })).v).toBe(1);
  expect(() => encodeJoinToken({ ...token, v: 1 })).toThrow();
});

it("preserves explicit nonexpiring legacy invites while validating requested expiry", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-legacy-trust-"));
  let now = 1_700_000_000_000;
  const registry = new NodeRegistry(root, () => now);
  try {
    const legacy = registry.inviteWorker("legacy", null, "local-operator", null);
    const expiring = registry.inviteWorker("expiring", null, "local-operator", 5000);
    expect(legacy.worker.inviteExpiresAt).toBeNull();
    expect(expiring.worker.inviteExpiresAt).toBe(now + 5000);
    for (const expiry of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) expect(() => registry.inviteWorker("invalid", null, "local-operator", expiry)).toThrow(/expiry/);
    now += 86_400_000 * 2;
    expect(registry.authenticate(legacy.credential)).toBe(legacy.worker.id);
    expect(registry.authenticate(expiring.credential)).toBeNull();
    const rotated = registry.rotateCredential(legacy.worker.id);
    expect(registry.worker(legacy.worker.id).inviteExpiresAt).toBeNull();
    expect(registry.authenticate(rotated.secret)).toBe(legacy.worker.id);
  } finally { registry.close(); rmSync(root, { recursive: true, force: true }); }
});

it("refuses unprintable expiry dates before worker, credential or audit mutation and pins the invite clock", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-expiry-range-"));
  let now = 1_700_000_000_000;
  const registry = new NodeRegistry(root, () => now++);
  try {
    // The CLI accepts this whole-second duration, and the sum is a safe integer,
    // but Date cannot represent it: workers list must never persist such an invite.
    expect(Number.isSafeInteger(now + 8_700_000_000_000_000)).toBe(true);
    expect(() => registry.inviteWorker("unprintable", null, "local-operator", 8_700_000_000_000_000)).toThrow(/date range/);
    expect(registry.workers()).toEqual([]);
    expect(registry.audits()).toEqual([]);
    expect(registry.db.prepare("SELECT count(*) n FROM credentials").get()?.n).toBe(0);
    now = 1_700_000_000_000;
    const { worker } = registry.inviteWorker("printable", null, "local-operator", 5000);
    expect(worker.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(worker.inviteExpiresAt).toBe(1_700_000_005_000);
    expect(new Date(worker.inviteExpiresAt!).toISOString()).toBe("2023-11-14T22:13:25.000Z");
  } finally { registry.close(); rmSync(root, { recursive: true, force: true }); }
});

it("rolls back enrollment and credential changes when their audit insert fails", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-audit-atomicity-"));
  const registry = new NodeRegistry(root);
  const refuseAudit = () => registry.db.exec("CREATE TRIGGER refuse_worker_audit BEFORE INSERT ON worker_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  const restoreAudit = () => registry.db.exec("DROP TRIGGER refuse_worker_audit");
  try {
    refuseAudit();
    expect(() => registry.inviteWorker("failed")).toThrow(/audit unavailable/);
    expect(registry.workers()).toEqual([]);
    expect(registry.db.prepare("SELECT count(*) n FROM credentials").get()?.n).toBe(0);
    restoreAudit();
    const { worker, credential } = registry.inviteWorker("worker");
    const credentials = registry.db.prepare("SELECT * FROM credentials").all();
    refuseAudit();
    expect(() => registry.recordHello(worker.id, false)).toThrow(/audit unavailable/);
    expect(registry.worker(worker.id).joinedAt).toBeNull();
    expect(() => registry.rotateCredential(worker.id)).toThrow(/audit unavailable/);
    expect(registry.db.prepare("SELECT * FROM credentials").all()).toEqual(credentials);
    expect(() => registry.revokeWorker(worker.id)).toThrow(/audit unavailable/);
    expect(registry.worker(worker.id).id).toBe(worker.id);
    expect(registry.authenticate(credential)).toBe(worker.id);
    expect(registry.db.prepare("SELECT * FROM credentials").all()).toEqual(credentials);
    restoreAudit();
    registry.recordHello(worker.id, false);
    expect(registry.audits().map(row => row.event)).toEqual(["invite", "join"]);
    refuseAudit();
    expect(() => registry.recordHello(worker.id, true)).toThrow(/audit unavailable/);
    expect(registry.audits().map(row => row.event)).toEqual(["invite", "join"]);
    restoreAudit();
    registry.recordHello(worker.id, true);
    expect(registry.audits().map(row => row.event)).toEqual(["invite", "join", "session-takeover"]);
  } finally { registry.close(); rmSync(root, { recursive: true, force: true }); }
});
