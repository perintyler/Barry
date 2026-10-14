/**
 * The delivery calls: waiting on a session's inbox, the listeners that say
 * what a sender can be promised, and the wake budget that stops two sessions
 * waking each other in a loop.
 *
 * Their state is per-process by nature (a listener is a claim about a process
 * alive right now; a budget counts wakes from every sender), so one always-on
 * process holds it: the sessions API. It installs its own with `hostDelivery`
 * and answers these in-process; every other process asks it over HTTP.
 *
 * An API that cannot be reached is an error here, never an answer. Reporting
 * "no listeners" would tell a sender something nobody observed, and "budget
 * allowed" would let a loop through the one guard that exists to stop it.
 */

import { getServiceUrl } from "@barry-rocks/sdk/services";
import type { DeliveryGuarantee, Listener, ListenerKind } from "../delivery/guarantees.js";
import type { BudgetVerdict } from "../delivery/wake-budget.js";

/** What the live surfaces for each session can promise. */
export type SessionListeners = Record<string, { guarantee: DeliveryGuarantee; listeners: Listener[] }>;

/** The delivery host's answers, as the sessions API serves them. */
export interface Delivery {
  /** The sessions among `sessionIds` with a pending prompt, once one has one or the timeout passes. Peeks; never drains. */
  waitForPrompts(sessionIds: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<string[]>;
  registerListener(sessionId: string, kind: ListenerKind, guarantee: DeliveryGuarantee): Promise<void>;
  unregisterListener(sessionId: string, kind: ListenerKind): Promise<void>;
  getListeners(sessionIds: readonly string[]): Promise<SessionListeners>;
  /** Consume a wake from the budget, or learn that it is exhausted. */
  recordWake(sessionId: string, fromSession?: string | null): Promise<BudgetVerdict>;
  /** A prompt became pending for this session in this process: wake its waiters now rather than at their next store read. */
  promptQueued(sessionId: string): void;
}

let host: Delivery | null = null;

/** Make this process the delivery host. The sessions API calls it once, at startup. */
export function hostDelivery(delivery: Delivery): void {
  host = delivery;
}

/** Tell this process's delivery host, when it is one, that a prompt is pending. */
export function promptQueued(sessionId: string): void {
  host?.promptQueued(sessionId);
}

/**
 * How long a delivery call may take before the API counts as unreachable.
 * `/prompts/wait` blocks by design, so its deadline is its own timeout plus
 * this margin: sharing the short one would abort every long poll early and
 * read, from here, as an API that is permanently down.
 */
const REQUEST_TIMEOUT_MS = 5_000;

async function ask<T>(path: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.BARRY_SECRET) headers.Authorization = `Bearer ${process.env.BARRY_SECRET}`;
  let response: Response;
  try {
    response = await fetch(`${getServiceUrl("api")}/api/v1/prompts/${path}`, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`sessions API unreachable (prompts/${path}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`sessions API prompts/${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Block until one of `sessionIds` has a pending prompt, or the timeout. */
export const waitForPrompts = async (sessionIds: readonly string[], timeoutMs: number): Promise<string[]> =>
  host
    ? host.waitForPrompts(sessionIds, timeoutMs)
    : (await ask<{ ready: string[] }>("wait", { sessionIds, timeoutMs }, timeoutMs + REQUEST_TIMEOUT_MS)).ready;

/** Report that a delivery surface is alive and what it can promise. */
export const registerListener = async (
  sessionId: string,
  kind: ListenerKind,
  guarantee: DeliveryGuarantee,
): Promise<void> => {
  if (host) return host.registerListener(sessionId, kind, guarantee);
  await ask("listeners", { sessionId, kind, guarantee });
};

/** Report that a delivery surface has gone. */
export const unregisterListener = async (sessionId: string, kind: ListenerKind): Promise<void> => {
  if (host) return host.unregisterListener(sessionId, kind);
  await ask("listeners", { sessionId, kind, active: false });
};

/** What the live surfaces for these sessions can promise right now. */
export const getListeners = async (sessionIds: readonly string[]): Promise<SessionListeners> =>
  host ? host.getListeners(sessionIds) : (await ask<{ guarantees: SessionListeners }>("guarantee", { sessionIds })).guarantees;

/** Consume a wake from the budget, or learn that it is exhausted. */
export const recordWake = async (sessionId: string, fromSession?: string | null): Promise<BudgetVerdict> =>
  host ? host.recordWake(sessionId, fromSession) : ask<BudgetVerdict>("wake-budget", { sessionId, fromSession });
