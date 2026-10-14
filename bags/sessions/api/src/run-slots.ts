/** Detached runs have separate per-session, interactive, and scheduled capacity limits. */
export interface RunSlotLimits {
  perCaller: number;
  unscheduled: number;
  scheduled: number;
}

export const RUN_SLOT_LIMITS: RunSlotLimits = { perCaller: 4, unscheduled: 16, scheduled: 4 };

export interface RunSlotRequest {
  /** A schedule's run, which draws on the schedules' own allowance. */
  scheduled: boolean;
  /** The session that started the run, when one did. */
  callerSessionId: string | null;
}

/** A held slot. Releasing twice is a no-op, so a slot can never be returned twice. */
export interface RunSlot {
  release(): void;
}

export type RunSlotResult = { slot: RunSlot } | { refused: string };

export function createRunSlots(limits: RunSlotLimits = RUN_SLOT_LIMITS) {
  let scheduled = 0;
  let unscheduled = 0;
  const byCaller = new Map<string, number>();

  function acquire(request: RunSlotRequest): RunSlotResult {
    if (request.scheduled) {
      if (scheduled >= limits.scheduled) {
        return { refused: `${limits.scheduled} scheduled runs are already in flight; retry when one finishes.` };
      }
      scheduled += 1;
    } else {
      const caller = request.callerSessionId;
      if (caller && (byCaller.get(caller) ?? 0) >= limits.perCaller) {
        return {
          refused: `This session already has ${limits.perCaller} detached runs in flight; wait for one to finish.`,
        };
      }
      if (unscheduled >= limits.unscheduled) {
        return { refused: `${limits.unscheduled} detached runs are already in flight; retry when one finishes.` };
      }
      unscheduled += 1;
      if (caller) byCaller.set(caller, (byCaller.get(caller) ?? 0) + 1);
    }

    let released = false;
    return {
      slot: {
        release() {
          if (released) return;
          released = true;
          if (request.scheduled) {
            scheduled -= 1;
            return;
          }
          unscheduled -= 1;
          const caller = request.callerSessionId;
          if (!caller) return;
          const left = (byCaller.get(caller) ?? 1) - 1;
          if (left > 0) byCaller.set(caller, left);
          else byCaller.delete(caller);
        },
      },
    };
  }

  return { acquire };
}

/** The API process's one set of counts, shared by every route that starts a detached run. */
export const detachedRunSlots = createRunSlots();
