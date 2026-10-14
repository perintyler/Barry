import { test } from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import { commentsPlugin } from "./comments-plugin.mjs";

const lint = code => new Linter().verify(code, { plugins: { comments: commentsPlugin }, rules: { "comments/no-banner-comment": "error" } });
test("rejects dated diary comments and both historical openings", () => {
  for (const comment of ["This used to open twice", "It used to race", "Found 2026-10-09", "measured 2026-10-09", "A fixture from 2026-10-09"]) {
    assert.equal(lint(`// ${comment}\nconst value = 1;`).length, 1);
    assert.equal(lint(`/* ${comment} */\nconst value = 1;`).length, 1);
  }
});
test("requires a nonempty reason for a dated invariant", () => {
  assert.equal(lint("// 2026-10-09 -- why:\nconst value = 1;").length, 1);
  assert.equal(lint("// 2026-10-09 -- why: protocol fixture version\nconst value = 1;").length, 0);
});
test("keeps banner removal and ignores dates inside executable strings", () => {
  assert.equal(lint("// ========\nconst value = '2026-10-09';")[0].messageId, "banner");
  assert.equal(lint("const value = 'This used to be 2026-10-09';").length, 0);
});
