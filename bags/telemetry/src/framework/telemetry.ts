// All extension points read the same live registry so registrations remain observable.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-071

import { TelemetryRegistry } from "./registry.js";
import { METRICS } from "../schema.js";

/** This bag's name, as it appears in collision messages. */
export const BAG = "telemetry";

// Keep one process-wide registry rather than independently initializing extension consumers.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-072
export const registry = new TelemetryRegistry();
registry.seedMetrics(BAG, Object.values(METRICS));
