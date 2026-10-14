import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** A deterministic Responses endpoint. It controls the model, never the vendor tool runtime. */
export async function scriptedModel(root: string) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    let input: Record<string, unknown>;
    try { input = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    requests.push(input); appendFileSync(join(root, "model-requests.jsonl"), JSON.stringify(input) + "\n");
    const history = input.input as Array<Record<string, unknown>>;
    const last = history?.at(-1);
    const prompt = JSON.stringify(last);
    const toolOutput = last?.type === "function_call_output" || last?.type === "custom_tool_call_output";
    const marker = JSON.stringify(history).match(/marker ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/)?.[1];
    const tools = input.tools as Array<Record<string, unknown>>;
    const namespace = tools?.find(tool => tool.type === "namespace" && tool.name === "mcp__probe");
    const echo = namespace || tools?.find(tool => tool.name === "mcp__probe__echo");
    const native = prompt.match(/NATIVE_PROBE:([a-z_]+)/)?.[1];
    const output = native && !toolOutput
      ? native === "apply_patch"
        ? { type: "custom_tool_call", id: "ct_" + randomUUID(), call_id: "call_" + randomUUID(), name: native, input: `*** Begin Patch\n*** Add File: ${join(root, "repo", "native-sentinel.txt")}\n+native executed\n*** End Patch\n` }
        : { type: "function_call", id: "fc_" + randomUUID(), call_id: "call_" + randomUUID(), name: native, arguments: JSON.stringify({ server: "probe", uri: "qa://canary" }) }
      : !toolOutput && !prompt.includes("DECOY") && echo
      ? { type: "function_call", id: "fc_" + randomUUID(), call_id: "call_" + randomUUID(), name: namespace ? "echo" : "mcp__probe__echo", ...(namespace ? { namespace: "mcp__probe" } : {}), arguments: JSON.stringify({ marker: marker ?? "MISSING_HISTORY" }) }
      : { type: "message", id: "msg_" + randomUUID(), role: "assistant", status: "completed", content: [{ type: "output_text", text: toolOutput ? "Tool finished." : "DECOY", annotations: [] }] };
    const response = { id: "resp_" + randomUUID(), object: "response", status: "completed", model: input.model, output: [output], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 } } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("response.created", { response: { ...response, status: "in_progress", output: [] } });
    event("response.output_item.added", { output_index: 0, item: output });
    if (output.type === "message") {
      event("response.content_part.added", { output_index: 0, content_index: 0, item_id: output.id, part: output.content?.[0] });
      event("response.output_text.delta", { output_index: 0, content_index: 0, item_id: output.id, delta: output.content?.[0].text });
    }
    event("response.output_item.done", { output_index: 0, item: output });
    event("response.completed", { response });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No QA listener");
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

/** Local vendor endpoints drive the real tool runtimes with predictable replies. */
export async function scriptedVendorModel(root: string, vendor: "claude" | "antigravity") {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || "{}"); } catch { res.writeHead(400).end(); return; }
    if (vendor === "claude" && !req.url?.includes("/messages")) { res.writeHead(200, { "content-type": "application/json" }).end('{}'); return; }
    requests.push(body); appendFileSync(join(root, "model-requests.jsonl"), JSON.stringify(body) + "\n");
    const history = (vendor === "claude" ? body.messages : body.contents) as Array<Record<string, unknown>>;
    const last = vendor === "claude" ? history?.filter(item => item.role === "user").at(-1) : history?.at(-1);
    const content = (vendor === "claude" ? last?.content : last?.parts) as Array<Record<string, unknown>> | undefined;
    const prompt = JSON.stringify(content ?? "");
    const tail = content?.at(-1);
    const toolOutput = vendor === "claude" ? prompt.includes('"tool_result"') && !(tail?.type === "text" && /NATIVE_PROBE:|Call the probe|Reply DECOY/.test(String(tail.text))) : prompt.includes("functionResponse");
    const marker = JSON.stringify(history).match(/marker ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/)?.[1] ?? "MISSING_HISTORY";
    const native = !toolOutput ? prompt.match(/NATIVE_PROBE:([\w]+)/)?.[1] : undefined;
    const decoy = !toolOutput && prompt.includes("DECOY");
    const input = native ? vendor === "claude" ? { command: `touch ${join(root, "repo", "native-sentinel.txt")}` } : { CommandLine: `touch ${join(root, "repo", "native-sentinel.txt")}`, Cwd: join(root, "repo"), WaitMsBeforeAsync: 0, toolSummary: "Native probe", toolAction: "Probing shell" }
      : vendor === "claude" ? { marker } : { ServerName: "probe", ToolName: "echo", Arguments: { marker }, toolSummary: "Echo marker", toolAction: "Echoing marker" };
    const name = native ?? (vendor === "claude" ? "mcp__probe__echo" : "call_mcp_tool");
    const call = !toolOutput && !decoy;
    const text = toolOutput ? "Tool finished." : "DECOY";
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (vendor === "antigravity") {
      const part = call ? { functionCall: { name, args: input } } : { text };
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 } })}\n\n`);
    } else {
      const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      const block = call ? { type: "tool_use", id: "call_" + randomUUID(), name, input: {} } : { type: "text", text: "" };
      event("message_start", { type: "message_start", message: { id: "msg_" + randomUUID(), type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
      event("content_block_start", { type: "content_block_start", index: 0, content_block: block });
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(input) } : { type: "text_delta", text } });
      event("content_block_stop", { type: "content_block_stop", index: 0 });
      event("message_delta", { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
      event("message_stop", { type: "message_stop" });
    }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("No QA listener");
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
