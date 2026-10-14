import { expect, it } from "vitest";
import { z } from "zod/v4";
import { buildCliSpec } from "./cli-adapter.js";

it("offers Zod 4 enum choices in the CLI", () => {
  const tool = { name: "paint", namespace: "test", access: "write" as const, description: "Paint", schema: { color: z.enum(["red", "blue"]) }, handler: async () => {} };
  // No @ts-expect-error any more: the authoring types targeted Zod 3 when this
  // was written, so a v4 enum did not typecheck. The workspace is on 4 now and
  // it does -- which is the migration working, not the test getting weaker.
  const spec = buildCliSpec(tool);
  expect(spec.options[0]).toMatchObject({ choices: ["red", "blue"], required: true });
});
