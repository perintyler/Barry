/**
 * Helper to create an MCP server from a local bag directory.
 *
 * Reads a bag's manifest, skills, and traits, then registers
 * them as barry:// resources on an MCP server. This lets any local bag
 * trivially become a remote bag server.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseManifest, readRawManifest, getSkillsDirs } from "../bags/manifest.js";
import { getActionsDirs, parseActionFile } from "../actions/action-manifest.js";
import { loadBagToolDefinitions } from "../bags/tool-definitions.js";
import type { BagToolMeta } from "../bags/types.js";
import type { BagManifest } from "../bags/types.js";

export interface BagServerOptions {
  bagDir: string;
  name?: string;
  version?: string;
}

/**
 * The loaded-once inputs an MCP resource server is built from.
 *
 * Loading parses the manifest, walks `skills/`+`actions/` and runs
 * `loadBagToolDefinitions` — work worth doing once per bag directory rather
 * than once per client session. An `McpServer` still binds to a single
 * transport, so each session gets its own server, but they share these
 * resources.
 */
export interface LoadedBagResources {
  bagDir: string;
  manifest: BagManifest | null;
  rawManifest: Record<string, unknown> | null;
  tools: BagToolMeta[];
}

export async function loadBagResources(bagDir: string): Promise<LoadedBagResources> {
  const manifest = parseManifest(bagDir);
  const rawManifest = readRawManifest(bagDir);
  const definitions = await loadBagToolDefinitions({ name: manifest?.name ?? "bag-server", source: { type: "local", path: bagDir }, manifest });
  const tools: BagToolMeta[] = (definitions ?? []).map(tool => ({ toolName: tool.name, namespace: tool.namespace, access: tool.access === "read" ? "read" : "readwrite" }));
  return { bagDir, manifest, rawManifest, tools };
}

/** Build an MCP resource server from already-loaded bag resources. */
export function buildBagResourceServer(resources: LoadedBagResources, options?: { name?: string; version?: string }): McpServer {
  const { bagDir, manifest, rawManifest, tools } = resources;
  const serverName = options?.name ?? manifest?.name ?? "bag-server";
  const server = new McpServer({ name: serverName, version: options?.version ?? "1.0.0" });

  registerManifestResource(server, manifest, rawManifest, tools);
  registerSkillResources(server, bagDir);
  registerTraitResources(server, manifest);
  registerMcpServersResource(server, manifest);
  registerToolsMetaResource(server, tools);

  return server;
}

export async function createBagResourceServer(options: BagServerOptions): Promise<McpServer> {
  const resources = await loadBagResources(options.bagDir);
  return buildBagResourceServer(resources, { name: options.name, version: options.version });
}

/**
 * @deprecated Renamed to {@link createBagResourceServer}. This factory builds
 * the HTTP resource server (manifest/skills/traits as `barry://` resources),
 * not the stdio tool server `startBagServer` — the two "bag server" names were
 * a documented source of confusion. Kept as an alias for any external importer
 * of the old name; prefer `createBagResourceServer`.
 */
export const createBagServer = createBagResourceServer;

/**
 * Fields that must not cross the wire.
 *
 * The retired server entry names code on the serving machine. Tool metadata
 * is reconstructed from exported definitions before publishing.
 */
function stripLocalOnlyFields(raw: Record<string, unknown>): Record<string, unknown> {
  const wire: Record<string, unknown> = { ...raw };
  delete wire.server;

  return wire;
}

/**
 * Publish authored configuration with code-owned tool metadata for the
 * explicitly remote manifest parser.
 *
 * Falls back to the legacy three-field shape when there is no manifest on disk;
 * older consumers only ever read those three.
 */
function registerManifestResource(
  server: McpServer,
  manifest: BagManifest | null,
  rawManifest: Record<string, unknown> | null,
  tools: BagToolMeta[],
): void {
  server.resource("manifest", "barry://manifest", (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(
          rawManifest
            ? { ...stripLocalOnlyFields(rawManifest), tools }
            : {
                name: manifest?.name ?? "unnamed",
                description: manifest?.description ?? "",
                tools,
              },
        ),
      },
    ],
  }));
}

