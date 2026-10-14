import type { PermissionDecision, PermissionRequest, SessionEvent } from "./index.js";
import { z } from "zod";

export type ApprovalContinuation = "durable" | "live" | "unsupported";
export const ReviewPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("automatic") }),
  z.strictObject({ mode: z.literal("review_required"), expiresAt: z.iso.datetime().optional() }),
]);
export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>;
export type TurnState = "queued" | "running" | "waiting_for_input" | "recovery_required" | "completed" | "failed" | "cancelled";
export type CallState = "not_started" | "executing" | "completed" | "failed" | "denied" | "uncertain";

/** Private adapter data. Never include this value in an app snapshot. */
export interface ContinuationDescriptor {
  format: string;
  version: number;
  adapterId: string;
  adapterVersion: string;
  harnessVersion: string;
  configFingerprint: string;
  payload: unknown;
}

export interface RecordedCallResult {
  id: string;
  result: unknown;
  error?: boolean;
}

export type SegmentOutcome =
  | { type: "completed"; result?: unknown; conversation?: ContinuationDescriptor }
  | { type: "failed"; error: string }
  | { type: "interrupted"; continuation: ContinuationDescriptor; calls: PermissionRequest[] };

/**
 * A quiescent segment returns before its runtime is released. The owner commits
 * the returned checkpoint before publishing an interrupt or closing the handle.
 */
export interface ContinuationHarness {
  readonly approvalContinuation: ApprovalContinuation;
  begin(content: string, emit: (event: SessionEvent) => Promise<void>, conversation?: ContinuationDescriptor): Promise<SegmentOutcome>;
  validate(continuation: ContinuationDescriptor): void;
  restore(
    continuation: ContinuationDescriptor,
    decisions: ReadonlyMap<string, PermissionDecision>,
    effects: ContinuationEffects,
    emit: (event: SessionEvent) => Promise<void>,
  ): Promise<SegmentOutcome>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** Every call goes through current authority and a persisted effect boundary. */
export interface ContinuationEffects {
  recorded?(call: PermissionRequest): Promise<RecordedCallResult | undefined>;
  denied?(call: PermissionRequest, result: RecordedCallResult): Promise<RecordedCallResult>;
  authorize(call: PermissionRequest): Promise<PermissionDecision>;
  execute(call: PermissionRequest, effect: () => Promise<RecordedCallResult>): Promise<RecordedCallResult>;
}

export interface ApprovalDecision {
  interruptId: string;
  decision: PermissionDecision;
}

export interface PublicInterrupt {
  id: string;
  runId: string;
  call: PermissionRequest;
  expiresAt?: string;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
}

export interface TurnSnapshot {
  id: string;
  sessionId: string;
  runId: string;
  state: TurnState;
  revision: number;
  reviewPolicy: ReviewPolicy;
  interrupts: PublicInterrupt[];
  result?: unknown;
  error?: string;
}
