/**
 * Bag loader — resolves bag entries into fully loaded bags
 */

import { homedir } from "os";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { Bag, LocalBagSource } from "./types.js";

function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

async function loadLocalBag(name: string, entry: LocalBagSource): Promise<Bag> {
  const bagDir = resolvePath(entry.path);
  const manifest = parseManifest(bagDir);

  if (!manifest) {
    return {
      name,
      description: "",
      builtin: false,
      source: entry,
      manifest: null,
      skillsDirs: getSkillsDirs(bagDir),
      traits: [],
      agents: [],
      mcpServers: {},
      tools: [],
    };
  }

  const agents: BagAgent[] = [];
  for (const [agentName, agentDef] of Object.entries(manifest.agents)) {
    let prompt: string | undefined;
    if (agentDef.promptFile) {
      const promptPath = join(bagDir, agentDef.promptFile);
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

export { loadLocalBag };
