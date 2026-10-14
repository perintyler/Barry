import { z } from "zod";
import { defineTool } from "../define-tool.js";

// cliFormat sees the handler's own result type. If this ever widens back to
// `unknown`, the field access below stops compiling and the typecheck fails —
// which is the regression this file exists to catch.
export const inferred = defineTool({
  namespace: "test",
  access: "read",
  name: "inferred",
  description: "handler result reaches cliFormat typed",
  schema: { id: z.string() },
  handler: async ({ id }) => ({ id, count: 1 }),
  cliFormat: (result) => `${result.id}: ${result.count}`,
});
