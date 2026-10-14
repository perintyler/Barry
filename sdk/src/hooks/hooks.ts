import { createLogger } from "../logging/emit.js";
import { barryCurrentDir } from "../services/home.mjs";
import { installedProgramPath, shellWord, stableNodePath } from "../services/node-command.js";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join } from "path";
import { fileURLToPath } from "url";
import type { BagHook, BagHookEvent, ResolvedBagHook } from "../bags/types.js";
import { interpreterFor } from "../actions/script-interpreter.js";

const log = createLogger("sdk-hooks", { transport: "stderr" });

/**
 * Bag-declared agent hooks.
 *
 * A bag manifest may declare `hooks:` — commands the agent harness runs on
 * lifecycle events. Events are declared in a provider-neutral vocabulary and
 * mapped onto each provider's own event names by the session generators
 * (`cli/src/lib/settings.ts` for Claude, `cli/src/lib/cursor-hooks.ts` for
 * Cursor). The mapping tables live here so the two generators cannot drift.
 *
 * Two deliberate constraints, both scar tissue from the existing hooks:
 *
 * - A hook's mode is carried in `args`, never inferred from the provider's
 *   `hook_event_name`. session-tracker dispatches on argv precisely because
 *   keying on hook_event_name once mislabeled every Claude session as
 *   `cursor` and silently broke resume for two weeks
 *   (bags/sessions/hooks/session-tracker/normalize.ts).
 * - Hooks resolve only for LOCAL bags. A remote manifest that could inject
 *   commands into every session start would be arbitrary code execution by
 *   registry entry — the same line launchd setup draws by refusing to build
 *   app bundles it downloaded.
 */










/** Expand a leading `~`, matching manifest.ts's private resolvePath. */
function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

/** Neutral event → Claude Code settings.json hook event. */
export const CLAUDE_HOOK_EVENTS: Record<BagHookEvent, string> = {
  "session-start": "SessionStart",
  "session-end": "SessionEnd",
  "user-prompt": "UserPromptSubmit",
  stop: "Stop",
  "pre-tool": "PreToolUse",
  "post-tool": "PostToolUse",
};

/**
 * Neutral event → Cursor hooks.json events.
 *
 * `stop` maps to both afterAgentResponse and stop, mirroring how the
 * session-tracker registration prefers afterAgentResponse (which carries the
 * assistant text) with stop as the fallback. Hooks that must not double-fire
 * can narrow this with `cursor-events`.
 */
export const CURSOR_HOOK_EVENTS: Record<BagHookEvent, string[]> = {
  "session-start": ["sessionStart"],
  "session-end": ["sessionEnd"],
  "user-prompt": ["beforeSubmitPrompt"],
  stop: ["afterAgentResponse", "stop"],
  "pre-tool": ["preToolUse"],
  "post-tool": ["postToolUse"],
};

/**
 * Resolve one hook's script to an invocation, or null when the script is
 * missing or escapes the bag. Shared by resolve-time validation below and the
 * fire-time dispatcher (hook-dispatch.ts), so the two cannot disagree about
 * what a hook would run.
 */
export function resolveHookScript(
  bagDir: string,
  hook: Pick<BagHook, "run">,
): { scriptPath: string; runner: string | null } | null {
  if (isAbsolute(hook.run)) return null;
  const scriptPath = join(resolvePath(bagDir), hook.run);
  if (!existsSync(scriptPath)) return null;
  return { scriptPath, runner: interpreterFor(scriptPath) };
}

/**
 * Where the CLI's `barry-hook` is: the program a harness runs for every bag
 * hook. The dispatcher is the CLI's, not the SDK's, so the host says where it
 * is: `BARRY_HOOK_DISPATCHER`, which the CLI sets for itself and the service
 * management gives every service. Without it, current wins, then the checkout this code runs from
 * (source or compiled SDK, three levels below the root), then `BARRY_DIR`'s. A bag
 * bundle in the cache has neither and gets null.
 */
export function hookDispatcherPath(moduleUrl: string = import.meta.url, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.BARRY_HOOK_DISPATCHER && existsSync(env.BARRY_HOOK_DISPATCHER)) return env.BARRY_HOOK_DISPATCHER;
  if (existsSync(barryCurrentDir())) {
    const installed = installedProgramPath("barry-hook");
    if (existsSync(installed)) return installed;
  }
  const here = dirname(fileURLToPath(moduleUrl));
  const fromCheckout = join(here, "..", "..", "..", "cli", "bin", "barry-hook.js");
  if (existsSync(fromCheckout)) return fromCheckout;
  if (env.BARRY_DIR) {
    const inCheckout = join(env.BARRY_DIR, "cli", "bin", "barry-hook.js");
    if (existsSync(inCheckout)) return inCheckout;
  }
  return null;
}

