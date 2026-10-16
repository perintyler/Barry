import { expect, it } from "vitest";
import { createSDKMessageMapper } from "./event-mapping.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
it("carries SDK stream timing into done without retaining a previous turn", () => {
  const map=createSDKMessageMapper();
  [...map({type:"stream_event",event:{type:"message_start"},ttft_ms:12} as unknown as SDKMessage)];
  const result={type:"result",subtype:"success",result:"hi",usage:{input_tokens:1,output_tokens:2},ttft_stream_ms:20,time_to_request_ms:3} as unknown as SDKMessage;
  expect([...map(result)]).toContainEqual(expect.objectContaining({type:"done",sdk:{ttft_ms:12,ttft_stream_ms:20,time_to_request_ms:3}}));
  expect([...map({type:"result",subtype:"success",result:"hi",usage:{input_tokens:1,output_tokens:2}} as unknown as SDKMessage)]).toContainEqual(expect.objectContaining({type:"done",usage:expect.any(Object)}));
  expect([...map({type:"result",subtype:"success",result:"hi",usage:{input_tokens:1,output_tokens:2}} as unknown as SDKMessage)].find(e=>e.type==="done")).not.toHaveProperty("sdk");
});

it("streams thinking, ignores signatures and attributes nested thinking", () => {
  const map=createSDKMessageMapper();
  const event=(delta:object)=>({type:"stream_event",parent_tool_use_id:"parent",event:{type:"content_block_delta",index:0,delta}} as unknown as SDKMessage);
  expect([...map(event({type:"thinking_delta",thinking:"summary"}))]).toEqual([{type:"thinking",text:"summary",parentToolUseId:"parent"}]);
  expect([...map(event({type:"signature_delta",signature:"private"}))]).toEqual([]);
});

it("keeps input deltas opt-in and correlates blocks by parent and index", async () => {
  const {vi}=await import("vitest"); const map=createSDKMessageMapper();
  const frame=(event:object,parent:string|null=null)=>({type:"stream_event",parent_tool_use_id:parent,event} as unknown as SDKMessage);
  [...map(frame({type:"content_block_start",index:2,content_block:{type:"tool_use",id:"outer"}}))];
  [...map(frame({type:"content_block_start",index:2,content_block:{type:"tool_use",id:"nested"}},"parent"))];
  const delta={type:"content_block_delta",index:2,delta:{type:"input_json_delta",partial_json:'{"a":'}};
  expect([...map(frame(delta))]).toEqual([]);
  vi.stubEnv("BARRY_TOOL_INPUT_STREAMING","1");
  try {
    expect([...map(frame(delta))]).toEqual([{type:"tool_input_delta",id:"outer",text:'{"a":'}]);
    expect([...map(frame(delta,"parent"))]).toEqual([{type:"tool_input_delta",id:"nested",text:'{"a":',parentToolUseId:"parent"}]);
    [...map(frame({type:"content_block_stop",index:2}))];expect([...map(frame(delta))]).toEqual([]);
  } finally { vi.unstubAllEnvs(); }
});
it("joins adjacent final text blocks exactly as their partial deltas",()=>{
 const map=createSDKMessageMapper();
 const assistant={type:"assistant",message:{content:[{type:"text",text:"A"},{type:"text",text:"B"}]},parent_tool_use_id:null} as SDKMessage;
 expect([...map(assistant)]).toEqual([{type:"text",role:"assistant",text:"AB"}]);
});
it("clears prior SDK timing on message_start even if no result ended the previous turn",()=>{
 const map=createSDKMessageMapper();
 [...map({type:"stream_event",event:{type:"message_start"},ttft_ms:42} as unknown as SDKMessage)];
 [...map({type:"stream_event",event:{type:"message_start"}} as SDKMessage)];
 expect([...map({type:"result",subtype:"success",result:"hi",usage:{input_tokens:1,output_tokens:2}} as SDKMessage)].find(event=>event.type==="done")).not.toHaveProperty("sdk");
});
