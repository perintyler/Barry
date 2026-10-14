import { afterEach, expect, it, vi } from "vitest";
import { createBootstrapLogger } from "./emit-bootstrap.js";
import { parseLine } from "./format.js";

afterEach(() => vi.restoreAllMocks());
it("keeps child diagnostics on stderr with parser-compatible fields and redaction", () => {
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  createBootstrapLogger("workflow-child").child({ run: "r1" }).warn("workflow.output", { token: "private-token-value" });
  expect(write).toHaveBeenCalledOnce();
  const line = String(write.mock.calls[0][0]);
  const entry = JSON.parse(line) as { level: number; service: string; run: string; token: string };
  expect(entry).toMatchObject({ level: 40, service: "workflow-child", run: "r1" });
  expect(entry.token).not.toContain("private-token-value");
  expect(parseLine(line, "workflow-child")).toMatchObject({ service: "workflow-child", level: 40, msg: "workflow.output" });
});
