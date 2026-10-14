/** Report delivery guarantees from the registered listener and declared mode.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */

/**
 * How a message reaches a recipient, worst case.
 *
 * Ordered weakest to strongest below in {@link DELIVERY_RANK}; where a session
 * has several live listeners the strongest wins, because that is the one that
 * will actually carry the message.
 */
export const DELIVERY_GUARANTEES = [
  /** Nothing will carry it. It stays pending and the sender is told so. */
  "none",
  /** Delivered when the session is next resumed. */
  "on-resume",
  /** Appended to the session's next Barry MCP tool result (the old floor). */
  "tool-call",
  /** Delivered when the session's current turn ends. */
  "turn-end",
  /**
   * Starts a turn in an idle session, but the vendor frames it as peer mail
   * rather than as the user (claude's cross-session inbox socket).
   */
  "wake-peer-framed",
  /** Starts a turn in an idle session, framed as a user turn. */
  "wake",
] as const;

export type DeliveryGuarantee = (typeof DELIVERY_GUARANTEES)[number];

/**
 * Strength order, used to pick between a session's live listeners.
 *
 * A session can have several at once — a hosted runtime relay AND a terminal
 * socket — and the sender must be told what will really happen, which is
 * whatever the strongest surface does.
 */
const DELIVERY_RANK = new Map<DeliveryGuarantee, number>(
  DELIVERY_GUARANTEES.map((guarantee, rank) => [guarantee, rank]),
);

export function isDeliveryGuarantee(value: unknown): value is DeliveryGuarantee {
  return typeof value === "string" && DELIVERY_RANK.has(value as DeliveryGuarantee);
}

/** The stronger of two guarantees. */
export function strongestGuarantee(
  a: DeliveryGuarantee,
  b: DeliveryGuarantee,
): DeliveryGuarantee {
  return (DELIVERY_RANK.get(a) ?? 0) >= (DELIVERY_RANK.get(b) ?? 0) ? a : b;
}

/**
 * What kind of surface is listening.
 *
 * `runtime` is the API's in-process relay (hosted sessions), `terminal` a
 * vendor TUI Barry can write into (claude's inbox socket), `hook` a held
 * vendor hook long-polling the inbox (cursor), `client` an interactive app
 * (desktop, mobile, web) connected over the app protocol.
 */
export const LISTENER_KINDS = ["runtime", "terminal", "hook", "engine", "client"] as const;
export type ListenerKind = (typeof LISTENER_KINDS)[number];

export function isListenerKind(value: unknown): value is ListenerKind {
  return typeof value === "string" && (LISTENER_KINDS as readonly string[]).includes(value);
}

/** A surface that has claimed it can deliver to a session. */
export interface Listener {
  sessionId: string;
  kind: ListenerKind;
  guarantee: DeliveryGuarantee;
  /** When the surface last proved it was alive, epoch ms. */
  lastWaitAt: number;
}
