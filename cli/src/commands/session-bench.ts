import {loadavg} from "node:os";
import { currentTarget, assertOwnedSession } from "../target.js";
import { Sessions } from "@barry-rocks/sessions-bag/client";
import WebSocket from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getServiceUrl } from "@barry-rocks/sdk/services";
import { postSessionMessage, type SessionApi } from "../sessions/launch.js";

/** Same ingress-relative names as btui --timing; clocks never cross machines. */
export class BenchTurn {
  private readonly started: number;
  private previous?: number;
  private admitted = false;
  private terminal = false;
  finishAdmission():boolean {this.admitted=true;return this.terminal;}
  private readonly gaps: number[] = [];
  readonly result: Record<string, unknown> = { frames: 0, chars: 0, bytes: 0 };
  constructor(private readonly now = () => performance.now()) { this.started = now(); }
  mark(name: string): void { this.result[name] ??= this.now() - this.started; }
  observe(frame: {type?:string;content?:unknown;role?:string;status?:string;metadata?:{timing?:unknown}}): boolean {
    const now = this.now();

    this.result.frames = Number(this.result.frames) + 1;
    this.result.bytes = Number(this.result.bytes) + Buffer.byteLength(JSON.stringify(frame));
    if (frame.type === "partial" || frame.type === "thinking") {
      if (this.previous !== undefined) this.gaps.push(now - this.previous);
      this.previous = now;
      this.result.chars = Number(this.result.chars) + String(frame.content ?? "").length;
      this.mark(frame.type === "partial" ? "first_partial_ms" : "first_thinking_ms");
    }
    if (frame.type === "text" && frame.role !== "user") this.mark("final_text_ms");
    if (frame.type === "status") {
      if (frame.status === "starting" || frame.status === "streaming") this.mark(`${frame.status}_ms`);
      if (["waiting","complete","error"].includes(frame.status??"")) {
        this.terminal=true;this.result.status=frame.status;
        this.mark("waiting_ms"); this.result.server = frame.metadata?.timing ?? {};
        const gaps = [...this.gaps].sort((a,b) => a-b);
        for (const [name, q] of [["p50", .5], ["p95", .95], ["max", 1]] as const) this.result[`gap_${name}_ms`] = gaps[Math.max(0, Math.ceil(gaps.length*q)-1)] ?? 0;
        return this.admitted || this.result.post_rtt_ms!==undefined;
      }
    }
    return false;
  }
}
export interface BenchOptions { prompts: string[]; repeat?: string; json?: boolean; ps?: boolean }
export async function sessionBenchCommand(sessionId: string, options: BenchOptions, apiOverride?: SessionApi): Promise<void> {
  const target = currentTarget();
  if (target.kind === "identity") assertOwnedSession(await Sessions.get(sessionId), target.binding.id);
  const repeat = Number(options.repeat ?? 1);
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 100) throw new Error("--repeat must be between 1 and 100");
  const base = apiOverride?.base ?? `${getServiceUrl("api")}/api/v1`;
  const headers: Record<string,string> = { "Content-Type": "application/json", ...(apiOverride?.headers ?? (process.env.BARRY_SECRET ? { Authorization: `Bearer ${process.env.BARRY_SECRET}` } : {})) };
  const url = new URL(base); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/api/v1/ws";
  const socket = new WebSocket(url, { headers });
  socket.on("error", () => {});
  try {
    await new Promise<void>((resolve,reject) => {
      const timeout = setTimeout(() => reject(new Error("Benchmark subscription timed out")), 15_000);
      const cleanup = () => { clearTimeout(timeout); socket.off("message", message); socket.off("error", fail); };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const message = (data: WebSocket.RawData) => { try { const f=JSON.parse(String(data)); if(f.type==="subscribed" && f.sessionId===sessionId){cleanup(); resolve();} } catch { /* Ignore malformed unrelated frames. */ } };
      socket.on("message",message); socket.once("error",fail);
      socket.once("open",()=>socket.send(JSON.stringify({type:"subscribe",sessionId})));
    });
    for(let i=0;i<repeat;i++) for(const prompt of options.prompts) {
      const turn = new BenchTurn();
      let complete!: () => void, failed!: (error: Error) => void;
      const done = new Promise<void>((resolve,reject)=>{complete=resolve;failed=reject;});
      const timeout = setTimeout(()=>failed(new Error("Benchmark turn timed out")),180_000);
      const message = (data: WebSocket.RawData) => { try { const f=JSON.parse(String(data)); if(f.sessionId!==sessionId)return; if(f.type==="error") { failed(new Error(f.error??f.content??"Turn failed")); return; } if(turn.observe(f))complete(); } catch(error){failed(error as Error);} };
      const disconnected = () => failed(new Error("Benchmark socket disconnected"));
      socket.on("close",disconnected);
      socket.on("message",message);
      try {
        await Promise.all([postSessionMessage(sessionId,{content:prompt},{base,headers,fetch:apiOverride?.fetch}).then(async response=>{turn.mark("post_rtt_ms"); if(turn.finishAdmission())complete(); if(!response.ok)throw new Error(`Benchmark admission failed (${response.status}): ${await response.text()}`);}),done]);
        turn.result.load_average=loadavg();
        if(options.ps){
          const health=await (apiOverride?.fetch??fetch)(`${new URL(base).origin}/health`,{headers,signal:AbortSignal.timeout(3000)});
          const {pid}=await health.json() as {pid?:number};
          const {stdout}=await promisify(execFile)("ps",["-axo","pid=,ppid=,comm="]);
          turn.result.claude_processes=typeof pid==="number"?countClaudeDescendants(stdout,pid):null;
        }
        console.log(options.json ? JSON.stringify(turn.result) : Object.entries(turn.result).map(([key,value])=>`${key}: ${typeof value==="object"?JSON.stringify(value):typeof value==="number"?value.toFixed(1):value}`).join(" · "));
      } finally { clearTimeout(timeout); socket.off("message",message); socket.off("close",disconnected); }
    }
  } finally { socket.terminate(); }
}

export function countClaudeDescendants(stdout:string,root:number):number {
 const rows=stdout.split("\n").map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean).map(m=>({pid:Number(m![1]),parent:Number(m![2]),name:m![3]!}));
 const owned=new Set([root]);let changed=true;while(changed){changed=false;for(const row of rows)if(owned.has(row.parent)&&!owned.has(row.pid)){owned.add(row.pid);changed=true;}}
 return rows.filter(row=>owned.has(row.pid)&&/(^|\/)claude(?:$|\s|\/versions\/)/.test(row.name)).length;
}
