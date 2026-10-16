import { hostEnvironment, barryRunDir } from "@barry-rocks/sdk/services";
import { resolveNativeTools } from "@barry-rocks/sdk/bounds";
import { configureSession, refuseDeniedTools, runStructured, structuredOutputFor, type SessionConfig } from "@barry-rocks/sdk/sessions";
import { trackSession } from "./tracked-session.js";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
// The CLI is a composition root: the harness a run uses is loaded from the
// installed adapter records, and its model routed over the vendor list.
import type { StartEngine } from "@barry-rocks/sdk/adapters/harnesses";
import {
  installedModels,
  keylessRouteRefusal,
  routedEndpoint,
  routeModel,
} from "@barry-rocks/sdk/adapters/models";

import { ownedEngines } from "@barry-rocks/sessions-bag/engines";
import { sessionModelRef } from "./sessions/launch.js";
import { parseBagFlagTokens } from "./sessions/prepare.js";
import { defaultBags, loadBags, expandCompositionFromSnapshot, loadBagRegistrySnapshot, mergeBags } from "@barry-rocks/sdk/internal/bags";
// Remote discovery is installed when the explicit query operation starts.
import { installRemoteBagLoader } from "@barry-rocks/sdk/internal/mcp";

import { buildSkillsPlugin, resolveSkillDirs } from "@barry-rocks/sdk/internal/actions";
import { listAllInstructions, joinAlwaysInstructions, buildInstructionsIndex, buildBagInstructionPointer } from "@barry-rocks/sdk/internal/instructions";

import { Barry } from "@barry-rocks/sdk";
import { adapterSettings, defaultHarness, FALLBACK_HARNESS, requiredIdentityBags, requiredNames, type IdentityAdapters } from "@barry-rocks/sdk/internal/identities";
import { identityRecords } from "@barry-rocks/identities-bag";
import { Sessions } from "@barry-rocks/sessions-bag/client";
import { identityEnvironment, requiredCredentials } from "@barry-rocks/sdk/internal/env";
import { getCurrentUser } from "./lib/current-user.js";
import { useInstanceSecret } from "./config.js";
import { sessionMcpConfig } from "./lib/session-mcp-config.js";

export interface QueryOptions {
  prompt: string;
  maxTurns?: number;
  cwd?: string;
  /** Barry whose bags, env and default model the run should use. */
  barry?: string;
  /** Bag names granting tools and skills, e.g. ["slack", "git:read"]. */
  bags?: string[];
  /** Bound names restricting the run, e.g. ["readonly", "git:no-push"]. */
  bounds?: string[];
  model?: string;
  /**
   * Harness id from the registry ("claude", "codex", ...). Defaults to "claude".
   * The retired "claude-sdk"/"codex-sdk" ids are still accepted and mapped.
   */
  harness?: string;
  provider?: string;
  /**
   * JSON Schema the answer must conform to. When set, the run goes through
   * runStructured — native enforcement where the harness supports it, the
   * prompted fallback elsewhere — and `structured` carries the validated value.
   */
  schema?: Record<string, unknown>;
}

export interface QueryResult {
  result: string;
  sessionId?: string;
  /** Present iff `schema` was requested: the schema-valid payload. */
  structured?: unknown;
}

/**
 * Run a single prompt to completion, non-interactively.
 *
 * This is the headless counterpart to `barry start`, and the path a scheduled
 * job takes. It resolves the same identity, bags, bounds and skills a CLI
 * session gets — without that, a prompt naming a bag skill has nothing to
 * load and the run silently does the wrong thing.
 */
