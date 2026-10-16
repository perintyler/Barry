/**
 * Canonical Work admission for producer occurrences, with recovery after a
 * lost reply (P4.3/P4.5 preparation).
 *
 * The adapter submits one occurrence as one Work submission and is the only
 * thing that decides what a failed delivery means:
 *
 * - Nothing here constructs authority. The authenticated service principal
 *   for an occurrence comes from an injected, main-owned authority port; the
 *   adapter checks that it describes exactly this occurrence and refuses an
 *   operator/identity principal for a producer trigger, before any network.
 * - The key, request id, definition, inputs and origin come from the stored
 *   occurrence. A redelivery is the identical submission, which the owner
 *   deduplicates; a new key is never minted for an occurrence.
 * - Admission may have happened whenever a submission left this process
 *   without a definite answer. That is `unknown`: the next attempt looks the
 *   original key up first and redelivers the same submission only if the
 *   lookup does not find it. A 404 does not prove non-admission, which is why
 *   the redelivery must be the identical intent rather than a replacement.
 * - After acceptance the owner owns retries. This adapter never re-executes
 *   work and never falls back to a local executor.
 *
 * Store-agnostic: the dispatch bookkeeping arrives through a port, so the
 * schedules ledger and other producer outboxes can share the decision logic.
 */

import { createHash } from "node:crypto";
import type { WorkAuthority, WorkDelegationCredentials, WorkDelegationRecord, WorkSubmission } from "@barry-rocks/sdk/internal/workflows";

/** A submission before the issuer binds its authority reference. */
export type WorkProducerSubmissionInput = Omit<WorkSubmission, "authority_ref">;

/** The origin a producer occurrence submits under: always a named occurrence of a named producer. */
export interface WorkProducerOrigin {
  entry_point: string;
  trigger: "schedule" | "event" | "internal" | "manual";
  occurrence_id: string;
  producer_ref: string;
}

export type ProducerSourceKind = WorkDelegationRecord["source_kind"];

/**
 * What the producer recorded as its selection when the occurrence was due —
 * a schedule's identity, traits and bounds. Passed to the authority port as a
 * request; the port resolves the ceiling, and the adapter checks the result
 * kept the identity choice and every selected trait.
 */
export interface WorkProducerSelection {
  identity: string | null;
  identity_id: number | null;
  traits: string[];
  bounds: string[];
}

/**
 * Main-owned composition. `authenticate` returns the authority an authorized
 * boundary established for this exact origin — or throws when it cannot. The
 * producer never fabricates it.
 */
export interface WorkProducerAuthorityPort {
  authenticate(origin: WorkProducerOrigin, selection: WorkProducerSelection): Promise<WorkAuthority>;
  /** The issuer source kind this producer registers under. */
  sourceKind: ProducerSourceKind;
}

/**
 * The subset of WorkDelegationIssuer the adapter uses; the SDK issuer bound
 * to the producer's dedicated key satisfies it as is.
 */
export interface WorkProducerIssuerPort {
  prepare(
    input: WorkProducerSubmissionInput,
    authority: WorkAuthority,
    source: { kind: ProducerSourceKind; definition_owner_session: string | null; background_parent: boolean },
  ): { request: WorkSubmission; record: WorkDelegationRecord };
  issue(request: WorkSubmission, authority: WorkAuthority): WorkDelegationCredentials;
}

/** What the owner returned for an accepted submission (a subset of WorkAdmission). */
export interface WorkProducerAcceptance {
  work_id: string;
  workflow_id: string;
  idempotency_key: string;
  request_hash?: string;
  origin: { occurrence_id?: string; producer_ref?: string; trigger: string };
  namespace: { principal_kind: string; principal_id: string };
}

/**
 * Transport to the owner. `lookup` returns null for a definite "not found";
 * it throws when it cannot tell. Errors carry `status`/`code`/`retryable`
 * when the owner answered.
 */
export interface WorkProducerTransport {
  submit(body: { request: WorkSubmission; delegation: WorkDelegationCredentials }): Promise<WorkProducerAcceptance>;
  lookup(idempotencyKey: string): Promise<WorkProducerAcceptance | null>;
}

/** The bookkeeping the adapter needs from a producer store. */
export interface WorkProducerDispatchPort {
  bindAuthority(occurrenceId: string, binding: { authorityRef: string; requestHash: string }): void;
  markAccepted(occurrenceId: string, accepted: { workId: string; workflowId: string | null }): void;
  markUnknown(occurrenceId: string, error: { code: string; message: string }, retryAt: Date): void;
  markRefused(occurrenceId: string, error: { code: string; message: string }): void;
}

