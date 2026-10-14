/* global process, fetch, AbortSignal */
// One session's wrap-up from a local model, on whichever machine runs it.
//
// A remotable job: one self-contained file, no imports, bounded to no files,
// so it runs on a worker under Node's permission model with only the network.
// Input on stdin: { prompt, model? }. Output on stdout: { text }, the model's
// raw reply; the session's own machine turns it into a summary and saves it.
// It talks to the Ollama on the machine it runs on, the same request the
// local summarizer makes (qwen3 with thinking off).
const OLLAMA = "http://127.0.0.1:11434";
let raw = "";
process.stdin.on("data", chunk => { raw += chunk; });
process.stdin.on("end", async () => {
  const input = JSON.parse(raw);
  const model = input.model || "qwen3:8b";
  const response = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: input.prompt }], stream: false, think: false, keep_alive: "1m", options: { num_predict: 1024 } }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    process.stderr.write(`Error: Ollama answered ${response.status} for ${model}${response.status === 404 ? ` (run \`ollama pull ${model}\`)` : ""}\n`);
    process.exit(1);
  }
  const body = await response.json();
  process.stdout.write(JSON.stringify({ text: String(body?.message?.content ?? "") }));
});
