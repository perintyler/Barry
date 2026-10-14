import { join } from "node:path";
import { codexToolGateCommand } from "../tool-policy.js";

interface Hook { key: string; eventName: string; command: string; sourcePath: string; currentHash: string; enabled: boolean; trustStatus: string; }
interface Client { call(method: string, params: unknown): Promise<unknown>; }

/** The app-server ignores the TUI's trust-bypass flag. Trust only our exact generated gate. */
export async function trustBarryToolGate(client: Client, home: string, cwd: string): Promise<void> {
  const list = async () => {
    const result = await client.call("hooks/list", { cwds: [cwd] }) as { data: Array<{ hooks: Hook[]; errors?: string[] }> };
    if (!Array.isArray(result.data) || result.data.some(entry => entry.errors?.length)) throw new Error("Codex could not load Barry's tool policy");
    const hooks = result.data.flatMap(entry => entry.hooks).filter(hook => hook.sourcePath === join(home, "hooks.json") && hook.eventName === "preToolUse");
    if (hooks.length !== 1 || hooks[0].command !== codexToolGateCommand(home) || !hooks[0].enabled || !hooks[0].currentHash) throw new Error("Codex did not load Barry's exact tool gate; refusing native access");
    return hooks[0];
  };
  const hook = await list();
  await client.call("config/batchWrite", { filePath: join(home, "config.toml"), reloadUserConfig: true, edits: [{ keyPath: `hooks.state.${JSON.stringify(hook.key)}`, mergeStrategy: "replace", value: { enabled: true, trusted_hash: hook.currentHash } }] });
  if ((await list()).trustStatus !== "trusted") throw new Error("Codex did not trust Barry's tool gate; refusing native access");
}

/**
 * Turn Barry's gate back on when a client switched it off, such as a person
 * using `/hooks` in an attached TUI. Resolves whether it had to.
 */
export async function restoreBarryToolGate(client: Client, home: string, cwd: string): Promise<boolean> {
  const result = await client.call("hooks/list", { cwds: [cwd] }) as { data: Array<{ hooks: Hook[] }> };
  const gate = result.data.flatMap(entry => entry.hooks).find(hook => hook.sourcePath === join(home, "hooks.json") && hook.eventName === "preToolUse");
  if (!gate) throw new Error("Barry's tool gate is missing from this session's codex home");
  if (gate.enabled && gate.trustStatus === "trusted") return false;
  await client.call("config/batchWrite", { filePath: join(home, "config.toml"), reloadUserConfig: true, edits: [{ keyPath: `hooks.state.${JSON.stringify(gate.key)}`, mergeStrategy: "replace", value: { enabled: true, trusted_hash: gate.currentHash } }] });
  return true;
}
