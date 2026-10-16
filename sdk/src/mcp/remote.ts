import { createLogger } from "../logging/emit.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { clearBagCache, cacheSkill, getCachedSkillsDirs, getCachedActionsDirs, getCachedInstructionsDirs } from "./cache.js";
import { parseManifestObjectSafe } from "../bags/manifest.js";
import { noSseFetch } from "./transport.js";
import type {
  RemoteBagSource,
  Bag,
  BagMcpServer,
  BagToolMeta,
  BagManifest,
} from "../bags/types.js";

const log = createLogger("sdk-mcp", { transport: "stderr" });

/**
 * Remote bag resource discovery via MCP barry:// URIs.
 *
 * Connects to a remote bag's MCP server, discovers barry:// resources,
 * and builds a Bag with cached skills and MCP servers.
 */

interface BarrySkillResource {
  name: string;
  description?: string;
  prompt: string;
}

/**
 * Classify a remote MCP tool's access level fail-closed from MCP `ToolAnnotations`.
 *
 * Only tools explicitly annotated with `annotations.readOnlyHint === true` (or an
 * explicit `access: "read"` manifest entry) are classified as `"read"`. Unannotated
 * remote tools default to `"write"` so `<bag>:read` (`tools.deny: ["<bag>:write"]`)
 * and `readonly` never allow unannotated remote write tools to execute.
 */
export function classifyRemoteToolAccess(tool: {
  access?: unknown;
  annotations?: { readOnlyHint?: boolean } | null;
}): "read" | "write" {
  if (tool.annotations && typeof tool.annotations === "object") {
    return tool.annotations.readOnlyHint === true ? "read" : "write";
  }
  if (tool.access === "read") return "read";
  return "write";
}

function createTransport(source: RemoteBagSource) {
  if (source.url) {
    return new StreamableHTTPClientTransport(new URL(source.url), { fetch: noSseFetch });
  }
  if (source.command) {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (source.env) {
      for (const name of source.env) {
        if (process.env[name]) env[name] = process.env[name]!;
      }
    }
    return new StdioClientTransport({ command: source.command, args: source.args, env });
  }
  throw new Error("Remote bag source must have url or command");
}

async function readResourceText(client: Client, uri: string): Promise<string | null> {
  try {
    const { contents } = await client.readResource({ uri });
    if (contents.length > 0 && "text" in contents[0]) {
      return contents[0].text;
    }
  } catch {
    // Resource not available
  }
  return null;
}

