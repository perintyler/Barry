import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { fencedCodeLines } from "./markdown-code-lines.mjs";

test("literal fenced examples do not hide a real link after the fence", () => {
  deepEqual(fencedCodeLines(["Before", "```text", "[file](file)", "```", "[real](missing.md)"]), [false, true, true, true, false]);
});
test("nested shorter fences and mismatched characters do not close a fence", () => {
  deepEqual(fencedCodeLines(["````text", "```", "~~~", "[file](file)", "````", "After"]), [true, true, true, true, true, false]);
});
