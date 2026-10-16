import { expect, it } from "vitest";
import { TurnTimer } from "./turn-timer.js";
it("keeps ingress-relative marks, first-event timing and socket distributions distinct", async () => {
  let now = 100;
  const timer = new TurnTimer(90, () => now);
  timer.mark("queue_ms"); now = 110; timer.event("thinking");
  now = 120; timer.event("partial"); now = 130; timer.event("partial");
  timer.sent(10, 129); now = 140; timer.sent(20, 138);
  expect(timer.summary()).toMatchObject({ queue_ms: 10, first_event_ms: 20, first_thinking_ms: 20,
    first_token_ms: 30, frames: 2, bytes: 30, ws_send_p95_ms: 2, gap_max_ms: 10 });
  await expect(timer.measure("record_ms", async () => { now += 7; throw new Error("busy"); })).rejects.toThrow("busy");
  expect(timer.summary().record_ms).toBe(7);
});

it("does not halve model cadence when the same event fans out to two sockets",()=>{
 let now=10;const timer=new TurnTimer(0,()=>now);timer.event("partial");timer.sent(10,9);now=11;timer.sent(10,9);
 now=30;timer.event("partial");timer.sent(10,29);now=31;timer.sent(10,29);
 expect(timer.summary()).toMatchObject({frames:4,bytes:40,gap_p50_ms:20,model_gap_p50_ms:20});
});
it("excludes tool execution and thinking-to-text transitions from chunk gap samples",()=>{
 let now=0;const timer=new TurnTimer(0,()=>now);timer.event("thinking");now=500;timer.event("partial");now=510;timer.event("partial");now=1000;timer.event("tool_start");now=9000;timer.event("partial");now=9010;timer.event("partial");expect(timer.summary().model_gap_max_ms).toBe(10);
});