function registerSkillResources(server: McpServer, bagDir: string): void {
  // Actions live under actions/ AND, after an in-place conversion, under
  // skills/ — a converted skill keeps its directory and swaps SKILL.md for
  // action.yaml. Walking only skills/ for SKILL.md made every converted
  // capability vanish from the remote route while still working locally.
  const dirs = [...getSkillsDirs(bagDir), ...getActionsDirs(bagDir)];
  if (dirs.length === 0) return;

  const skills = new Map<string, string>();
  for (const skillsDir of dirs) {
    if (!existsSync(skillsDir)) continue;
    for (const entry of readdirSync(skillsDir)) {
      const entryPath = join(skillsDir, entry);
      if (!statSync(entryPath).isDirectory()) continue;
      if (skills.has(entry)) continue;

      // Prefer the action: when both are present the action is what the
      // catalog resolves locally, so the remote must agree.
      const actionFile = join(entryPath, "action.yaml");
      if (existsSync(actionFile)) {
        try {
          // One broken action must not take down the whole listing — the same
          // rule readActionDir follows in the catalog.
          // A `run:` action has no prompt to serve as a skill body; skip it
          // rather than publishing an empty skill.
          const action = parseActionFile(entryPath);
          if (action.prompt !== undefined) skills.set(entry, action.prompt);
          continue;
        } catch {
          // Fall through to SKILL.md if the action is unparseable.
        }
      }
      const skillFile = join(entryPath, "SKILL.md");
      if (existsSync(skillFile)) {
        skills.set(entry, readFileSync(skillFile, "utf-8"));
      }
    }
  }

  for (const [skillName, content] of skills) {
    server.resource(`skill-${skillName}`, `barry://skills/${skillName}`, (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ name: skillName, prompt: content }),
        },
      ],
    }));
  }
}

function registerTraitResources(server: McpServer, manifest: BagManifest | null): void {
  if (!manifest?.traits) return;

  for (const [traitName, traitDef] of Object.entries(manifest.traits)) {
    server.resource(`trait-${traitName}`, `barry://traits/${traitName}`, (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            name: traitName,
            description: traitDef.description,
            access: traitDef.access,
            namespaces: traitDef.bags,
            // Consumers filter this to skills the bag actually published.
            skills: traitDef.skills ?? [],
          }),
        },
      ],
    }));
  }
}

function registerMcpServersResource(server: McpServer, manifest: BagManifest | null): void {
  if (!manifest?.mcpServers || Object.keys(manifest.mcpServers).length === 0) return;

  server.resource("mcp-servers", "barry://config/mcp-servers", (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(manifest.mcpServers),
      },
    ],
  }));
}

/**
 * Serve a local bag over HTTP as a remote MCP bag.
 *
 * Extracted so the CLI (`barry bag serve`) and the QA mock exercise the same
 * code path — this is also the reference implementation a third-party author
 * can point at when writing their own server in another language.
 *
 * Binds to 127.0.0.1 by default: this exposes a bag's manifest and skills, so
 * listening on all interfaces must be a deliberate choice.
 *
 * Authentication: when `BARRY_SECRET` is set in the environment (or `secret`
 * is passed), every `/mcp` request must carry it as a bearer token or
 * `x-barry-secret`, parsed by the same `requestCredential` the API server
 * uses. When no secret is configured this route is UNAUTHENTICATED BY DESIGN:
 * it binds to loopback and serves only a bag's own manifest/skills/traits to
 * local tooling (`barry bag serve`, the QA mock). Exposing it off-host is the
 * caller's deliberate choice and should set a secret.
 *
 * When `port` is omitted, uses `listenOnAssignedPort` to read PORT from env —
 * the standard path for services started by the service management. Tests and CLI
 * callers pass an explicit port.
 */
