import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowError } from "./errors.js";
import {
  WorkDelegationIssuer,
  WorkDelegationVerifier,
  rotateDelegationKeys,
  type DelegationKey,
} from "./work-delegation.js";
import { approveWorkflowBounds, boundFingerprint } from "../bounds/workflow-bounds.js";
import { WorkAdmissionService, type WorkResolution } from "./work-admission.js";
import { WorkflowOwner } from "./workflow-owner.js";
import { WorkArtifactStore } from "./work-artifacts.js";
import { ProcessExecutor } from "./executor.js";
import { inspectArtifact, artifactAbi } from "./artifacts.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import type { WorkAuthority } from "./work-authority.js";
import type { WorkSubmission } from "./work-contracts.js";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "work-delegation-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.now(),
    revoked = false;
  const key: DelegationKey = {
    id: "key-1",
    secret: "fixture-only-dedicated-delegation-key-0000",
    not_before: now - 1000,
    not_after: now + 3600000,
  };
  let signingKey = key,
    keys = [key];
  const scope = await approveWorkflowBounds({
    identity: "alice",
    traitNames: [],
    traits: {},
    tools: [],
    bounds: [{ files: { allow: [] }, nodes: { allow: ["local"] } }],
    boundByName: async () => undefined,
  });
  const request: WorkSubmission = {
    version: 2,
    request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05437",
    idempotency_key: "invocation",
    authority_ref: "registered-issuer-grant",
    definition: { kind: "workflow", reference: "echo", version: "1" },
    inputs: "hello",
    origin: { entry_point: "action-run", trigger: "invocation", caller_session_id: "session" },
  };
  const authority: WorkAuthority = {
    namespace: {
      installation: "owner",
      principal_kind: "identity",
      principal_id: "alice",
      identity_id: "identity-uuid",
      caller_session_id: "session",
    },
    caller_ceiling: scope,
    origin: request.origin,
    run_identity: "alice",
  };
  const issuer = new WorkDelegationIssuer({
    path: join(root, "issuer.db"),
    issuer: "sessions.api",
    signingKey: () => signingKey,
    now: () => now,
  });
  cleanup.push(() => issuer.close());
  const record = issuer.register(request, authority, {
    kind: "session",
    definition_owner_session: "session",
    background_parent: false,
  });
  const verifier = new WorkDelegationVerifier({
    installation: "owner",
    keys: (name) => (name === "sessions.api" ? keys : []),
    authorizeIssuer: record => record.issuer === "sessions.api" && record.source_kind === "session" && record.authority.namespace.principal_kind === "identity",
    now: () => now,
    currentPolicy: async () => {
      if (revoked)
        throw new WorkflowError("AuthorityRevoked", "Current caller policy revoked.", 403);
      return scope;
    },
  });
  return {
    root,
    request,
    authority,
    issuer,
    record,
    verifier,
    key,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    revoke: () => {
      revoked = true;
    },
    rotate: (overlap = 300000) => {
      const next = {
        ...key,
        id: "key-2",
        secret: "fixture-only-new-delegation-signing-key-0000",
        not_before: now,
      };
      keys = rotateDelegationKeys(key, next, now, overlap);
      signingKey = next;
    },
    setKeys: (value: DelegationKey[]) => {
      keys = value;
    },
  };
}
it("transfers immutable full evidence without sharing issuer database transactions or promoting the subject", async () => {
  const f = await fixture(),
    credentials = f.issuer.issue(f.request, f.authority);
  const verified = await f.verifier.authenticate(f.request, credentials, "admit");
  expect(verified.namespace).toEqual(f.authority.namespace);
  expect(verified.caller_ceiling).toEqual(f.authority.caller_ceiling);
  expect(verified.delegation?.nonce).toMatch(/^[a-f0-9-]{36}$/);
  expect(verified.namespace.principal_kind).toBe("identity");
  expect(JSON.stringify(f.record)).not.toContain(credentials.assertion);
});
it("refuses tampered evidence, changed intent/transport, another owner and generic installation credentials", async () => {
  const f = await fixture(),
    credentials = f.issuer.issue(f.request, f.authority);
  await expect(
    f.verifier.authenticate(
      f.request,
      {
        ...credentials,
        record: {
          ...credentials.record,
          authority: {
            ...f.authority,
            namespace: { ...f.authority.namespace, principal_kind: "operator" },
          },
        },
      },
      "admit",
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    f.verifier.authenticate({ ...f.request, inputs: "changed" }, credentials, "admit"),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    f.verifier.authenticate(
      { ...f.request, request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05438" },
      credentials,
      "admit",
    ),
  ).rejects.toMatchObject({ status: 403 });
  const other = new WorkDelegationVerifier({
    installation: "other-owner",
    keys: () => [f.key],
    authorizeIssuer: record => record.issuer === "sessions.api" && record.source_kind === "session" && record.authority.namespace.principal_kind === "identity",
    currentPolicy: async () => f.authority.caller_ceiling,
  });
  await expect(other.authenticate(f.request, credentials, "admit")).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    f.verifier.authenticate(
      f.request,
      { ...credentials, assertion: "BARRY_SECRET-is-not-a-delegation" },
      "admit",
    ),
  ).rejects.toMatchObject({ status: 403 });
});
it("refuses nested detached delegation, ad-hoc ownership violations and spoofed schedules at issuance", async () => {
  const f = await fixture();
  expect(() =>
    f.issuer.register({ ...f.request, authority_ref: "nested" }, f.authority, {
      kind: "session",
      definition_owner_session: "session",
      background_parent: true,
    }),
  ).toThrow(/Nested/);
  expect(() =>
    f.issuer.register({ ...f.request, authority_ref: "other-session" }, f.authority, {
      kind: "session",
      definition_owner_session: "other",
      background_parent: false,
    }),
  ).toThrow(/another session/);
  const request = {
    ...f.request,
    authority_ref: "spoof",
    origin: {
      ...f.request.origin,
      trigger: "schedule" as const,
      occurrence_id: "due",
      producer_ref: "schedule",
    },
  };
  expect(() =>
    f.issuer.register(
      request,
      { ...f.authority, origin: request.origin },
      { kind: "session", definition_owner_session: null, background_parent: false },
    ),
  ).toThrow(/protected producer/);
});
it("supports assertion renewal and bounded key overlap while rejecting retired keys and revoked policy", async () => {
  const f = await fixture(),
    old = f.issuer.issue(f.request, f.authority);
  f.rotate(10000);
  expect((await f.verifier.authenticate(f.request, old, "lookup")).delegation?.key_id).toBe(
    "key-1",
  );
  const renewed = f.issuer.issue(f.request, f.authority);
  expect((await f.verifier.authenticate(f.request, renewed, "lookup")).delegation?.key_id).toBe(
    "key-2",
  );
  f.advance(10000);
  await expect(f.verifier.authenticate(f.request, old, "lookup")).rejects.toMatchObject({
    status: 403,
  });
  expect((await f.verifier.authenticate(f.request, renewed, "lookup")).namespace).toEqual(
    f.authority.namespace,
  );
  f.revoke();
  await expect(f.verifier.authenticate(f.request, renewed, "lookup")).rejects.toThrow(/revoked/);
  expect(() => rotateDelegationKeys(f.key, { ...f.key, id: "new" }, f.now(), 300001)).toThrow(
    /overlap/,
  );
});
it("expires assertions exactly at their boundary and rejects malformed or ambiguous key rings", async () => {
  const f = await fixture(),
    credentials = f.issuer.issue(f.request, f.authority);
  f.advance(60000);
  await expect(f.verifier.authenticate(f.request, credentials, "lookup")).rejects.toMatchObject({
    status: 403,
  });
  const renewed = f.issuer.issue(f.request, f.authority);
  f.setKeys([f.key, f.key]);
  await expect(f.verifier.authenticate(f.request, renewed, "lookup")).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    f.verifier.authenticate(
      f.request,
      { ...renewed, assertion: "bwa2.not-json.signature" },
      "lookup",
    ),
  ).rejects.toMatchObject({ status: 403 });
});
it("pins issuer references across restart and refuses changing their caller or requested intent", async () => {
  const f = await fixture();
  expect(
    f.issuer.register(f.request, f.authority, {
      kind: "session",
      definition_owner_session: "session",
      background_parent: false,
    }),
  ).toEqual(f.record);
  expect(() =>
    f.issuer.register({ ...f.request, inputs: "changed" }, f.authority, {
      kind: "session",
      definition_owner_session: "session",
      background_parent: false,
    }),
  ).toThrow(/different/);
  const restarted = new WorkDelegationIssuer({
    path: join(f.root, "issuer.db"),
    issuer: "sessions.api",
    signingKey: () => f.key,
    now: f.now,
  });
  cleanup.push(() => restarted.close());
  expect(
    (await f.verifier.authenticate(f.request, restarted.issue(f.request, f.authority), "lookup"))
      .caller_ceiling,
  ).toEqual(f.authority.caller_ceiling);
});
async function ownerFixture() {
  const f = await fixture(),
    sourcePath = fileURLToPath(new URL("./execution-fixture.mjs", import.meta.url));
  const artifact = inspectArtifact(sourcePath, "echo", "1"),
    artifacts = new WorkArtifactStore(join(f.root, "artifacts"));
  const reference = artifacts.stage(readFileSync(sourcePath), {
    owner_identity: null,
    purpose: "source",
    media_type: "text/javascript",
  });
  const owner = new WorkflowOwner({
    id: "owner",
    path: join(f.root, "owner.db"),
    artifacts: [artifact],
    activityArtifacts: { echo: artifact.digest },
    executor: new ProcessExecutor(),
    workArtifacts: artifacts,
    now: f.now,
  });
  cleanup.push(async () => {
    await owner.drain();
    owner.close();
  });
  const service = new WorkAdmissionService({
    owner,
    authenticate: f.verifier.authenticate.bind(f.verifier),
    resolve: async (request, authority): Promise<WorkResolution> => {
      const grant = {
        version: 2 as const,
        grant_ref: "accepted-grant",
        revision: 1,
        namespace: authority.namespace,
        authorizer: "alice",
        created_by: "alice",
        approved_at: f.now(),
        original_caller_ceiling: authority.caller_ceiling,
        effective_scope: authority.caller_ceiling,
        definition_bounds_digest: boundFingerprint(authority.caller_ceiling.bound),
        policy_revision: "policy-1",
      };
      return {
        grant,
        title: "Delegated task",
        workflow_input: request.inputs,
        plan: {
          version: 2,
          definition: request.definition,
          workflow: {
            type: "echo",
            version: "1",
            artifact_digest: artifact.digest,
            runtime_abi: artifactAbi,
            input_digest: boundFingerprint(request.inputs),
          },
          source_closure: [reference],
          grant_ref: grant.grant_ref,
          grant_revision: 1,
          grant_digest: boundFingerprint(grant),
          executor_generation: "work-v2",
          execution_profile: "portable",
          effect_policy: { class: "non-repeatable", max_attempts: 1 },
          resources: {
            executor: "process",
            lane: "unscheduled",
            logical_reservation: "to-be-assigned",
            host_reservation: null,
            endpoint: null,
          },
          workspace: { kind: "none" },
          selection: {
            requested_model: null,
            resolved_model: null,
            endpoint: null,
            requested_harness: null,
            resolved_harness: null,
            provenance: "definition",
          },
          execution_budget_ms: 60000,
          dispatch_budget_ms: 120000,
        },
      };
    },
  });
  const inspect = () => new SqliteDatabase(join(f.root, "owner.db"));
  return { ...f, owner, service, inspect };
}
it("consumes the nonce atomically with owner admission, redelivers once, and records assertion hashes only", async () => {
  const f = await ownerFixture(),
    credentials = f.issuer.issue(f.request, f.authority);
  const accepted = await f.service.submit(f.request, credentials);
  expect(await f.service.submit(f.request, credentials)).toEqual(accepted);
  const renewal = f.issuer.issue(f.request, f.authority);
  expect(await f.service.submit(f.request, renewal)).toEqual(accepted);
  const db = f.inspect();
  try {
    expect(db.prepare("SELECT count(*) n FROM workflow_work_nonces").get()?.n).toBe(2);
    expect(db.prepare("SELECT count(*) n FROM workflow_runs").get()?.n).toBe(1);
    const rows = db.prepare("SELECT * FROM workflow_work_nonces").all();
    expect(JSON.stringify(rows)).not.toContain(credentials.assertion);
    expect(rows[0].assertion_hash).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    db.close();
  }
});
it("does not consume an issuer nonce when owner admission rolls back", async () => {
  const f = await ownerFixture(),
    credentials = f.issuer.issue(f.request, f.authority),
    db = f.inspect();
  db.exec(
    "CREATE TRIGGER fault BEFORE INSERT ON workflow_work_nonces BEGIN SELECT RAISE(ABORT,'nonce commit unavailable'); END",
  );
  await expect(f.service.submit(f.request, credentials)).rejects.toThrow(
    "nonce commit unavailable",
  );
  expect(db.prepare("SELECT count(*) n FROM workflow_runs").get()?.n).toBe(0);
  expect(db.prepare("SELECT count(*) n FROM workflow_work_nonces").get()?.n).toBe(0);
  db.exec("DROP TRIGGER fault");
  db.close();
  expect((await f.service.submit(f.request, credentials)).work_id).toMatch(/^work_/);
});
it.each([true, false])(
  "recovers issuer commit ambiguity before signing evidence (commit applied: %s)",
  async (applied) => {
    const f = await fixture(),
      db = Reflect.get(f.issuer, "db") as SqliteDatabase,
      exec = db.exec.bind(db);
    const request = { ...f.request, authority_ref: "new-reference" };
    const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") {
        if (applied) exec(sql);
        throw new Error("issuer commit acknowledgement lost");
      }
      return exec(sql);
    });
    try {
      expect(() =>
        f.issuer.register(request, f.authority, {
          kind: "session",
          definition_owner_session: "session",
          background_parent: false,
        }),
      ).toThrow("issuer commit acknowledgement lost");
    } finally {
      spy.mockRestore();
    }
    if (!applied) expect(() => f.issuer.issue(request, f.authority)).toThrow(/not registered/);
    f.issuer.register(request, f.authority, {
      kind: "session",
      definition_owner_session: "session",
      background_parent: false,
    });
    expect(
      (await f.verifier.authenticate(request, f.issuer.issue(request, f.authority), "lookup"))
        .namespace,
    ).toEqual(f.authority.namespace);
    expect(Reflect.get(f.issuer, "db")).not.toBe(db);
  },
);
it("retains signed evidence once per run and rejects reusing a consumed nonce for different work", async () => {
  const f = await ownerFixture(),
    credentials = f.issuer.issue(f.request, f.authority);
  const authority = await f.verifier.authenticate(f.request, credentials, "admit");
  const first = await f.service.submit(f.request, credentials);
  const db = f.inspect();
  try {
    expect(db.prepare("SELECT count(*) n FROM workflow_work_delegations").get()?.n).toBe(1);
    const evidence = JSON.parse(
      String(db.prepare("SELECT evidence FROM workflow_work_delegations").get()?.evidence),
    );
    expect(evidence.authority.caller_ceiling).toEqual(f.authority.caller_ceiling);
    expect(JSON.stringify(evidence)).not.toContain(credentials.assertion);
  } finally {
    db.close();
  }
  const otherRequest = {
    ...f.request,
    authority_ref: "another-authority",
    idempotency_key: "another-invocation",
    request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05438",
  };
  f.issuer.register(otherRequest, f.authority, {
    kind: "session",
    definition_owner_session: "session",
    background_parent: false,
  });
  const other = await f.service.submit(otherRequest, f.issuer.issue(otherRequest, f.authority));
  const otherCredentials = f.issuer.issue(otherRequest, f.authority);
  const [, encoded] = otherCredentials.assertion.split(".");
  const claims = JSON.parse(Buffer.from(encoded, "base64url").toString());
  claims.nonce = authority.delegation!.nonce;
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", f.key.secret)
    .update("barry.work-admission.v2\0")
    .update(payload)
    .digest("base64url");
  await expect(
    f.service.submit(otherRequest, { ...otherCredentials, assertion: `bwa2.${payload}.${mac}` }),
  ).rejects.toMatchObject({ code: "NonceReplay" });
  expect(f.owner.workByKey(f.authority.namespace, f.request.idempotency_key)?.work_id).toBe(
    first.work_id,
  );
});
it("rechecks expiry after slow policy evaluation and rejects caller substitution", async () => {
  const f = await fixture(),
    credentials = f.issuer.issue(f.request, f.authority);
  const slow = new WorkDelegationVerifier({
    installation: "owner",
    keys: () => [f.key],
    authorizeIssuer: record => record.issuer === "sessions.api" && record.source_kind === "session" && record.authority.namespace.principal_kind === "identity",
    now: f.now,
    currentPolicy: async () => {
      f.advance(60000);
      return f.authority.caller_ceiling;
    },
  });
  await expect(slow.authenticate(f.request, credentials, "admit")).rejects.toMatchObject({
    status: 403,
  });
  const current = f.issuer.issue(f.request, f.authority);
  const other = await approveWorkflowBounds({
    identity: "other",
    traitNames: [],
    traits: {},
    tools: [],
    boundByName: async () => undefined,
  });
  const substituted = new WorkDelegationVerifier({
    installation: "owner",
    keys: () => [f.key],
    authorizeIssuer: record => record.issuer === "sessions.api" && record.source_kind === "session" && record.authority.namespace.principal_kind === "identity",
    now: f.now,
    currentPolicy: async () => other,
  });
  await expect(substituted.authenticate(f.request, current, "admit")).rejects.toMatchObject({
    status: 403,
  });
});
it("cannot promote an identity named local-operator through the legacy principal boundary", async () => {
  const f = await fixture();
  const forged = {
    ...f.authority,
    namespace: { ...f.authority.namespace, principal_id: "local-operator" },
  };
  expect(() =>
    f.issuer.register({ ...f.request, authority_ref: "reserved-principal" }, forged, {
      kind: "session",
      definition_owner_session: "session",
      background_parent: false,
    }),
  ).toThrow(/Reserved operator/);
});
it("generates unforgeable authority references and cannot renew another subject's grant", async () => {
  const f = await fixture();
  const { authority_ref: _authority, ...input } = f.request;
  const prepared = f.issuer.prepare(input, f.authority, {
    kind: "session",
    definition_owner_session: "session",
    background_parent: false,
  });
  expect(prepared.request.authority_ref).toMatch(/^agr_[a-f0-9]{64}$/);
  expect(f.issuer.issue(prepared.request, f.authority).record.grant_ref).toBe(
    prepared.request.authority_ref,
  );
  const other = { ...f.authority, namespace: { ...f.authority.namespace, principal_id: "other" } };
  expect(() => f.issuer.issue(f.request, other)).toThrow(/another authenticated subject/);
});
it("prepares one durable reference per caller/key across gateway retries and issuer restart", async () => {
  const f = await fixture(), { authority_ref: _ref, ...input } = f.request;
  const source = { kind: "session" as const, definition_owner_session: "session", background_parent: false };
  const first = f.issuer.prepare(input, f.authority, source);
  const retry = f.issuer.prepare({ ...input, request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05438" }, f.authority, source);
  expect(retry.request.authority_ref).toBe(first.request.authority_ref);
  expect(retry.record).toEqual(first.record);
  expect(() => f.issuer.prepare({ ...input, inputs: "different intent" }, f.authority, source)).toThrow(/different intent/);
  const second = new WorkDelegationIssuer({ path: join(f.root, "issuer.db"), issuer: "sessions.api", signingKey: () => f.key, now: f.now });
  cleanup.push(() => second.close());
  expect(second.prepare(input, f.authority, source).request.authority_ref).toBe(first.request.authority_ref);
  const credentials = second.issue(retry.request, f.authority);
  expect((await f.verifier.authenticate(retry.request, credentials, "lookup")).namespace).toEqual(f.authority.namespace);
});
it.each([true, false])("recovers gateway preparation binding COMMIT ambiguity (applied: %s)", async applied => {
  const f = await fixture(), { authority_ref: _ref, ...input } = f.request;
  const db = Reflect.get(f.issuer, "db") as SqliteDatabase, original = db.exec.bind(db);
  let commits = 0;
  vi.spyOn(db, "exec").mockImplementation(sql => {
    if (sql === "COMMIT" && ++commits === 2) { if (applied) original(sql); throw new Error("lost preparation binding acknowledgement"); }
    return original(sql);
  });
  const source = { kind: "session" as const, definition_owner_session: "session", background_parent: false };
  expect(() => f.issuer.prepare(input, f.authority, source)).toThrow(/acknowledgement/);
  const inspect = new SqliteDatabase(join(f.root, "issuer.db"));
  const prior = inspect.prepare("SELECT grant_ref FROM delegation_preparations").get()?.grant_ref; inspect.close();
  expect(Boolean(prior)).toBe(applied);
  const retry = f.issuer.prepare(input, f.authority, source);
  if (applied) expect(retry.request.authority_ref).toBe(prior);
  const check = new SqliteDatabase(join(f.root, "issuer.db"));
  expect(check.prepare("SELECT count(*) n FROM delegation_preparations").get()?.n).toBe(1); check.close();
  expect(f.issuer.issue(retry.request, f.authority).record.grant_ref).toBe(retry.request.authority_ref);
});
it("upgrades a v1 issuer without altering existing evidence or reference renewals", async () => {
  const f = await fixture(); f.issuer.close();
  const db = new SqliteDatabase(join(f.root, "issuer.db"));
  db.exec("DROP TABLE delegation_preparations; PRAGMA user_version=1"); db.close();
  const upgraded = new WorkDelegationIssuer({ path: join(f.root, "issuer.db"), issuer: "sessions.api", signingKey: () => f.key, now: f.now });
  cleanup.push(() => upgraded.close());
  expect(upgraded.issue(f.request, f.authority).record).toEqual(f.record);
  const { authority_ref: _ref, ...input } = f.request;
  expect(upgraded.prepare(input, f.authority, { kind: "session", definition_owner_session: "session", background_parent: false }).request.authority_ref).toMatch(/^agr_/);
});
it("recovers accepted work after a lost gateway response using the prepared key without resolving a changed catalog", async () => {
  const f = await ownerFixture(), { authority_ref: _ref, ...input } = f.request;
  const source = { kind: "session" as const, definition_owner_session: "session", background_parent: false };
  const first = f.issuer.prepare(input, f.authority, source);
  const accepted = await f.service.submit(first.request, f.issuer.issue(first.request, f.authority));
  f.advance(60001);
  const options = Reflect.get(f.service, "options") as { resolve: () => Promise<unknown> };
  const resolver = vi.spyOn(options, "resolve").mockRejectedValue(new Error("catalog changed after possible acceptance"));
  const retry = f.issuer.prepare({ ...input, request_id: "fae7af55-ad99-4a5f-8bf7-4fe2b2b05438" }, f.authority, source);
  const recovered = await f.service.submit(retry.request, f.issuer.issue(retry.request, f.authority));
  expect(recovered.work_id).toBe(accepted.work_id);
  expect(recovered.plan_digest).toBe(accepted.plan_digest);
  expect(resolver).not.toHaveBeenCalled();
  const db = f.inspect();
  expect(db.prepare("SELECT count(*) n FROM workflow_runs").get()?.n).toBe(1); db.close();
});