/** The installed dispatcher, through current when present; linked hooks carry their Node. */
export function hookDispatchCommand(): string {
  const dispatcher = hookDispatcherPath();
  if (!dispatcher) {
    throw new Error("cannot find Barry's hook dispatcher: this runs outside the checkout and BARRY_DIR names none");
  }
  // The bin loads its own TypeScript, so plain node runs it.
  return (dispatcher.endsWith(".js") ? [stableNodePath(), dispatcher] : [dispatcher]).map(shellWord).join(" ");
}

/**
 * Resolve a bag's declared hooks into runnable commands.
 *
 * `run` is a path relative to the bag directory (absolute paths are
 * rejected — a manifest must not point outside its bag). The command is a
 * single string because both generators' hook entries take one
 * (`settings.ts` and `cursor-hooks.ts` command fields).
 *
 * A missing script drops the hook with a warning rather than failing the
 * bag load: the bag's tools still work, and a hook that never fires is
 * the same failure mode a typo'd manifest would have had anyway — but loudly.
 */
export function resolveBagHooks(
  bagDir: string,
  hooks: BagHook[] | undefined,
  bagName: string,
  dispatchCommand: () => string = hookDispatchCommand,
): ResolvedBagHook[] {
  if (!hooks?.length) return [];

  // Tools load bags too, from bundles that may sit nowhere near the checkout,
  // and never use a hook's command. A throw here failed every such tool call
  // (get_instructions, 09-29), so a load that cannot build the command skips
  // the hooks and says so.
  let dispatch: string;
  try {
    dispatch = dispatchCommand();
  } catch (err) {
    log.warn(`[bags] ${bagName}: ${hooks.length} hook(s) not resolved: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const resolved: ResolvedBagHook[] = [];
  // Index within (bag, event) in declared order — the dispatcher re-derives
  // the same ordinal from the manifest at fire time.
  const eventOrdinals = new Map<string, number>();

  for (const hook of hooks) {
    if (isAbsolute(hook.run)) {
      log.warn(`[bags] ${bagName}: hook run path must be relative to the bag: ${hook.run}`);
      continue;
    }
    const invocation = resolveHookScript(bagDir, hook);
    if (!invocation) {
      log.warn(`[bags] ${bagName}: hook script not found: ${join(resolvePath(bagDir), hook.run)}`);
      continue;
    }

    const ordinal = eventOrdinals.get(hook.event) ?? 0;
    eventOrdinals.set(hook.event, ordinal + 1);

    // The command carries only the dispatcher and the hook's
    // IDENTITY — never the script path or args. The dispatcher re-resolves
    // both from the live registry at every firing, so moving a bag (or
    // editing its hook args) takes effect for already-running sessions.
    resolved.push({
      bag: bagName,
      event: hook.event,
      command: `${dispatch} ${bagName} ${hook.event} ${ordinal}`,
      ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
      ...(hook.cursorMatcher !== undefined ? { cursorMatcher: hook.cursorMatcher } : {}),
      ...(hook.cursorEvents !== undefined ? { cursorEvents: hook.cursorEvents } : {}),
      ...(hook.timeout !== undefined ? { timeout: hook.timeout } : {}),
    });
  }

  return resolved;
}

/** One entry in a Cursor hooks.json event list. */
export interface CursorHookEntry {
  command: string;
  matcher?: string;
  timeout?: number;
}

/**
 * Map resolved bag hooks onto Cursor hooks.json event lists.
 *
 * Shared by the CLI's cursor-hooks generator and the server-side cursor
 * provider (via session-runtime) so the mapping cannot drift between them.
 * agent-runtime itself stays free of a @barry-rocks/sdk/bags dependency — callers
 * build this and pass the finished entries in.
 */
export function buildCursorBagHookEntries(
  bagHooks: ResolvedBagHook[],
): Record<string, CursorHookEntry[]> {
  const entries: Record<string, CursorHookEntry[]> = {};
  for (const hook of bagHooks) {
    const events = hook.cursorEvents ?? CURSOR_HOOK_EVENTS[hook.event];
    for (const event of events) {
      (entries[event] ??= []).push({
        command: hook.command,
        ...(hook.cursorMatcher !== undefined ? { matcher: hook.cursorMatcher } : {}),
        ...(hook.timeout !== undefined ? { timeout: hook.timeout } : {}),
      });
    }
  }
  return entries;
}
