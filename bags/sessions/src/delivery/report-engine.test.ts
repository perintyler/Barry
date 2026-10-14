/** Delivery reports must check engine liveness even while a listener registration remains.
 * Rationale: docs/decisions/0034-adapter-build-capture-and-relay-rationale.md.
 */

import { describe, it, expect } from "vitest";
import { reportDelivery } from "./report.js";

describe("reporting delivery when an engine is involved", () => {
  it("reports on-resume when the engine is gone, even with a live listener", () => {
    // The listener is what would otherwise answer `wake`, so the engine check
    // has to come first.
    const report = reportDelivery({
      listenerGuarantee: "wake",
      active: true,
      engineAlive: false,
    });

    expect(report.delivery).toBe("on-resume");
    expect(report.explanation).toMatch(/engine is no longer running/);
  });

  it("still reports wake when the engine is running", () => {
    expect(
      reportDelivery({ listenerGuarantee: "wake", active: true, engineAlive: true }).delivery,
    ).toBe("wake");
  });

  it("does not treat a session without an engine as one with a dead engine", () => {
    // A guest-tier session runs in a vendor binary Barry never started. If
    // "no engine" read as "dead engine", every claude guest-plus sender would
    // be told on-resume for a session that is sitting there ready to wake.
    expect(
      reportDelivery({ listenerGuarantee: "wake-peer-framed", active: true }).delivery,
    ).toBe("wake-peer-framed");
  });

  it("prefers the session being closed over the engine's state", () => {
    // Both say on-resume, but a closed session is the more basic fact and
    // should not depend on an engine probe having run.
    expect(
      reportDelivery({ listenerGuarantee: "wake", active: false, engineAlive: true }).delivery,
    ).toBe("on-resume");
  });
});
