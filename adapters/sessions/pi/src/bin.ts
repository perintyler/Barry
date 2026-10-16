import { resolveHarnessCommand } from "@barry-rocks/sdk/adapters/harnesses";
import { PI_REQUIREMENTS } from "./modes.js";

/** CLI operations use the same executable resolution as doctor. Hosted uses the SDK. */
export function resolvePiBin(): string {
  return resolveHarnessCommand(PI_REQUIREMENTS);
}
