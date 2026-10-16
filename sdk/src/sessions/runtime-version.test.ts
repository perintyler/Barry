import { expect, it, vi } from "vitest";
import { withRuntimeVersion } from "./runtime-version.js";
import type { Session } from "./index.js";
import { testAdapter } from "../adapters/harnesses/index.js";
it("adds launch evidence without mutating a frozen session or losing optional capabilities", async () => {
  const close = vi.fn(async () => {}), touch = vi.fn();
  const session: Session = Object.freeze({ id: "s", harnessSessionId: null, harnessVersion: null, mode: "hosted", guarantees: testAdapter().modes.guest!.guarantees,
    warnings: ["existing"], events: async function* () {}, deliver: async () => ({ messageId: "m", status: "started" as const }), interrupt: async () => {}, answer: async () => {}, status: () => "idle" as const, close, touch });
  const wrapped = withRuntimeVersion(session, { status: "untested", recommendedVersion: "1.0.0", observedVersion: "1.1.0", tested: false, binary: "/selected/cli" }, "version notice");
  expect(wrapped.warnings).toEqual(["existing", "version notice"]);
  expect(wrapped.runtimeVersion?.binary).toBe("/selected/cli");
  expect(wrapped.compact).toBeUndefined();
  wrapped.touch!(); await wrapped.close();
  expect(touch).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  expect(session).not.toHaveProperty("runtimeVersion");
  expect(withRuntimeVersion({ ...session, warnings: undefined }, { status: "supported", recommendedVersion: "1.0.0", tested: true }).warnings).toBeUndefined();
});