export async function runQuery(options: QueryOptions): Promise<QueryResult> {
  installRemoteBagLoader();
  await useInstanceSecret();

  const {
    bagNames,
    requiredBagNames,
    boundNames,
    env: identityEnv,
    adapters,
    identityId,
  } = await resolveIdentity(options.barry ?? process.env.BARRY_IDENTITY);

  // The MCP server grants tools by the *session's* bags, bounds and identity, read
  // from the sessions table via `?sessionId=`. Without a session row the run
  // is anonymous and gets only base default tools, so every run gets one -- with
  // the barry attached, so `--name` reaches the tool grant and not just the
  // environment.
  const requested = options.harness ?? options.provider ?? defaultHarness(adapters) ?? FALLBACK_HARNESS;
  const { harnessAdapter, adapterStore } = await import("./adapters/installed.js");
  const adapter = await harnessAdapter(requested === "claude-sdk" ? "claude" : requested === "codex-sdk" ? "codex" : requested);
  const sessionHarness = adapter.id;

  // Everything the run is granted, from the identity and the bags and bounds asked for:
  // the bags and bounds recorded on its session, its namespaces, skills, instructions and bound.
  const parsedBags = parseBagFlagTokens((options.bags ?? []).join(","));
  const selectedBags = [...new Set([...defaultBags(), ...requiredBagNames, ...parsedBags.bags])];
  const selectedBounds = [...new Set([...boundNames, ...(options.bounds ?? []), ...parsedBags.readBounds])];
  const selection = {
    bags: selectedBags,
    bounds: selectedBounds,
    harness: sessionHarness,
    mode: "hosted" as const,
  };

  const [resolvedBound, resolvedTools, resolvedSkills, resolvedInstructions] = await Promise.all([
    identityId !== undefined
      ? Barry.identity(identityId).bound(selectedBounds)
      : Barry.bound(null, selectedBounds),
    identityId !== undefined
      ? Barry.identity(identityId).tools(selection)
      : Barry.tools(null, selectedBags, selectedBounds),
    Barry.skills(identityId ?? undefined, selectedBags).catch(() => []),
    Barry.instructions(identityId ?? undefined, selectedBags).catch(() => []),
  ]);

  const namespaces = [
    ...new Set([
      ...selectedBags,
      ...resolvedTools
        .filter((tool) => tool.bag !== null && tool.namespace)
        .map((tool) => tool.namespace),
    ]),
  ];

  const adapterRecord = (await adapterStore()).adapters.installed().find(record => record.id === adapter.id);
  const barrySessionId: string | undefined = randomUUID()
    .replace(/-/g, "")
    .slice(0, 21);
  const engines = ownedEngines({ baseDir: barryRunDir() });
  const onExit = () => engines.stopAll();
  const onSignal = (signal: NodeJS.Signals) => {
    engines.stopAll();
    process.kill(process.pid, signal);
  };
  const onTerm = () => onSignal("SIGTERM"),
    onInterrupt = () => onSignal("SIGINT");
  let ownsHandlers = false;
  const startHarnessEngine: StartEngine = (spec) => {
    if (!ownsHandlers) {
      process.once("exit", onExit);
      process.once("SIGTERM", onTerm);
      process.once("SIGINT", onInterrupt);
      ownsHandlers = true;
    }
    return engines.start(spec);
  };

  let skillsPluginDir: string | null | undefined;
  try {
    try {
      await Sessions.create({
        id: barrySessionId,
        // A one-shot run belongs to no agent actor.
        agent_token: null,
        bags: selectedBags,
        bounds: selectedBounds,
        ...(resolvedBound && Object.keys(resolvedBound).length > 0 ? { bound: resolvedBound } : {}),
        ...(identityId !== undefined ? { identity_id: identityId } : {}),
        metadata: {
          working_directory: options.cwd ?? process.cwd(),
          source: "cli-run",
          provider: sessionHarness,
        },
      });
    } catch (error) {
      throw new Error(`Could not record Barry session: ${error instanceof Error ? error.message : String(error)}`);
    }

    // The same servers `barry start` connects: the barry aggregate plus one
    // endpoint per namespace the session is granted.
    const sessionConfig = await sessionMcpConfig(
      namespaces,
      barrySessionId,
      namespaces,
    );

    type McpServerConfig =
      | { command: string; args?: string[]; env?: Record<string, string> }
      | { type: "http"; url: string; headers?: Record<string, string> };

    const mcpServers: Record<string, McpServerConfig> = {};
    for (const [name, server] of Object.entries(sessionConfig.mcpServers)) {
      if (server.disabled) continue;
      if (server.command) {
        mcpServers[name] = { command: server.command, args: server.args };
      } else if (server.url) {
        const configured = "headers" in server ? server.headers : undefined;
        const headers =
          configured ??
          (process.env.BARRY_SECRET
            ? { Authorization: `Bearer ${process.env.BARRY_SECRET}` }
            : undefined);
        mcpServers[name] = {
          type: "http",
          url: server.url,
          ...(headers ? { headers } : {}),
        };
      }
    }

    const bagSkillNames = resolvedSkills.map((skill) => skill.name);
    const bagSkillDirs = bagSkillNames.length
      ? await resolveSkillDirs(
          (await loadBagRegistrySnapshot()).bags,
          bagSkillNames,
        )
      : [];

    const loadNames = bagNames.length
      ? await expandCompositionFromSnapshot(bagNames)
      : [];
    const bags = loadNames.length ? await loadBags(loadNames) : [];
    const merged = bags.length ? mergeBags(bags) : null;

    for (const [name, server] of Object.entries(merged?.mcpServers ?? {})) {
      if (server.command) {
        mcpServers[name] = { command: server.command, args: server.args };
      }
    }

    skillsPluginDir = buildSkillsPlugin(
      merged?.skillsDirs ?? [],
      bagSkillDirs,
    );

    // Best-effort: prose must never fail a run. Falls back to the legacy string
    // so a bag that has not migrated keeps working.
    let instructions = "";
    try {
      const { bags: allBags } = await loadBagRegistrySnapshot();
      const resolved = await listAllInstructions(allBags, {
        bagNames: loadNames,
      });
      const bagInstructionNames = resolvedInstructions.map((instruction) => instruction.name);
      const sections = [
        joinAlwaysInstructions(resolved),
        buildInstructionsIndex(resolved, { exclude: bagInstructionNames }),
        buildBagInstructionPointer(bagInstructionNames, resolved),
      ].filter((text): text is string => Boolean(text));
      instructions = sections.join("\n\n");
    } catch {
      instructions = bags
        .map((bag) => bag.manifest?.instructions)
        .filter((text): text is string => Boolean(text))
        .join("\n\n");
    }

    const runEnv = queryEnvironment({});

    // One registry id per harness now: "claude-sdk"/"codex-sdk" were the SDK
    // halves of harnesses that used to register twice, and the registry no longer
    // knows them. Defaulting to "claude-sdk" failed every `barry session run`
    // with "Unknown agent: claude-sdk". The legacy ids are still accepted from
    // callers and mapped, so an old caller keeps working instead of failing.
    // The barry's model applies only on the barry's own harness, so the same
    // normalised id is what the model check compares against.

    const hosted = adapter.modes.hosted;
    if (!hosted)
      throw new Error(
        `${sessionHarness} has no hosted mode, so \`barry session run\` cannot run it`,
      );

    const vendors = installedModels().vendors();
    const route = routeModel(
      adapter,
      {
        ...(options.model ? { model: options.model } : {}),
        identity: { model: adapterSettings(adapters, adapter)?.model },
      },
      vendors,
    );
    const sessionModel = route.model;
    const modelProvider = route.vendor;

    const model = sessionModel
      ? sessionModelRef(
          sessionHarness,
          sessionModel,
          modelProvider ?? adapter.vendor,
        )
      : undefined;
    const credentialNames = requiredCredentials({
      harness: { id: adapter.id, credentials: adapterRecord?.bag?.manifest.credentials },
      routedVendors: modelProvider && modelProvider !== adapter.vendor ? vendors.filter(vendor => vendor.id === modelProvider) : [],
    }).map(credential => credential.env);
    for (const name of credentialNames) {
      if (!identityEnv[name]) throw new Error(`$${name}: required session secret is unavailable from the selected identity`);
      runEnv[name] = identityEnv[name];
    }
    const keyless = keylessRouteRefusal(adapter, route, vendors, runEnv);
    if (keyless) throw new Error(keyless);
    const endpoint = routedEndpoint(adapter, model, vendors, runEnv);
    if (!adapterRecord) throw new Error(`no installed adapter record for ${adapter.id}`);
    const native = resolveNativeTools(resolvedBound, resolvedTools, adapterRecord, "hosted");
    if (Object.keys(native.conflicts).length) throw new Error(`session bounds cannot take back ${Object.keys(native.conflicts).join(", ")} on ${adapter.id} (hosted)`);
    const deniedNativeTools = native.denied;
    const config: SessionConfig = configureSession({
      // The run's own session when one was recorded. Without one there is
      // still a run to name, and nothing reads the id but the harness.
      sessionId: barrySessionId ?? `run-${randomUUID()}`,
      cwd: options.cwd ?? process.cwd(),
      // What the run used to inherit implicitly, with the barry's env applied.
      env: runEnv,
      mcpServers,
      maxTurns: options.maxTurns ?? 15,
      ...(model ? { model } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(skillsPluginDir ? { pluginDirs: [skillsPluginDir] } : {}),
      ...(instructions ? { systemPrompt: instructions } : {}),
      deniedTools: deniedNativeTools,
      allowedNativeTools: native.allowed,
      decide: refuseDeniedTools(deniedNativeTools),
    });
    await Sessions.updateMetadata(barrySessionId, { provider: sessionHarness, model, model_provider: modelProvider });
    // Apply the declared guidance fallback to one-shot and structured callers too.
    const prompt = adapter.capabilities.systemPromptFormat === "unsupported" && instructions.trim()
      ? `${instructions}\n\n---\n\n${options.prompt}` : options.prompt;
    const start = async () => trackSession(await hosted.start(config, startHarnessEngine), sessionHarness, model);

    if (options.schema) {
      const structuredRun = await runStructured({
        prompt,
        schema: options.schema,
        structuredOutput: structuredOutputFor(hosted, {
          harnessVendor: adapter.vendor,
          model,
          models: installedModels(),
        }),
        // One structured answer, never resumed: nothing of it need outlive the run.
        start: async () => trackSession(await hosted.start({ ...config, ephemeral: true }, startHarnessEngine), sessionHarness, model),
      });
      return {
        result: structuredRun.raw,
        structured: structuredRun.data,
        ...(structuredRun.harnessSessionId
          ? { sessionId: structuredRun.harnessSessionId }
          : {}),
      };
    }

    // A hosted session with one turn: deliver, read to the turn's end, close.
    const session = await start();
    try {
      await session.deliver(prompt);
      let result = "";
      for await (const event of session.events()) {
        if (event.type === "error") throw new Error(event.error);
        if (event.type === "result" && event.error) throw new Error(event.error);
        if (event.type === "result" && event.result) result = event.result;
        if (event.type === "done") break;
      }
      return {
        result,
        ...(session.harnessSessionId
          ? { sessionId: session.harnessSessionId }
          : {}),
      };
    } finally {
      await session.close();
    }
  } finally {
    engines.stopAll();
    process.removeListener("exit", onExit);
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInterrupt);
    if (skillsPluginDir) {
      try {
        rmSync(skillsPluginDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    // Close the synthetic session so one-shot runs don't accumulate rows that
    // look active to `session list` and the menu-bar apps.
    if (barrySessionId) {
      try {
        await Sessions.end(barrySessionId, "cli-run-complete");
      } catch {
        /* best-effort */
      }
    }
  }
}

interface ResolvedIdentity {
  bagNames: string[];
  requiredBagNames: string[];
  boundNames: string[];
  env: Record<string, string>;
  adapters: IdentityAdapters;
  /** The `identities` row id to put on the run's session, so the tool grant sees the identity. */
  identityId?: number;
}

/**
 * Resolve an identity's bags, secrets and default model.
 *
 * Falls back to no identity rather than failing: a prompt that needs no bag
 * tools should still run on a machine with no database reachable.
 */
async function resolveIdentity(name?: string): Promise<ResolvedIdentity> {
  if (!name) return { bagNames: [], requiredBagNames: [], boundNames: [], env: {}, adapters: {} };

  try {
    const user = await getCurrentUser();
    const { record } = await identityRecords.find(name);
    const resolved = identityRecords.config(record);

    let env: Record<string, string> = {};
    env = (await identityEnvironment(resolved)).vars;

    // A file-based barry's own id is a name hash with no `identities` row;
    // this returns the row's real id, the same resolution every other writer
    // of `sessions.identity_id` uses.
    const identityId =
      (await identityRecords.rowId(record, { actorId: user.id })) ?? undefined;

    return {
      bagNames: resolved.bags ?? [],
      requiredBagNames: requiredIdentityBags(resolved.bags ?? [], resolved.bag_configs ?? {}),
      boundNames: requiredNames(resolved.bounds ?? []),
      env,
      adapters: resolved.adapters,
      ...(identityId !== undefined ? { identityId } : {}),
    };
  } catch (error) {
    if (name || process.env.BARRY_IDENTITY_BINDING) throw error;
    console.warn(
      `Warning: could not resolve barry "${name}" — continuing without it ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    return { bagNames: [], requiredBagNames: [], boundNames: [], env: {}, adapters: {} };
  }
}

/**
 * Build the harness environment from host essentials and selected identity credentials.
 * Unrelated shell credentials must not become identity credentials.
 */
function queryEnvironment(identityEnv: Record<string, string>): NodeJS.ProcessEnv {
  return { ...hostEnvironment(), ...identityEnv };
}