export async function serveBagOverHttp(options: {
  bagDir: string;
  port?: number;
  host?: string;
  /** Require this secret on every /mcp request. Defaults to `BARRY_SECRET`. */
  secret?: string;
  /** Evict a session whose last request is older than this (ms). Default 5 min. */
  idleTimeoutMs?: number;
}): Promise<{ close: () => Promise<void>; url: string }> {
  const { createServer } = await import("node:http");
  const { randomUUID } = await import("node:crypto");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { isInitializeRequest } = await import("@modelcontextprotocol/sdk/types.js");
  const { carriesSecret } = await import("../auth/browser.js");

  const host = options.host ?? "127.0.0.1";
  const secret = options.secret ?? process.env.BARRY_SECRET ?? "";
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
  // Cap request bodies at 1 MB, matching services/http.ts's parser limit.
  const MAX_BODY_BYTES = 1_000_000;

  type Session = {
    transport: InstanceType<typeof StreamableHTTPServerTransport>;
    lastSeen: number;
  };
  const transports = new Map<string, Session>();

  // Build the loaded bag resources ONCE; each session's McpServer shares them
  // rather than re-parsing the manifest and re-walking skills/actions per
  // initialize.
  const resources = await loadBagResources(options.bagDir);

  const evictIdle = (): void => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const [id, session] of transports) {
      if (session.lastSeen < cutoff) {
        void session.transport.close?.();
        transports.delete(id);
      }
    }
  };

  // A bounded read: resolve on `end`, reject once the cap is exceeded, and
  // reject on stream errors so a half-open connection cannot hang the handler.
  const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let body = "";
      let size = 0;
      let aborted = false;
      req.on("data", (chunk: Buffer | string) => {
        if (aborted) return;
        size += Buffer.byteLength(chunk);
        if (size > MAX_BODY_BYTES) {
          // Stop accumulating and reject, but keep draining the request so the
          // 413 response can flush without the socket being torn down under it.
          aborted = true;
          req.resume();
          reject(new Error("request body too large"));
          return;
        }
        body += chunk.toString();
      });
      req.on("end", () => { if (!aborted) resolve(body); });
      req.on("error", (error) => { if (!aborted) reject(error); });
    });

  const httpServer = createServer(async (req, res) => {
    try {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (req.url !== "/mcp") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      // Gate when a secret is configured; otherwise unauthenticated-by-design
      // (see the function's docstring).
      if (secret && !carriesSecret(req, secret)) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      evictIdle();

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch (error) {
          // Malformed JSON or an oversize body is a client error, not an
          // unhandled rejection with the response left open.
          const tooLarge = error instanceof Error && error.message === "request body too large";
          res.writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: tooLarge ? "Payload too large" : "Invalid JSON" }));
          return;
        }

        if (isInitializeRequest(parsed)) {
          const newSessionId = randomUUID();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
          });
          transports.set(newSessionId, { transport, lastSeen: Date.now() });
          // An McpServer binds to a single transport, so each session gets its
          // own — built from the shared, already-loaded resources.
          await buildBagResourceServer(resources).connect(transport);
          await transport.handleRequest(req, res, parsed);
          return;
        }
        const session = sessionId ? transports.get(sessionId) : undefined;
        if (!session) {
          res.writeHead(400);
          res.end("No session");
          return;
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res, parsed);
        return;
      }

      if (req.method === "GET") {
        const session = sessionId ? transports.get(sessionId) : undefined;
        if (!session) {
          res.writeHead(400);
          res.end("No session");
          return;
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "DELETE") {
        const session = sessionId ? transports.get(sessionId) : undefined;
        if (session) {
          await session.transport.handleRequest(req, res);
          transports.delete(sessionId!);
        } else {
          res.writeHead(200);
          res.end();
        }
        return;
      }

      res.writeHead(405);
      res.end("Method not allowed");
    } catch {
      // Any unexpected error must still close the response rather than leave the
      // connection wedged.
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end("Internal error");
    }
  });

  let boundPort: number;
  if (options.port !== undefined) {
    // Explicit port: bind directly — used by tests and `barry bag serve`.
    // A 0 asks the OS for an ephemeral port, so read the address back.
    await new Promise<void>((resolve) => httpServer.listen(options.port, host, resolve));
    const address = httpServer.address();
    boundPort = typeof address === "object" && address ? address.port : options.port;
  } else {
    // No port: the service management assigned one in PORT, use the standard helper.
    const { listenOnAssignedPort, assignedPort } = await import("../services/listen.js");
    await listenOnAssignedPort(httpServer);
    boundPort = assignedPort();
  }

  return {
    url: `http://${host}:${boundPort}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const [id, session] of transports) {
          void session.transport.close?.();
          transports.delete(id);
        }
        httpServer.close(() => resolve());
      }),
  };
}


/**
 * Per-tool namespace/access metadata for the MCP proxy.
 *
 * Without this, enrichProxiedTools has nothing to go on and every proxied tool
 * defaults to `access: "write"` — i.e. read-only traits would not match tools
 * that are genuinely read-only. The consumer already read this URI
 * (bag-proxy.ts discoverTools); only the producer was missing.
 */
function registerToolsMetaResource(server: McpServer, tools: BagToolMeta[]): void {
  const meta = tools.map((tool) => ({
    name: tool.toolName,
    namespace: tool.namespace,
    access: tool.access,
  }));
  if (meta.length === 0) return;

  server.resource("tools-meta", "barry://tools-meta", (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(meta),
      },
    ],
  }));
}
