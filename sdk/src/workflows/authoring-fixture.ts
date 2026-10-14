import { activity, type WorkflowDefinition } from "./dsl.js";
export const definitions: WorkflowDefinition[] = [{ type: "bundled", version: "1", *run(input) { return yield activity("echo", input); } }];
