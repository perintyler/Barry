// A panel returns either measured data or an explicit unavailable reason.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-059

// Unavailable, empty and zero are distinct panel states.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-060
export type Panel<T> =
  | { state: "ok"; data: T; ms: number }
  | { state: "empty"; explanation: string }
  | { state: "unavailable"; reason: string }
  | { state: "partial"; data: T; caveat: string; ms: number };