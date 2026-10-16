import "../lib/timing.js";
/**
 * Fire-time dispatcher for bag hooks.
 *
 * Per-session settings used to bake each hook's absolute script path at spawn
 * time — so moving a bag directory (the packs→blocks→bags renames) stranded
 * every RUNNING session's hooks with ERR_MODULE_NOT_FOUND until restart, and
 * session/change tracking silently stopped. Settings now bake only a stable
 * command (this module, run by node with tsx's loader; see hooks.ts) plus a hook identity (bag, event, index);
 * this module re-resolves the script from the live registry at every firing,
 * so a rename heals the moment the tree changes, no session restart needed.
 *
 * Invocation: hook-dispatch.ts <bag> <event> [index] [extra args...]
 *
 * Contract with hook scripts (unchanged from direct invocation):
 * - argv carries the hook's manifest args (mode-in-argv rule — see hooks.ts);
 *   `process.argv` is rewritten before import so `process.argv[2]` is the mode.
 * - stdin/stdout are the provider's hook pipes.
 * - `.ts`/`.js` scripts are imported IN-PROCESS (they run their main at module
 *   load, exactly as `tsx script.ts` would, and `import.meta.url` still points
 *   at the real script) — this keeps one interpreter start per firing, the
 *   same cost as before. `.sh` and extensionless scripts are spawned.
 * - Any resolution failure prints `{}` and exits 0: a hook that cannot fire
 *   must never break the agent turn.
 */

import { spawnSync } from "child_process";
import { pathToFileURL } from "url";
import { getBagSource } from "@barry-rocks/sdk/internal/bags";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { resolveHookScript } from "@barry-rocks/sdk/internal/hooks";
import { enforceHookOutputRules } from "./hook-output-rules.js";

function bail(message: string): never {
  console.error(`[bag-hook-dispatch] ${message}`);
  // Valid empty hook output so the provider treats this as a clean no-op.
  process.stdout.write("{}\n");
  process.exit(0);
}

const [, , bagName, event, indexArg, ...extraArgs] = process.argv;
if (!bagName || !event) bail("usage: hook-dispatch <bag> <event> [index] [args...]");
const index = indexArg ? Number.parseInt(indexArg, 10) : 0;

let source: ReturnType<typeof getBagSource>;
try {
  source = getBagSource(bagName);
} catch (err) {
  // A missing snapshot is an instance problem, not this hook's: say so and let
  // the agent carry on, rather than failing every tool call with a stack.
  bail(err instanceof Error ? err.message : String(err));
}
if (!source) bail(`bag not registered: ${bagName}`);
if (source.type !== "local") bail(`bag is not local: ${bagName}`);

const bagDir = source.path.replace(/^~/, process.env.HOME ?? "");
const manifest = parseManifest(bagDir);
if (!manifest) bail(`no manifest for bag: ${bagName}`);

const forEvent = (manifest.hooks ?? []).filter((h) => h.event === event);
const hook = forEvent[Number.isNaN(index) ? 0 : index];
if (!hook) bail(`no hook #${indexArg ?? 0} for event ${event} in bag ${bagName}`);

const invocation = resolveHookScript(bagDir, hook);
if (!invocation) bail(`hook script missing for ${bagName}/${event}: ${hook.run}`);

const args = [...(hook.args ?? []), ...extraArgs];

/**
 * Forward a hook's stdout to the provider, but never let a `pre-tool` bag hook
 * carry a permission verdict past Barry's own gate (ADP-11). The verdict is
 * stripped and the stripping is logged to stderr; the rest of the output goes
 * on unchanged.
 */
function forwardHookOutput(raw: string): void {
  const { output, strippedPermissionDecision } = enforceHookOutputRules(event, raw);
  if (strippedPermissionDecision) {
    console.error(
      `[bag-hook-dispatch] ${bagName}/${event}: a pre-tool bag hook returned a permission decision; ` +
        "it was dropped. The tool gate is Barry's, not a bag's.",
    );
  }
  process.stdout.write(output);
}

if (invocation.runner === "tsx" || invocation.runner === "node") {
  // In-process: same interpreter start the direct invocation paid, and the
  // script sees the argv shape it was always called with. Its stdout is
  // captured rather than let through directly, so the pre-tool permission ban
  // can be applied to it before the provider sees it.
  process.argv = [process.argv[0], invocation.scriptPath, ...args];
  const realWrite = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const cb = rest.find((arg) => typeof arg === "function") as ((error?: Error | null) => void) | undefined;
    cb?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    if (/\.[cm]?tsx?$/.test(invocation.scriptPath)) {
      const { register } = await import("tsx/esm/api");
      register();
    }
    await import(pathToFileURL(invocation.scriptPath).href);
  } finally {
    process.stdout.write = realWrite;
  }
  forwardHookOutput(chunks.join(""));
} else {
  const command = invocation.runner ?? invocation.scriptPath;
  const commandArgs = invocation.runner ? [invocation.scriptPath, ...args] : args;
  // stdout is captured (not inherited) so the pre-tool permission ban applies;
  // stdin and stderr stay wired to the provider's pipes as before.
  const result = spawnSync(command, commandArgs, { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" });
  forwardHookOutput(result.stdout ?? "");
  process.exit(result.status ?? 0);
}
