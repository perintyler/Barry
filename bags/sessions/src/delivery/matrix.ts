/** The sender-recipient matrix makes each delivery outcome and refusal explicit.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */

import type { DeliveryGuarantee } from "./guarantees.js";

/** A recipient, as the matrix addresses it. */
export interface MatrixRecipient {
  adapterId: string;
  modeId: string;
  /** What that mode declares its delivery to be. */
  declared: DeliveryGuarantee;
  /** False when this mode is not supported on the running platform. */
  availableHere: boolean;
}

export interface MatrixCell {
  senderAdapter: string;
  recipient: MatrixRecipient;
  /** What `send_prompt` must report for this cell. */
  expectedDelivery: DeliveryGuarantee;
  /**
   * Must the recipient actually start a turn within the deadline?
   *
   * Only for cells that claim it. A cell declaring `turn-end` or `none` is
   * asserted to REPORT exactly that — reporting accurately is the requirement,
   * and a cell that cannot wake is not a failure if it says so.
   */
  expectWake: boolean;
  /** Why this cell expects what it expects, for the report. */
  rationale: string;
}

/** Cells whose recipient actually starts a turn. */
const WAKING: ReadonlySet<DeliveryGuarantee> = new Set(["wake", "wake-peer-framed"]);

/**
 * Build the matrix from what the adapters declare.
 *
 * Every sender against every recipient: the sender's adapter does not change
 * what the recipient can receive — that is the point of one inbox — so a cell's
 * expectation comes from the RECIPIENT alone. The matrix still runs every
 * sender, because "the sender does not matter" is a claim worth checking rather
 * than assuming.
 */
export function buildMatrix(
  senderAdapters: readonly string[],
  recipients: readonly MatrixRecipient[],
): MatrixCell[] {
  const cells: MatrixCell[] = [];

  for (const senderAdapter of senderAdapters) {
    for (const recipient of recipients) {
      if (!recipient.availableHere) continue;

      cells.push({
        senderAdapter,
        recipient,
        expectedDelivery: recipient.declared,
        expectWake: WAKING.has(recipient.declared),
        rationale: WAKING.has(recipient.declared)
          ? `${recipient.adapterId} ${recipient.modeId} declares ${recipient.declared}: the recipient must start a turn`
          : `${recipient.adapterId} ${recipient.modeId} declares ${recipient.declared}: the sender must be told exactly that`,
      });
    }
  }

  return cells;
}

/** What one cell actually did. */
export interface CellOutcome {
  reportedDelivery: DeliveryGuarantee;
  /** Did the recipient start a turn within the deadline? */
  woke: boolean;
  /** Did any dialog appear on the recipient's screen? */
  dialogAppeared: boolean;
  /** Is the message still in the inbox (for cells that should not wake)? */
  stillPending: boolean;
}

export interface CellVerdict {
  cell: MatrixCell;
  passed: boolean;
  failures: string[];
}

/** Judge delivery report, latency and dialog behavior against the declared matrix cell.
 * Rationale: docs/decisions/0034-adapter-build-capture-and-relay-rationale.md.
 */
export function judgeCell(cell: MatrixCell, outcome: CellOutcome): CellVerdict {
  const failures: string[] = [];

  if (outcome.reportedDelivery !== cell.expectedDelivery) {
    failures.push(
      `reported "${outcome.reportedDelivery}" but ${cell.recipient.adapterId} ${cell.recipient.modeId} declares "${cell.expectedDelivery}"`,
    );
  }

  if (cell.expectWake && !outcome.woke) {
    failures.push(`declared ${cell.expectedDelivery} but the recipient did not start a turn`);
  }

  // A cell that does not claim a wake must keep the message rather than lose
  // it — "cannot deliver now" and "dropped it" are different answers.
  if (!cell.expectWake && !outcome.woke && !outcome.stillPending) {
    failures.push("did not wake and did not keep the message pending — it was lost");
  }

  if (outcome.dialogAppeared) {
    failures.push("a dialog appeared: no vendor gate may hold a Barry-delivered message");
  }

  return { cell, passed: failures.length === 0, failures };
}

/**
 * One line per run.
 *
 * Reports cells CONSIDERED as well as passed, because a matrix that skipped
 * every cell — no adapter available, nothing installed — and printed "0
 * failures" is indistinguishable from one that passed.
 */
export function summarizeMatrix(verdicts: readonly CellVerdict[]): string {
  const failed = verdicts.filter((v) => !v.passed);
  return `matrix: ${verdicts.length} cell(s) considered, ${verdicts.length - failed.length} passed, ${failed.length} failed`;
}
