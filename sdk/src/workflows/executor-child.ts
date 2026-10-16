import { verifyArtifact, type WorkflowArtifact } from "./artifacts.js";
import { evaluate, type ReplaySnapshot } from "./evaluator.js";
import { encode, encodeRecord, PayloadLimit, type Activity, type ActivityTask, type WorkflowDefinition } from "./types.js";
import { createBootstrapLogger } from "../logging/emit-bootstrap.js";
import { validateAgainstSchema } from "../tools/validate.js";

const log = createBootstrapLogger("workflow-child");

// Binary framing lets the parent reject output length before parsing application-controlled JSON.
let input = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  if (input.length + chunk.length > 34 * 1024 * 1024) process.exit(2);
  input = Buffer.concat([input, chunk]);
});
process.stdin.on("end", () => { void main().catch(error => send({ error: (error instanceof Error ? error.message : String(error)).slice(0, 4096) })); });
function send(value: unknown) {
  const payload = Buffer.from(encodeRecord(value)), header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
  process.stdout.write(Buffer.concat([header, payload]), () => process.exit(0));
}
async function main() {
  const request = JSON.parse(input.toString("utf8")) as { artifact: WorkflowArtifact; snapshot?: ReplaySnapshot; task?: ActivityTask; validation?: { schema: Record<string, unknown>; value: unknown } };
  if (request.validation) {
    try { send({ validation: validateAgainstSchema(request.validation.schema, request.validation.value) }); }
    catch { send({ validation: { ok: false, errors: ["Declared output schema cannot be compiled."] } }); }
    return;
  }
  const artifactBytes = verifyArtifact(request.artifact);
  // Application stdout cannot corrupt the framed protocol; logs are capped by the parent on stderr.
  const output = (...args: unknown[]) => log.info("workflow.output", { args: args.map(value => value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value) });
  Object.assign(console, { log: output, info: output, warn: output, error: output });
  // Import exactly the verified bytes, not a path that could change between hash and import.
  const module = await import(`data:text/javascript;base64,${artifactBytes.toString("base64")}`) as { definitions?: WorkflowDefinition[]; activities?: Record<string, Activity> };
  if (request.snapshot) {
    const definition = module.definitions?.find(item => item.type === request.artifact.type && item.version === request.artifact.version);
    if (!definition) throw new Error("artifact does not export its declared workflow");
    send({ proposal: evaluate(definition, request.snapshot) });
  } else if (request.task) {
    const task = request.task, activity = module.activities?.[task.type];
    if (!activity) throw new Error("artifact does not export requested activity");
    try {
      const value = await activity(task.input, { ...task, signal: new AbortController().signal });
      send({ outcome: { ok: true, value: JSON.parse(encode(value)) } });
    } catch (error) {
      const authored = error instanceof Error && error.name === "ActivityFailure" && "code" in error && typeof error.code === "string";
      send({ outcome: { ok: false, error: {
        code: error instanceof PayloadLimit ? "ResultTooLarge" : authored ? (error as Error & { code: string }).code.slice(0, 200) || "ActivityFailed" : "ActivityFailed",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 4096), retryable: !(error instanceof PayloadLimit) && !authored,
      } } });
    }
  } else throw new Error("missing execution request");
}
