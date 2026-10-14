/**
 * Deliver one scheduled prompt (see src/scheduled-prompts.ts). Inputs arrive
 * on stdin; the one-off's id, BARRY_SCHEDULE_ID, keys the message so an
 * at-least-once re-run never delivers it twice.
 */
import { readFileSync } from "node:fs";
import { getServiceUrl } from "@barry-rocks/sdk/services";
import { deliverScheduledPrompt, type DeliveryInputs } from "../../src/scheduled-prompts.js";

const inputs = JSON.parse(readFileSync(0, "utf8")) as DeliveryInputs;
// Looked up when the action runs, from this instance's registry: no override
// variable, because a stale one is how a job ends up calling another instance.
try {
  console.log(await deliverScheduledPrompt(inputs, { apiBase: `${getServiceUrl("api")}/api/v2/sessions`, secret: process.env.BARRY_SECRET, scheduleId: process.env.BARRY_SCHEDULE_ID, fetch }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
