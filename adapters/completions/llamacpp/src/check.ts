/**
 * Can this local llama.cpp model actually drive a coding session?
 *
 * Verifies that llama-server is healthy, the model is loaded, and (when checking
 * agent capability) whether tool calls are emitted properly.
 */
import type { Check, Endpoint } from "@barry-rocks/sdk/adapters/models";

import { listLlamaModels, normalizeV1Url } from "./api.js";

type Probe =
  | { status: "ok" }
  | { status: "no-tool-use"; text: string }
  | { status: "model-missing" }
  | { status: "unreachable" }
  | { status: "timeout"; ms: number }
  | { status: "error"; detail: string };

const PROBE_TIMEOUT_MS = 45_000;

const PROBE_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city. Call this to answer any weather question.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
};

export async function checkLlama(endpoint: Endpoint, model: string | undefined): Promise<Check[]> {
  const checks: Check[] = [];
  const base = endpoint.baseUrl.replace(/\/+$/, "");
  const healthUrl = `${base}/health`;

  // 1. Health endpoint check
  let serverHealthy = false;
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      serverHealthy = true;
      checks.push({ name: "llama-server", status: "ok", observed: `healthy at ${base}` });
    } else {
      checks.push({
        name: "llama-server",
        status: "failed",
        observed: `HTTP ${res.status} from ${healthUrl}`,
        fix: "Check `llama-server` process logs",
      });
    }
  } catch {
    checks.push({
      name: "llama-server",
      status: "failed",
      observed: `unreachable at ${base}`,
      fix: `Start llama-server (e.g. \`llama-server -m <model.gguf> --port 8080\`)`,
    });
  }

  if (!serverHealthy || !model) {
    return checks;
  }

  // 2. Model listing check
  const models = await listLlamaModels(endpoint).catch(() => []);
  const found = models.some((m) => m.id === model);
  if (models.length > 0 && !found) {
    checks.push({
      name: "model loaded",
      status: "failed",
      observed: `model "${model}" not found among loaded models: ${models.map((m) => m.id).join(", ")}`,
      fix: `Restart llama-server with \`-m <path-to-${model}>\``,
    });
  } else {
    checks.push({
      name: "model loaded",
      status: "ok",
      observed: found ? `model "${model}" loaded` : `endpoint answered model list`,
    });
  }

  // 3. Tool call probe
  const startedAt = Date.now();
  const probe = await probeToolCalling(endpoint, model).catch(
    (err): Probe => ({ status: "error", detail: err instanceof Error ? err.message : String(err) }),
  );
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  checks.push(toolCallCheck(probe, model, seconds));

  return checks;
}

async function probeToolCalling(endpoint: Endpoint, model: string): Promise<Probe> {
  const url = normalizeV1Url(endpoint.baseUrl, "chat/completions");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "What is the weather in Paris right now?" }],
        tools: [PROBE_TOOL],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { status: "timeout", ms: PROBE_TIMEOUT_MS };
    }
    return { status: "unreachable" };
  }

  if (res.status === 404) return { status: "model-missing" };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { status: "error", detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  const body = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string; tool_calls?: Array<unknown> } }>;
  } | null;

  const message = body?.choices?.[0]?.message;
  if (!message) return { status: "error", detail: "response had no message in choices[0]" };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return { status: "ok" };
  }

  const text = message.content ?? "";
  return { status: "no-tool-use", text: text.slice(0, 200) };
}

function toolCallCheck(probe: Probe, model: string, seconds: string): Check {
  const name = "tool call";
  switch (probe.status) {
    case "ok":
      return { name, status: "ok", observed: `tool call ok (${seconds}s)` };
    case "no-tool-use":
      return {
        name,
        status: "failed",
        observed: `answered in text rather than calling a tool (${seconds}s): "${probe.text}"`,
        fix: `${model} did not invoke the tool under direct prompt; check system prompt or model sizing.`,
      };
    case "model-missing":
      return {
        name,
        status: "failed",
        observed: `model "${model}" is not loaded in llama-server`,
      };
    case "unreachable":
      return {
        name,
        status: "failed",
        observed: "llama-server unreachable during tool call probe",
      };
    case "timeout":
      return {
        name,
        status: "failed",
        observed: `timed out after ${probe.ms / 1000}s waiting for a tool call`,
      };
    case "error":
      return {
        name,
        status: "failed",
        observed: `probe error: ${probe.detail}`,
      };
  }
}