/** One occurrence as the adapter sees it: stored identity plus what dispatch has bound so far. */
export interface WorkProducerOccurrence {
  occurrenceId: string;
  executorGeneration: string;
  submission: WorkProducerSubmissionInput & { origin: WorkProducerOrigin };
  selection: WorkProducerSelection;
  /** Whether a previous attempt may have reached the owner (`dispatching`/`unknown`). */
  possiblyAdmitted: boolean;
  boundAuthorityRef: string | null;
  boundRequestHash: string | null;
}

export type AdmissionResult =
  | { state: "accepted"; workId: string; workflowId: string; recovered: boolean }
  | { state: "unknown"; code: string; message: string; retryAt: Date }
  | { state: "refused"; code: string; message: string };

/** Producer triggers that require a service principal (mirrors work-delegation recordRules). */
const PRODUCER_TRIGGERS = new Set(["schedule", "event", "internal"]);

export const ADMISSION_RETRY_BASE_MS = 15_000;
export const ADMISSION_RETRY_MAX_MS = 15 * 60_000;

/** Exponential from 15 s, capped at 15 min: redelivery and lookup only, never effects. */
export function admissionRetryDelayMs(attempts: number): number {
  return Math.min(ADMISSION_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), ADMISSION_RETRY_MAX_MS);
}

/** A stable fingerprint of an origin, to compare what the authority port returned. */
function originFingerprint(origin: WorkSubmission["origin"]): string {
  return createHash("sha256").update(JSON.stringify([
    origin.entry_point ?? null, origin.trigger ?? null, origin.occurrence_id ?? null, origin.producer_ref ?? null,
    origin.caller_session_id ?? null, origin.parent_work_id ?? null,
  ])).digest("hex");
}

interface OwnerError {
  status?: number;
  code?: string;
  retryable?: boolean;
  message?: string;
}

function asOwnerError(error: unknown): OwnerError {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    return {
      ...(typeof e.status === "number" ? { status: e.status } : {}),
      ...(typeof e.code === "string" ? { code: e.code } : {}),
      ...(typeof e.retryable === "boolean" ? { retryable: e.retryable } : {}),
      ...(typeof e.message === "string" ? { message: e.message } : {}),
    };
  }
  return { message: String(error) };
}

/**
 * Whether an owner answer DEFINITELY refused this intent. Only a non-retryable
 * 4xx counts: the owner looked at the request and said no (bad delegation,
 * key conflict, schema). Everything else — 5xx, 429, a timeout, a dropped
 * connection — may have committed and is `unknown`.
 */
