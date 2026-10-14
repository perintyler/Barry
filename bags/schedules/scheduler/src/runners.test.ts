import { afterEach, expect, it, vi } from "vitest";
import type { ScheduleEntry } from "@barry-rocks/schedules-bag";
import { runAgent } from "./runners.js";

vi.mock("@barry-rocks/sdk/services", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/services")>(),
  getServiceUrl: () => "http://example.test",
}));
afterEach(() => vi.unstubAllGlobals());

it("posts an extension schedule with its bag encoded as one URL segment", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "complete", run_id: "arn_1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const entry: ScheduleEntry = {
    id: "sessions/search/embed", bag: "sessions/search", name: "embed", dir: "/bags/sessions/extensions/search",
    schedule: { trigger: { kind: "cron", expression: "*/15 * * * *" }, payload: { kind: "ref", ref: "sessions/search:embed" },
      overlap: "skip", catchUp: "once", enabled: true },
  };
  expect(await runAgent(entry)).toMatchObject({ status: "complete", runId: "arn_1" });
  expect(fetch).toHaveBeenCalledWith("http://example.test/api/v1/schedules/sessions%2Fsearch/embed/run",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ trigger: "schedule" }) }));
});
