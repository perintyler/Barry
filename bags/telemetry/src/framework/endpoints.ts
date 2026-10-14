// Resolve service addresses from the instance registry so collectors follow configured ports.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-052
import { serviceAddress } from "@barry-rocks/sdk/services";

/** Base URL for the Barry API (`sessions.api`), from the instance registry. */
export function apiBaseUrl(): string {
  return `${serviceAddress("sessions.api")}/api/v1`;
}

// Authenticated API scrapes require the instance secret; an absent secret is a configuration failure.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-053
export function apiSecret(): string | undefined {
  return process.env.BARRY_SECRET || undefined;
}
