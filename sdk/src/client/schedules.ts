import { schedulesRoutes } from "../routes/schedules.js";
import { type OneOffRecord, type OneOffRequest } from "../schedules/types.js";
import { BarryApiError } from "./errors.js";
import type { ApiTransport, RequestOptions } from "./http.js";

export type OneOffSchedule = OneOffRecord;

export interface ScheduleOptions extends Pick<OneOffRequest, "identity" | "traits" | "bounds"> {
  /** A declared action, `bag:name` — a `run:` action for a script, or an agent's. */
  action: string;
  /** The action's inputs. At most 64 KB of JSON; a script gets them on stdin. */
  inputs?: Record<string, unknown>;
  /**
   * Unique per bag. Repeating the request returns the schedule it created, so
   * a call whose response was lost is safe to repeat.
   */
  idempotencyKey?: string;
  /** Default 600, at most 3600. */
  timeoutS?: number;
  /** Total attempts when the run fails, 1–5. Default 1: no retry. */
  attempts?: number;
}

/**
 * Run an action once, later. At least once: it may run twice after a crash,
 * so dedupe side effects on BARRY_SCHEDULE_ID. Recurring work is a
 * `schedules:` entry in bag.yaml instead. See bags/schedules/README.md.
 */
export class Schedules {
  private readonly http: ApiTransport;

  // A field, not a parameter property: strip-only type stripping cannot
  // transform those, and bundled bag code must load under plain Node.
  constructor(http: ApiTransport) {
    this.http = http;
  }

  async recurring(request: RequestOptions = {}) {
    return (await this.http.call(schedulesRoutes.listSchedules, {}, request))!;
  }

  async schedule(when: Date | string | number, options: ScheduleOptions, request: RequestOptions = {}): Promise<OneOffSchedule> {
    const due = when instanceof Date ? when : new Date(when);
    if (Number.isNaN(due.getTime())) {
      throw new BarryApiError(`Invalid time: ${String(when)}`, { status: null, code: "invalid_request" });
    }
    const created = await this.http.call(schedulesRoutes.createOneOffSchedule, { body: {
        action: options.action,
        dueAt: due.toISOString(),
        ...(options.identity === undefined ? {} : { identity: options.identity }),
        ...(options.traits === undefined ? {} : { traits: options.traits }),
        ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
        ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(options.timeoutS ? { timeoutS: options.timeoutS } : {}),
        ...(options.attempts ? { retry: { attempts: options.attempts } } : {}),
      } }, { ...request });
    return created!.schedule;
  }

  /** The schedule with every attempt, or null when no schedule has this id. */
  async get(id: string, request: RequestOptions = {}): Promise<OneOffSchedule | null> {
    const found = await this.http.call(schedulesRoutes.getOneOffSchedule, { params: { id: id } }, { ...request, notFound: "null" });
    return found?.schedule ?? null;
  }

  async list(options: { bag?: string; status?: OneOffSchedule["status"]; limit?: number } = {}, request: RequestOptions = {}): Promise<OneOffSchedule[]> {
    const page = await this.http.call(schedulesRoutes.listOneOffSchedules, { query: { ...options } }, { ...request });
    return page!.schedules;
  }

  /**
   * Stop a schedule. One that has not started is `cancelled`; a running one is
   * asked to stop (`cancelRequested`) — its script is killed — and ends
   * `cancelled`. Otherwise `status` says what it is instead.
   */
  async cancel(id: string, request: RequestOptions = {}): Promise<{ cancelled: boolean; status: OneOffSchedule["status"]; cancelRequested?: boolean }> {
    const result = await this.http.call(schedulesRoutes.cancelOneOffSchedule, { params: { id: id } }, request);
    return result!;
  }
}
