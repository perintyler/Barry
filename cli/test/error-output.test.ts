import { describe, it, expect } from "vitest";

import { run, stripAnsi } from "./run-cli.js";

// Anticipated failures render one line unless debug is enabled; a regular-file parent fails safely on every platform.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-035
describe("expected failures do not print stack traces", () => {
  it("db backup reports an unwritable destination without a stack trace", () => {
    const { stdout, stderr } = run("db", "backup", "/etc/hosts/backup");
    const all = stripAnsi(stdout + stderr);

    expect(all, "internal stack frames leaked to the user").not.toMatch(/\s+at .+\(.*node_modules/);
    expect(all, "node internals leaked to the user").not.toMatch(/node:internal/);
    expect(all, "should still say what went wrong").toMatch(
      /ENOTDIR|ENOENT|EACCES|not a directory|no such file|permission denied/i,
    );
  });
});
