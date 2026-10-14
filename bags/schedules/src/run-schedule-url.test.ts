import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@barry-rocks/sdk/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@barry-rocks/sdk/services")>()),
  getServiceUrl: () => "http://example.test",
}));

import { runScheduleUrl } from "./tools.js";

/**
 * BAG-19: run_schedule must build its URL from getServiceUrl("api"), the same
 * source the scheduler's runners use, so a host or scheme change moves both
 * paths together instead of leaving run_schedule on a hard-coded
 * http://127.0.0.1:<port>.
 */
describe("runScheduleUrl (BAG-19)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("derives the base from getServiceUrl, encoding the bag segment", () => {
    expect(runScheduleUrl("ops/nightly")).toBe("http://example.test/api/v1/schedules/ops/nightly/run");
  });

  it("encodes a bag that itself contains a slash into one segment", () => {
    expect(runScheduleUrl("sessions/search/embed")).toBe(
      "http://example.test/api/v1/schedules/sessions%2Fsearch/embed/run",
    );
  });

  it("rejects an id without a bag/name shape", () => {
    expect(() => runScheduleUrl("noslash")).toThrow(/<bag>\/<name>/);
  });
});
