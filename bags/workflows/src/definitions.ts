import { z } from "zod";
import { activity, sleep, signal, type Activity, type WorkflowDefinition } from "@barry-rocks/sdk/internal/workflows";

export const definitions: WorkflowDefinition[] = [{
  type: "echo", version: "1",
  *run(input) {
    const options = z.object({ message: z.json(), delayMs: z.number().int().nonnegative().default(0), waitForSignal: z.boolean().default(false) }).parse(input);
    if (options.delayMs) yield sleep(options.delayMs);
    if (options.waitForSignal) yield signal("continue");
    return yield activity("echo@1", options.message);
  },
}];
export const activities: Record<string, Activity> = { "echo@1": async input => input };
