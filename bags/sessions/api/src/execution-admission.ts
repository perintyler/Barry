/** Reserve resident capacity synchronously and acquire independent execution leases only for active turns, not resting sessions; see docs/decisions/0014-discovery-vault-and-session-budgets.md. */

export class AdmissionError extends Error {
  constructor(
    message: string,
    readonly code: "resident_budget" | "turn_queue_full",
  ) {
    super(message);
    this.name = "AdmissionError";
  }
}

export interface AdmissionLimits {
  /** Sessions this process may hold resident in memory at once. */
  maxResidentSessions: number;
  /** Turns actively streaming through a provider at once. */
  maxConcurrentTurns: number;
  /** Turns waiting for an execution slot before new acquires are rejected outright. */
  maxQueuedTurns: number;
}

export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = {
  maxResidentSessions: 10,
  maxConcurrentTurns: 10,
  maxQueuedTurns: 100,
};

/** Service configuration; reject malformed capacities instead of disabling admission. */
export function admissionLimitsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): AdmissionLimits {
  const limit = (key: string, fallback: number, minimum = 1): number => {
    const value = environment[key];
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum) {
      throw new Error(`${key} must be an integer >= ${minimum}`);
    }
    return parsed;
  };
  return {
    maxResidentSessions: limit("BARRY_MAX_RESIDENT_SESSIONS", DEFAULT_ADMISSION_LIMITS.maxResidentSessions),
    maxConcurrentTurns: limit("BARRY_MAX_CONCURRENT_TURNS", DEFAULT_ADMISSION_LIMITS.maxConcurrentTurns),
    maxQueuedTurns: limit("BARRY_MAX_QUEUED_TURNS", DEFAULT_ADMISSION_LIMITS.maxQueuedTurns, 0),
  };
}

/**
 * An opaque token returned by `ResidentBudget.reserve()`. Callers thread it
 * through `commit`/`release` — there is deliberately no session id on it
 * yet, because a reservation is taken BEFORE the session id work (worktree
 * setup, DB lookups) that produces one has even started.
 */
export interface Reservation {
  readonly id: number;
}

/**
 * Synchronous admission for resident sessions.
 *
 * `count()` is uncommitted reservations + committed sessions — both count
 * against the same cap, so a burst of concurrent starts cannot each reserve
 * successfully and then all commit past the limit.
 */
export class ResidentBudget {
  private nextReservationId = 1;
  private pendingReservations = new Set<number>();
  private committed = new Map<number, string>(); // reservation id -> session id
  private bySessionId = new Map<string, number>(); // session id -> reservation id

  constructor(private readonly max: number) {}

  count(): number {
    return this.pendingReservations.size + this.committed.size;
  }

  /** Throws AdmissionError("resident_budget") at capacity. Call before the first await in a start path. */
  reserve(): Reservation {
    if (this.count() >= this.max) {
      throw new AdmissionError(
        `resident session budget exhausted (${this.count()}/${this.max})`,
        "resident_budget",
      );
    }
    const id = this.nextReservationId++;
    this.pendingReservations.add(id);
    return { id };
  }

  /** Bind a reservation to the session id it produced, once that id exists. Idempotent per reservation. */
  commit(reservation: Reservation, sessionId: string): void {
    if (!this.pendingReservations.has(reservation.id)) return; // already committed or released
    this.pendingReservations.delete(reservation.id);
    this.committed.set(reservation.id, sessionId);
    this.bySessionId.set(sessionId, reservation.id);
  }

  /** Free a reservation that never became a resident session (failed startup). Idempotent. */
  release(reservation: Reservation): void {
    this.pendingReservations.delete(reservation.id);
    const sessionId = this.committed.get(reservation.id);
    if (sessionId !== undefined) {
      this.committed.delete(reservation.id);
      this.bySessionId.delete(sessionId);
    }
  }

  /** Free a committed reservation by session id (stop/remove teardown). Idempotent — a no-op if unknown. */
  releaseById(sessionId: string): void {
    const reservationId = this.bySessionId.get(sessionId);
    if (reservationId === undefined) return;
    this.bySessionId.delete(sessionId);
    this.committed.delete(reservationId);
  }
}

export interface TurnLease {
  /** Idempotent — a second call is a no-op, not a double-release of the slot. */
  release(): void;
}

/**
 * FIFO semaphore bounding actively-streaming turns.
 *
 * `acquire()` queues rather than rejecting at the concurrency cap — a
 * session whose turn is next in line should wait its turn, not be told to
 * retry. It only rejects outright when the QUEUE itself is full
 * (`maxQueuedTurns`), which bounds unbounded waiter buildup during a
 * sustained overload rather than the normal case of "busy right now".
 */
export class TurnSemaphore {
  private activeCount = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {}

  running(): number {
    return this.activeCount;
  }

  queued(): number {
    return this.waiters.length;
  }

  acquire(): Promise<TurnLease> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      return Promise.resolve(this.makeLease());
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(
        new AdmissionError(
          `turn queue full (${this.waiters.length}/${this.maxQueued} waiting)`,
          "turn_queue_full",
        ),
      );
    }
    return new Promise<TurnLease>((resolve) => {
      this.waiters.push(() => resolve(this.makeLease()));
    });
  }

  private makeLease(): TurnLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const next = this.waiters.shift();
        if (next) {
          // Hand the slot directly to the next waiter — activeCount stays
          // the same (one holder leaves, one enters), so this line never
          // touches activeCount.
          next();
        } else {
          this.activeCount--;
        }
      },
    };
  }
}
