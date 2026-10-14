import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const exercise = `
import { fireEventHooks, setEventHookDispatcher } from './src/hooks.ts';
const payload = { event: 'event-created', id: 'diagnostic-event', record: {} };
setEventHookDispatcher(async () => [{ bag: 'diagnostic-bag', ok: false, durationMs: 1, reason: 'hook refused' }]);
const hooks = await fireEventHooks(payload);
setEventHookDispatcher(async () => { throw new Error('dispatcher refused'); });
const dispatch = await fireEventHooks(payload);
process.stdout.write(JSON.stringify({ hookCount: hooks.length, dispatchCount: dispatch.length }));
`;

for (const level of ["info", "silent"]) {
  it(`routes event hook failures through structured stderr at LOG_LEVEL=${level}`, () => {
    const scratch = mkdtempSync(join(tmpdir(), "event-log-"));
    try {
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", exercise], {
        cwd: resolve(import.meta.dirname, ".."),
        env: { PATH: process.env.PATH, HOME: scratch, BARRY_HOME: scratch, TMPDIR: scratch, LOG_LEVEL: level, NODE_NO_WARNINGS: "1" },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ hookCount: 1, dispatchCount: 0 });
      if (level === "silent") {
        expect(child.stderr).toBe("");
      } else {
        const lines = child.stderr.trim().split("\n").map(line => JSON.parse(line));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ service: "events.hooks", level: 40, msg: "events.hook_failed" });
        expect(lines[0].detail).toContain("hook refused");
        expect(lines[1]).toMatchObject({ service: "events.hooks", level: 40, msg: "events.hook_dispatch_failed" });
        expect(lines[1].detail).toContain("dispatcher refused");
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
