import { generateStdioConfig } from "../mcp-config.js";

export function listCommand(): void {
  const full = generateStdioConfig();
  const all = Object.keys(full.mcpServers);

  console.log("MCP Servers:");
  console.log("");

  for (const mcp of all) {
    console.log(`  ✓ ${mcp}`);
  }

  console.log("");
  console.log(`${all.length} configured`);
}
