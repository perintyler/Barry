import { expect, it } from "vitest";
import { BenchTurn } from "./session-bench.js";
it("measures independently timed model frames and waiting summaries", () => {
  let now=0; const turn=new BenchTurn(()=>now);
  now=10; turn.mark("post_rtt_ms"); now=20; turn.observe({type:"status",status:"starting"});
  now=30; turn.observe({type:"thinking",content:"hmm"}); now=40; turn.observe({type:"partial",content:"hi"});
  now=50; expect(turn.observe({type:"status",status:"waiting",metadata:{timing:{warm_hit:1}}})).toBe(true);
  expect(turn.result).toMatchObject({post_rtt_ms:10,starting_ms:20,first_thinking_ms:30,first_partial_ms:40,waiting_ms:50,frames:4,chars:5,gap_p95_ms:10,server:{warm_hit:1}});
});

it("subscribes before POST and checks admission with a fake socket server", async () => {
  const { WebSocketServer } = await import("ws");
  const { sessionBenchCommand } = await import("./session-bench.js");
  const { vi } = await import("vitest");
  const server = new WebSocketServer({port:0});
  await new Promise<void>(resolve=>server.once("listening",resolve));
  let subscribed=false;
  server.on("connection",socket=>socket.on("message",()=>{subscribed=true;socket.send(JSON.stringify({type:"subscribed",sessionId:"bench"}));}));
  const address=server.address();if(typeof address==="string"||!address)throw new Error("missing address");
  const request=vi.fn<typeof fetch>(async (_url,init)=>{
    expect(subscribed).toBe(true);expect(init?.headers).toMatchObject({"Content-Type":"application/json"});
    for(const socket of server.clients){
      for(const frame of [{type:"status",status:"streaming"},{type:"partial",content:"hi"},{type:"status",status:"waiting",metadata:{timing:{warm_hit:1}}}])socket.send(JSON.stringify({...frame,sessionId:"bench"}));
    }
    return new Response("{}",{status:202});
  });
  const print=vi.spyOn(console,"log").mockImplementation(()=>{});
  try {
    await sessionBenchCommand("bench",{prompts:["hi"],json:true},{base:`http://127.0.0.1:${address.port}/api/v1`,headers:{},fetch:request});
    expect(JSON.parse(String(print.mock.calls[0][0]))).toMatchObject({chars:2,frames:3,server:{warm_hit:1}});
    expect(request).toHaveBeenCalledOnce();
  } finally { print.mockRestore();server.close();for(const socket of server.clients)socket.terminate(); }
});
it("completes a model-less terminal status received while POST is in flight",()=>{
 const turn=new BenchTurn();expect(turn.observe({type:"status",status:"error"})).toBe(false);expect(turn.finishAdmission()).toBe(true);expect(turn.result.status).toBe("error");
});
it("counts Claude descendants of the API rather than unrelated sessions",async()=>{
 const {countClaudeDescendants}=await import("./session-bench.js");expect(countClaudeDescendants("1 0 /init\n2 1 /node\n3 2 /claude\n4 1 /claude\n5 3 /claude",2)).toBe(2);
});
it("recognizes the versioned native Claude executable beneath the API",async()=>{
 const {countClaudeDescendants}=await import("./session-bench.js");expect(countClaudeDescendants("2 1 /node\n3 2 /Users/me/.local/share/claude/versions/2.1.282",2)).toBe(1);
});
