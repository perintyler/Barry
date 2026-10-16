import { expect, it } from "vitest";
import { generateMcpConfig } from "../src/mcp-config.js";

it("binds generated stdio launches to the selected identity using the runtime flag", () => {
  const config = generateMcpConfig("stdio", 17);
  expect(config.mcpServers.barry.args?.slice(-3)).toEqual(["--stdio", "--identity-id", "17"]);
  expect(config.mcpServers.barry.env).not.toHaveProperty("BARRY_SECRET");
  expect(generateMcpConfig("stdio").mcpServers.barry.args).not.toContain("--identity-id");
});

it.each([0, -1, NaN, Infinity, 1.5])("refuses an invalid stdio identity key %s", identityId => {
  expect(() => generateMcpConfig("stdio", identityId)).toThrow("positive local identity key");
});

it("passes the active harness so stdio can enforce harness-specific bounds", () => {
  expect(generateMcpConfig("stdio", 17, "acceptance").mcpServers.barry.args?.slice(-2)).toEqual(["--harness", "acceptance"]);
});