function definiteRefusal(error: OwnerError): boolean {
  if (error.status === undefined) return false;
  if (error.retryable === true) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

export class WorkProducerAdmission {
  constructor(
    private readonly deps: {
      authority: WorkProducerAuthorityPort;
      issuer: WorkProducerIssuerPort;
      transport: WorkProducerTransport;
      store: WorkProducerDispatchPort;
      now: () => Date;
    },
  ) {}

  /**
   * Deliver one occurrence. The caller has already moved it to its store's
   * `dispatching` state (so a crash from here on reads as possibly admitted)
   * and passes how many attempts that makes.
   */
  async admit(occurrence: WorkProducerOccurrence, attempts: number): Promise<AdmissionResult> {
    if (occurrence.executorGeneration !== "work.v2") {
      // Never cross generations: a legacy occurrence keeps its legacy owner.
      return this.refuse(occurrence, "GenerationMismatch", `occurrence ${occurrence.occurrenceId} belongs to executor generation ${occurrence.executorGeneration}`);
    }
    const { submission } = occurrence;
    if (submission.origin.occurrence_id !== occurrence.occurrenceId) {
      return this.refuse(occurrence, "OccurrenceMismatch", "submission origin names a different occurrence");
    }

    // A previous attempt may have reached the owner: observe the ORIGINAL key
    // before anything else. An observation failure keeps it unknown.
    if (occurrence.possiblyAdmitted) {
      let found: WorkProducerAcceptance | null;
      try {
        found = await this.deps.transport.lookup(submission.idempotency_key);
      } catch (error) {
        const e = asOwnerError(error);
        return this.unknown(occurrence, attempts, `lookup:${e.code ?? e.status ?? "unreachable"}`, e.message ?? "lookup failed");
      }
      if (found) return this.accept(occurrence, found, true);
      // Not found is not proof it never committed — the redelivery below is
      // the identical submission, which the owner deduplicates if it did.
    }

    let authority: WorkAuthority;
    try {
      authority = await this.deps.authority.authenticate(submission.origin, occurrence.selection);
    } catch (error) {
      const e = asOwnerError(error);
      // Nothing left this process, but the occurrence may still have been
      // delivered by an earlier attempt, so it waits as unknown, not pending.
      return this.unknown(occurrence, attempts, `authority:${e.code ?? "unavailable"}`, e.message ?? "authority unavailable");
    }
    const authorityProblem = this.checkAuthority(submission.origin, occurrence.selection, authority);
    if (authorityProblem) return this.refuse(occurrence, "AuthorityMismatch", authorityProblem);

    let prepared: ReturnType<WorkProducerIssuerPort["prepare"]>;
    try {
      prepared = this.deps.issuer.prepare(submission, authority, {
        kind: this.deps.authority.sourceKind,
        definition_owner_session: null,
        background_parent: false,
      });
    } catch (error) {
      const e = asOwnerError(error);
      if (e.status === 403) return this.refuse(occurrence, e.code ?? "InvalidDelegation", e.message ?? "issuer refused the occurrence");
      return this.unknown(occurrence, attempts, `issuer:${e.code ?? "unavailable"}`, e.message ?? "issuer unavailable");
    }
    if (prepared.request.idempotency_key !== submission.idempotency_key || prepared.request.request_id !== submission.request_id) {
      return this.refuse(occurrence, "PreparationMismatch", "issuer returned a submission for a different key or request id");
    }
    if (
      (occurrence.boundAuthorityRef !== null && occurrence.boundAuthorityRef !== prepared.request.authority_ref) ||
      (occurrence.boundRequestHash !== null && occurrence.boundRequestHash !== prepared.record.request_hash)
    ) {
      return this.refuse(occurrence, "BindingChanged", "the occurrence is already bound to different authority or intent; it will not be resubmitted as new work");
    }
    try {
      this.deps.store.bindAuthority(occurrence.occurrenceId, { authorityRef: prepared.request.authority_ref, requestHash: prepared.record.request_hash });
    } catch (error) {
      return this.refuse(occurrence, "BindingChanged", asOwnerError(error).message ?? "binding refused");
    }

    let credentials: ReturnType<WorkProducerIssuerPort["issue"]>;
    try {
      credentials = this.deps.issuer.issue(prepared.request, authority);
    } catch (error) {
      const e = asOwnerError(error);
      return this.unknown(occurrence, attempts, `issuer:${e.code ?? "unavailable"}`, e.message ?? "credential issue failed");
    }

    let accepted: WorkProducerAcceptance;
    try {
      accepted = await this.deps.transport.submit({ request: prepared.request, delegation: credentials });
    } catch (error) {
      const e = asOwnerError(error);
      if (definiteRefusal(e)) return this.refuse(occurrence, e.code ?? `http_${e.status}`, e.message ?? "owner refused the submission");
      return this.unknown(occurrence, attempts, e.code ?? (e.status ? `http_${e.status}` : "transport"), e.message ?? "submission reply lost");
    }
    if (accepted.request_hash !== undefined && accepted.request_hash !== prepared.record.request_hash) {
      return this.refuse(occurrence, "AcceptanceMismatch", "owner acknowledged a different intent hash");
    }
    return this.accept(occurrence, accepted, false);
  }

  private checkAuthority(origin: WorkProducerOrigin, selection: WorkProducerSelection, authority: WorkAuthority): string | null {
    if (originFingerprint(authority.origin) !== originFingerprint(origin)) return "authority describes a different origin than this occurrence";
    // The recorded identity choice survives: an identity-free occurrence is
    // not run as someone, and a named one is not run as no one.
    if ((selection.identity === null) !== (authority.run_identity === null)) {
      return selection.identity === null ? "an identity-free occurrence was given a run identity" : "the occurrence's identity was dropped";
    }
    const granted = new Set(authority.caller_ceiling.traits);
    const dropped = selection.traits.filter((trait) => !granted.has(trait));
    if (dropped.length) return `selected traits are missing from the authorized ceiling: ${dropped.join(", ")}`;
    if (PRODUCER_TRIGGERS.has(origin.trigger) && authority.namespace.principal_kind !== "service") {
      return `a ${origin.trigger} occurrence must be admitted by a service principal, not ${authority.namespace.principal_kind}`;
    }
    if (authority.namespace.caller_session_id !== null) return "a producer occurrence cannot carry a caller session";
    return null;
  }

  private accept(occurrence: WorkProducerOccurrence, accepted: WorkProducerAcceptance, recovered: boolean): AdmissionResult {
    const { submission } = occurrence;
    if (
      accepted.idempotency_key !== submission.idempotency_key ||
      (accepted.origin.occurrence_id ?? null) !== submission.origin.occurrence_id ||
      (accepted.origin.producer_ref ?? null) !== submission.origin.producer_ref
    ) {
      // The owner holds this key for something else. Not ours to adopt, and
      // not a reason to mint a new key either.
      return this.refuse(occurrence, "KeyHeldByOtherOrigin", "the owner's work for this key belongs to a different occurrence");
    }
    this.deps.store.markAccepted(occurrence.occurrenceId, { workId: accepted.work_id, workflowId: accepted.workflow_id });
    return { state: "accepted", workId: accepted.work_id, workflowId: accepted.workflow_id, recovered };
  }

  private unknown(occurrence: WorkProducerOccurrence, attempts: number, code: string, message: string): AdmissionResult {
    const retryAt = new Date(this.deps.now().getTime() + admissionRetryDelayMs(attempts));
    this.deps.store.markUnknown(occurrence.occurrenceId, { code, message }, retryAt);
    return { state: "unknown", code, message, retryAt };
  }

  private refuse(occurrence: WorkProducerOccurrence, code: string, message: string): AdmissionResult {
    this.deps.store.markRefused(occurrence.occurrenceId, { code, message });
    return { state: "refused", code, message };
  }
}

/**
 * HTTP transport to the workflows owner's canonical routes. The service
 * credential is injected explicitly: this never reads BARRY_SECRET or any
 * installation credential on its own, and a bearer authenticates only the
 * service hop — the delegation proves the occurrence's authority.
 */
export function createWorkProducerHttpTransport(options: {
  baseUrl: string;
  serviceCredential: () => Promise<string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): WorkProducerTransport {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const call = async (path: string, body?: unknown): Promise<{ status: number; value: Record<string, unknown> }> => {
    const credential = await options.serviceCredential();
    const response = await send(`${options.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, value };
  };
  const fail = (status: number, value: Record<string, unknown>): never => {
    throw Object.assign(new Error(String(value.message ?? value.error ?? `owner answered ${status}`)), {
      status,
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
    });
  };
  return {
    async submit(body) {
      const { status, value } = await call("/api/v2/work/submissions", body);
      if (status !== 200 && status !== 201) fail(status, value);
      const work = value.work as Record<string, unknown> | undefined;
      if (!work || typeof work.work_id !== "string" || typeof work.workflow_id !== "string" || typeof work.idempotency_key !== "string") {
        // A 2xx without a readable acceptance may still have committed.
        throw Object.assign(new Error("owner acknowledged without a readable work record"), { status: 502, retryable: true });
      }
      return {
        work_id: work.work_id,
        workflow_id: work.workflow_id,
        idempotency_key: work.idempotency_key,
        ...(typeof work.request_hash === "string" ? { request_hash: work.request_hash } : {}),
        origin: (work.origin ?? {}) as WorkProducerAcceptance["origin"],
        namespace: (work.namespace ?? {}) as WorkProducerAcceptance["namespace"],
      };
    },
    async lookup(idempotencyKey) {
      const { status, value } = await call(`/api/v2/work/operations?${new URLSearchParams({ key: idempotencyKey })}`);
      if (status === 404) return null;
      if (status !== 200) fail(status, value);
      if (typeof value.work_id !== "string" || typeof value.workflow_id !== "string") {
        throw Object.assign(new Error("owner lookup returned no readable work record"), { status: 502, retryable: true });
      }
      // The lookup summary carries origin and namespace but not request_hash
      // (see the contract request in the P4 evidence); origin is compared.
      return {
        work_id: value.work_id,
        workflow_id: value.workflow_id,
        idempotency_key: idempotencyKey,
        origin: (value.origin ?? {}) as WorkProducerAcceptance["origin"],
        namespace: (value.namespace ?? {}) as WorkProducerAcceptance["namespace"],
      };
    },
  };
}
