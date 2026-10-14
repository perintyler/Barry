import { installationRoot } from "@barry-rocks/sdk/services";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";

// The selected instance owns its credential; an unrelated shell value cannot replace it.
export async function useInstanceSecret(): Promise<void> {
  delete process.env.BARRY_SECRET;
  const { BARRY_SECRET: secret } = await installationSecrets(["BARRY_SECRET"], { allowUnconfiguredInstance: true });
  if (secret) process.env.BARRY_SECRET = secret;
  else delete process.env.BARRY_SECRET;
}

export const PATHS = {
  get identityDir(): string { return installationRoot(); },
};

export interface McpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface McpConfig {
  mcpServers: Record<string, McpServer>;
}
