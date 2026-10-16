/** Inert trusted guardian. Application configuration arrives only after handle publication. */
import { spawn, type Serializable } from "node:child_process";
import { ProcessGroupGuardian } from "./process-group-guardian.js";

const [token, deadlineText] = process.argv.slice(2);
const limit = 1024 * 1024;
const send = (message: object) => {
  if (!process.connected) return;
  try { process.send!({ version: 1, token, ...message }, () => {}); } catch { /* Guardian still owns shutdown. */ }
};
const guardian = new ProcessGroupGuardian({
  deadline: Number(deadlineText),
  stopping: () => send({ kind: "stopping" }),
  escaped: value => send({ kind: "escaped", value }),
});
let application: ReturnType<typeof spawn> | undefined;
let launched = false;
process.on("disconnect", () => guardian.stop());
process.on("message", raw => {
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > limit) throw new Error("message limit");
    const message = raw as { version?: number; token?: string; kind?: string; value?: unknown };
    if (message.version !== 1 || message.token !== token) throw new Error("binding");
    if (message.kind === "stop") { guardian.stop();return; }
    if (message.kind === "launch") {
      if (launched) throw new Error("duplicate launch");
      const spec = message.value as { command: string; args: string[]; env: Record<string, string>; cwd: string };
      if (!spec || typeof spec.command !== "string" || !spec.command.startsWith("/") || typeof spec.cwd !== "string" || !spec.cwd.startsWith("/")
        || !Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== "string") || !spec.env || typeof spec.env !== "object"
        || Object.values(spec.env).some(value => typeof value !== "string")) throw new Error("launch declaration");
      guardian.beforeLaunch();launched = true;
      application = spawn(spec.command, spec.args, { cwd: spec.cwd, env: guardian.environment(spec.env), stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let outputBytes = 0;
      const drain = (bytes: Buffer) => { outputBytes += bytes.length;if (outputBytes > limit) guardian.stop(); };
      application.stdout!.on("data", drain);application.stderr!.on("data", drain);
      application.on("message", value => {
        if (Buffer.byteLength(JSON.stringify(value)) > limit) { guardian.stop();return; }
        send({ kind: "message", value });
      });
      application.once("spawn", () => send({ kind: "launched" }));
      application.once("error", () => { send({ kind: "failed" });guardian.stop(); });
      application.once("close", code => guardian.applicationClosed(code));
      return;
    }
    if (message.kind !== "message" || !application?.connected) throw new Error("application unavailable");
    guardian.assertActive();
    application.send!(message.value as Serializable, error => { if (error) guardian.stop(); });
  } catch { send({ kind: "failed" });guardian.stop(); }
});
send({ kind: "ready" });
