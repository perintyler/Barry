/**
 * Block loader — resolves block entries into fully loaded blocks
 */

import { homedir } from "os";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { Block, LocalBlockSource } from "./types.js";

function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

async function loadLocalBlock(name: string, entry: LocalBlockSource): Promise<Block> {
  const blockDir = resolvePath(entry.path);
  const manifest = parseManifest(blockDir);

  if (!manifest) {
    return {
      name,
      description: "",
      builtin: false,
      source: entry,
      manifest: null,
      skillsDirs: getSkillsDirs(blockDir),
      traits: [],
      agents: [],
      mcpServers: {},
      tools: [],
    };
  }

  const agents: BlockAgent[] = [];
  for (const [agentName, agentDef] of Object.entries(manifest.agents)) {
    let prompt: string | undefined;
    if (agentDef.promptFile) {
      const promptPath = join(blockDir, agentDef.promptFile);
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

export { loadLocalBlock };
