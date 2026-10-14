import { describe, it, expect } from "vitest";

import type { DescribedCommand, DescribedProgram } from "../src/describe.js";
import { run, runIdentity, stripAnsi } from "./run-cli.js";

/**
 * `__describe` feeds the generated CLI reference, so a quiet gap here becomes
 * a wrong page. The two things worth guarding: it describes what the scope
 * actually registers (checked against a real `--help`, not assumed), and it
 * leaves out what `--help` leaves out.
 */

const listed = (help: string) => new Set([...stripAnsi(help).matchAll(/^ {2}([a-z][a-z0-9-]*)\b/gm)].map((m) => m[1]).filter((name) => name !== "help"));
const find = (command: DescribedCommand, name: string) => command.commands.find((sub) => sub.name === name);

function describeScope(result: ReturnType<typeof run>): DescribedProgram {
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as DescribedProgram;
}

describe("__describe", () => {
  it("describes the system scope's commands exactly as --help lists them", () => {
    const described = describeScope(run("__describe"));
    expect(described).toMatchObject({ version: 1, scope: "system" });
    const names = new Set(described.program.commands.map((command) => command.name));
    expect(names).toEqual(listed(run("--help").stdout));
    // Negative control: the comparison sees a real difference.
    expect(new Set([...names, "not-a-command"])).not.toEqual(listed(run("--help").stdout));
  });

  it("describes the identity scope's persona commands", () => {
    const described = describeScope(runIdentity("__describe"));
    expect(described.scope).toBe("identity");
    const session = find(described.program, "session");
    const start = session && find(session, "start");
    expect(start?.options.map((option) => option.long)).toContain("--bound");
    // System-only commands are not part of a persona's surface.
    expect(find(described.program, "workers")).toBeUndefined();
  });

  it("carries arguments and option shapes, and leaves hidden commands out", () => {
    const described = describeScope(run("__describe"));
    const invite = find(find(described.program, "workers")!, "invite");
    expect(invite?.arguments).toEqual([expect.objectContaining({ name: "name", required: true, variadic: false })]);
    for (const hidden of ["hook", "__complete", "help"]) expect(find(described.program, hidden)).toBeUndefined();
  });
});
