/**
 * Pack loader — resolves pack entries into fully loaded packs
 */

import { homedir } from "os";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { Pack, LocalPackSource } from "./types.js";

function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

async function loadLocalPack(name: string, entry: LocalPackSource): Promise<Pack> {
  const packDir = resolvePath(entry.path);
  const manifest = parseManifest(packDir);

  if (!manifest) {
    return {
      name,
      description: "",
      builtin: false,
      source: entry,
      manifest: null,
      skillsDirs: getSkillsDirs(packDir),
      traits: [],
      agents: [],
      mcpServers: {},
      tools: [],
    };
  }

  const agents: PackAgent[] = [];
  for (const [agentName, agentDef] of Object.entries(manifest.agents)) {
    let prompt: string | undefined;
    if (agentDef.promptFile) {
      const promptPath = join(packDir, agentDef.promptFile);
      if (existsSync(promptPath)) {
        prompt = readFileSync(promptPath, "utf-8");
      }
    }
    agents.push({
      name: agentName,
      description: agentDef.description,
      tools: agentDef.tools,
      model: agentDef.model ?? undefined,
      prompt,
    });
  }

  return {
    name: manifest.name,
    description: manifest.description,
    builtin: false,
    agents,
    mcpServers: manifest.mcpServers,
    tools: manifest.tools,
  };
}

export { loadLocalPack };
