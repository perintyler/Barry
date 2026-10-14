import { expect, it } from "vitest";
import * as bags from "../index.js";
import * as tools from "../../tools/index.js";

it("keeps manifest APIs in bags and tool construction in the tools entry", () => {
  expect(bags.parseManifestObject).toBeTypeOf("function");
  expect(tools.defineTool).toBeTypeOf("function");
  expect(tools.isMcpResult).toBeTypeOf("function");
  expect(bags).not.toHaveProperty("defineTool");
  expect(bags).not.toHaveProperty("isMcpResult");
});
