import { describe, expect, it } from "vitest";
import { isSummaryDue, summaryText } from "./session-summarizer.js";

describe("summaryText", () => {
  it("keeps a clean summary as it is", () => {
    const clean = "### Done\n- Moved the harnesses\n\n### Open Loops\n1. **OL-a3f2c1** - Rebase the plan";
    expect(summaryText(clean)).toBe(clean);
  });

  it("drops reasoning narrated before the first section", () => {
    // What qwen3:4b wrote for a real session: prose deliberation, then the sections.
    const raw = "We are given a conversation history of 36 messages.\n\nLet's analyze it.\n\n### Done\n- Verified the move";
    expect(summaryText(raw)).toBe("### Done\n- Verified the move");
  });

  it("drops a thinking block, closed or cut off", () => {
    expect(summaryText("<think>hmm</think>\n### Done\n- x")).toBe("### Done\n- x");
    expect(summaryText("### Done\n- x\n<think>and then")).toBe("### Done\n- x");
  });

  it("stores nothing when none of the sections came back", () => {
    expect(summaryText("We are given a conversation history. The user wants a summary.")).toBeNull();
    expect(summaryText("")).toBeNull();
  });
});

describe("the summary sweep", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const session = (minutesAgo: number | null, watermark?: number) => ({ id: "s", last_message_at: minutesAgo === null ? null : at(minutesAgo), metadata: { summary_watermark_seq: watermark } });

  it("is due once a session gained messages and fell quiet", () => {
    expect(isSummaryDue(session(20), 5, now)).toBe(true);
    expect(isSummaryDue(session(20, 5), 6, now)).toBe(true);
  });

  it("waits while a session is active, and skips one with nothing new", () => {
    expect(isSummaryDue(session(5), 5, now)).toBe(false);
    expect(isSummaryDue(session(20, 5), 5, now)).toBe(false);
    expect(isSummaryDue(session(null), 5, now)).toBe(false);
  });

  it("leaves sessions older than the lookback alone, so a first sweep does not summarize history", () => {
    expect(isSummaryDue(session(60 * 25), 5, now)).toBe(false);
    expect(isSummaryDue(session(60 * 25), 5, now, { lookbackMs: 48 * 3_600_000 })).toBe(true);
  });
});
