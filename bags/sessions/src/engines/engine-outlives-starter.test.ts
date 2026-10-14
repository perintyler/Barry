/** Closing a terminal must not stop the separately owned session engine.
 * Rationale: docs/decisions/0034-adapter-build-capture-and-relay-rationale.md.
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join("/tmp", "be-outlive-")));
const started: number[] = [];

afterAll(() => {
  for (const pid of started) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone — which is the successful case for the attached child.
    }
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupOf(pid: number): number {
  const out = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout;
  return Number(out.trim());
}

/**
 * Spawn a child the way `startEngine` does, from a real intermediate process
 * that then exits. Returns the child's pid and the starter's own group.
 */
function spawnViaStarter(detached: boolean): { child: number; starterGroup: number } {
  const script = join(dir, `starter-${detached}.mjs`);
  writeFileSync(
    script,
    `import { spawn, spawnSync } from "node:child_process";
     const child = spawn("sleep", ["30"], { detached: ${detached}, stdio: "ignore" });
     ${detached ? "child.unref();" : ""}
     const starterGroup = Number(
       spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim(),
     );
     console.log(JSON.stringify({ child: child.pid, starterGroup }));
     process.exit(0);
    `,
  );
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  const parsed = JSON.parse(result.stdout.trim()) as { child: number; starterGroup: number };
  started.push(parsed.child);
  return parsed;
}

describe("surviving the terminal that started it", () => {
  it("puts the engine in its own process group, so a terminal's signal misses it", () => {
    const { child, starterGroup } = spawnViaStarter(true);

    expect(alive(child)).toBe(true);
    expect(processGroupOf(child)).toBe(child);
    expect(processGroupOf(child)).not.toBe(starterGroup);
  });

  it("NEGATIVE CONTROL: without detaching, the engine shares its starter's group", () => {
    // What the bug looks like: the engine sits in the group a terminal
    // teardown signals, so the conversation ends when the window closes.
    // Deleting `detached: true` from startEngine turns the assertion above
    // into this one — which is how we know that assertion can fail.
    const { child, starterGroup } = spawnViaStarter(false);

    expect(processGroupOf(child)).toBe(starterGroup);
    expect(processGroupOf(child)).not.toBe(child);
  });

  it("is not in the group a terminal would signal", () => {
    // The consequence, stated as the group relationship rather than by firing
    // a real group signal.
    //
    // DO NOT signal the starter's group here. An un-detached starter inherits
    // the group of whatever launched it — under vitest, that is the TEST
    // RUNNER's group, so `process.kill(-starterGroup)` kills vitest itself.
    // It did: the suite exited 144 with no failure reported, which reads as
    // infrastructure flakiness rather than as a test doing exactly what it
    // said. The relationship below is the same fact, checkable without
    // detonating it.
    const attached = spawnViaStarter(false);
    const detached = spawnViaStarter(true);

    // A signal to `-attached.starterGroup` would reach the attached child...
    expect(processGroupOf(attached.child)).toBe(attached.starterGroup);
    // ...and could not reach the detached one, whose group is its own pid.
    expect(processGroupOf(detached.child)).toBe(detached.child);
    expect(alive(detached.child)).toBe(true);
  });
});