async function readResourceJson<T>(client: Client, uri: string): Promise<T | null> {
  const text = await readResourceText(client, uri);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function discoverRemoteBagResources(
  name: string,
  source: RemoteBagSource,
): Promise<Bag> {
  const transport = createTransport(source);
  const client = new Client({ name: "barry-bag-discovery", version: "1.0.0" });
  await client.connect(transport);

  try {
    return await discoverFromClient(name, source, client);
  } finally {
    await client.close();
  }
}

export async function discoverFromClient(
  name: string,
  source: RemoteBagSource,
  client: Client,
): Promise<Bag> {
  const { resources } = await client.listResources();
  const barryResources = resources.filter((r) => r.uri.startsWith("barry://"));

  clearBagCache(name);

  let description = "";
  let manifest: BagManifest | null = null;
  let manifestError: string | null = null;
  const tools: BagToolMeta[] = [];

  const manifestRes = barryResources.find((r) => r.uri === "barry://manifest");
  if (manifestRes) {
    const raw = await readResourceJson<Record<string, unknown>>(client, "barry://manifest");
    if (raw) {
      const parsed = parseManifestObjectSafe(raw, `remote bag '${name}' manifest`, { source: "remote" });
      manifest = parsed.manifest;
      manifestError = parsed.error;

      if (manifest) {
        description = manifest.description;
        for (const t of manifest.tools) tools.push(t);
      } else {
        description = typeof raw.description === "string" ? raw.description : "";
        if (Array.isArray(raw.tools)) {
          for (const entry of raw.tools) {
            if (!entry || typeof entry !== "object") continue;
            const { toolName, namespace, access, annotations } = entry as Record<string, unknown>;
            if (typeof toolName !== "string" || typeof namespace !== "string") continue;
            const resolvedAccess = classifyRemoteToolAccess({
              access,
              annotations:
                annotations && typeof annotations === "object"
                  ? (annotations as { readOnlyHint?: boolean })
                  : null,
            });
            tools.push({
              toolName,
              namespace,
              access: resolvedAccess === "read" ? "read" : "readwrite",
            });
          }
        }
      }
    }
  }

  if (tools.length === 0 && typeof (client as { listTools?: unknown }).listTools === "function") {
    try {
      const listed = await client.listTools();
      for (const remoteTool of listed.tools ?? []) {
        if (!remoteTool || typeof remoteTool.name !== "string") continue;
        const resolvedAccess = classifyRemoteToolAccess({
          annotations: remoteTool.annotations ?? null,
        });
        tools.push({
          toolName: remoteTool.name,
          namespace: name,
          access: resolvedAccess === "read" ? "read" : "readwrite",
        });
      }
    } catch {
      // Optional MCP tools listing not supported by this server
    }
  }

  // Read skills. cacheSkill rejects unsafe names and returns null, so a remote
  // server cannot write outside its own cache directory.
  const skillResources = barryResources.filter((r) => r.uri.startsWith("barry://skills/"));
  for (const sr of skillResources) {
    const skill = await readResourceJson<BarrySkillResource>(client, sr.uri);
    if (skill?.prompt) {
      cacheSkill(name, skill.name, skill.prompt);
    }
  }

  const mcpServers: Record<string, BagMcpServer> = {};
  // Server definitions dropped for naming a local command — reported below so a
  // bag author sees why their entry did not take effect.
  const rejectedServers: string[] = [];

  // The bag itself is always an MCP server
  if (source.url) {
    mcpServers[name] = { type: "http", url: source.url };
  } else if (source.command) {
    mcpServers[name] = { command: source.command, args: source.args, env: source.env };
  }

  // Additional MCP servers from config resource.
  //
  // Only URL-based entries are accepted. A `command` entry would let a remote
  // bag — third-party code by definition — name an arbitrary subprocess to run
  // on this machine. Launching a local process must stay an explicit decision
  // the user makes in their own registry.
  const configRes = barryResources.find((r) => r.uri === "barry://config/mcp-servers");
  if (configRes) {
    const servers = await readResourceJson<Record<string, BagMcpServer>>(client, "barry://config/mcp-servers");
    if (servers) {
      for (const [serverName, serverDef] of Object.entries(servers)) {
        if (!serverDef?.url || serverDef.command) {
          rejectedServers.push(serverName);
          continue;
        }

        mcpServers[serverName] = { type: serverDef.type ?? "http", url: serverDef.url };
      }
    }
  }

  if (rejectedServers.length > 0) {
    log.warn(
      `[bags] remote bag '${name}': ignored command-based MCP server(s) ` +
        `${rejectedServers.join(", ")} — remote bags may only declare url-based servers.`,
    );
  }

  // A malformed manifest is reported rather than swallowed: the bag still
  // loads in legacy mode, but the author needs to know why its verbs, nouns and
  // instructions did not take effect.
  if (manifestError) {
    log.warn(`[bags] ${manifestError}`);
  }

  return {
    name,
    description,
    builtin: false,
    source,
    manifest,
    skillsDirs: getCachedSkillsDirs(name),
    actionsDirs: getCachedActionsDirs(name),
    instructionsDirs: getCachedInstructionsDirs(name),
    mcpServers,
    tools,
    dependencies: manifest?.dependencies?.length
      ? manifest.dependencies
      : source.command
        ? [{ name: source.command }]
        : [],
    slashCommands: manifest?.slashCommands?.commands ?? [],
    // Never resolve hooks from a remote manifest: a registry entry that can
    // inject commands into every session start is arbitrary code execution.
    hooks: [],
    requires: Object.entries(manifest?.requires ?? {}).map(([target, r]) => ({ target, ...r })),
    services: [],
    apps: [],
    schedules: [],
  };
}
