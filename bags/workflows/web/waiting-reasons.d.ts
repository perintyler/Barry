export function explainBlockedRun(error: unknown): { title: string; detail: string };

export const WORK_STATE_META: Record<string, {
  label: string;
  category: "active" | "attention" | "history";
  logicalOutcome: string;
  physicalCessation: string;
  stopState: string;
  explanation: string;
}>;

export const WORK_REASON_META: Record<string, {
  label: string;
  category: string;
  guidance: string;
}>;

export function hasValidationFailures(item: unknown, result?: unknown): boolean;
export function extractValidationFailures(item: unknown, result?: unknown): string[];

export function describeWorkState(item: unknown, result?: unknown): {
  state: string;
  label: string;
  qualifier: string | null;
  badgeText: string;
  category: string;
  logicalOutcome: string;
  physicalCessation: string;
  effectCertainty: string;
  validationState: "failed" | "passed" | "not_run";
  stopState: "stopped" | "stopping" | "none";
  explanation: string;
};

export function describeWorkReason(item: unknown): {
  code: string | null;
  stage: string | null;
  since?: number | string | null;
  label: string;
  category?: string;
  message: string;
  detail?: string;
  guidance: string | null;
  retryable: boolean;
  until?: string | number | null;
  attemptId?: string | null;
};

export function formatDurationMs(ms: number): string;

export function describeWorkProgress(item: unknown, nowMs?: number): {
  phase: string;
  waitKind: string | null;
  stageLabel: string;
  timingSummary: string;
  totalElapsedMs: number | null;
  executionElapsedMs: number | null;
  preStartWaitMs: number | null;
  isWaiting: boolean;
};

export function isScheduledWorkItem(item: unknown): boolean;
export function matchesWorkView(item: unknown, view: "active" | "attention" | "scheduled" | "history" | string): boolean;
export function filterWorkItemsForView<T>(items: readonly T[], view: "active" | "attention" | "scheduled" | "history" | string): T[];

export interface DerivedSchemaField {
  name: string;
  id: string;
  descId: string;
  errorId: string;
  label: string;
  description: string | null;
  type: string;
  control: "text" | "select" | "checkbox" | "number" | "json" | "textarea";
  required: boolean;
  defaultValue: unknown;
  enumValues: string[] | null;
  minimum: number | undefined;
  maximum: number | undefined;
  step: number | "any";
  scaleMultiplier: number;
}

export function deriveSchemaFields(definition: unknown): DerivedSchemaField[];

export function buildAndValidateStartInputs(
  definition: unknown,
  rawFieldValues: Record<string, unknown> | undefined,
  extraJsonText?: string,
  useRawJsonOnly?: boolean,
): {
  ok: boolean;
  inputs: Record<string, unknown>;
  fieldErrors: Record<string, string>;
  extraError: string | null;
};

export function classifyAdmissionFailure(
  error: unknown,
  priorAmbiguous?: boolean,
): {
  outcome: "refused" | "ambiguous";
  preserveKey: boolean;
  message: string;
};

export function classifyStopFailure(
  error: unknown,
  priorAmbiguous?: boolean,
): {
  outcome: "refused" | "ambiguous";
  preserveIntent: boolean;
  refreshRequired: boolean;
  message: string;
};

export function derivePermittedControls(
  item: unknown,
  result?: unknown,
): {
  controls: Array<{
    action: string;
    label: string;
    supported: boolean;
    description: string;
  }>;
  unavailableNotices: Array<{
    action: string;
    reason: string;
  }>;
};

export interface WorkSummaryProjection {
  workId: string;
  workflowId: string | null;
  title: string;
  state: ReturnType<typeof describeWorkState>;
  reason: ReturnType<typeof describeWorkReason>;
  progress: ReturnType<typeof describeWorkProgress>;
  controls: ReturnType<typeof derivePermittedControls>;
  validationFailures: string[];
}

export function projectWorkExperience(item: unknown, result?: unknown, nowMs?: number): WorkSummaryProjection;

