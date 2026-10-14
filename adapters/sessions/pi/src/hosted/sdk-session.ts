import type { Guarantees } from "@barry-rocks/sdk/adapters/harnesses";
import type { TokenUsage } from "@barry-rocks/sdk/adapters/models";
import { EventQueue } from "@barry-rocks/sdk/sessions";
import type {
  DeliveryOptions,
  DeliveryReceipt,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionConfig,
  SessionEvent,
} from "@barry-rocks/sdk/sessions";
import { declaredKeyFor, requireDeclaredKey } from "../credentials.js";
import { piEventOf, sumUsage } from "../event-mapping.js";
import { toPiMcpConfigs } from "../mcp-config.js";
import { ModelRefused, piModel } from "../model-id.js";
import { createPiToolGate } from "./tool-gate.js";
import { allowedNative, disallowedTools } from "../native-tools.js";
import { VERIFIED_ON } from "../modes.js";

/** Minimal duck-typed surface of the Pi AgentSession needed by Barry. */
export interface AgentSessionLike {
  readonly sessionId: string;
  subscribe(fn: (event: unknown) => void): () => void;
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  steer(text: string): Promise<"queued" | "handled">;
  abort(): Promise<void>;
  dispose(): void;
  readonly extensionRunner?: { emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown> };
  bindExtensions?(params?: unknown): Promise<void>;
}

export interface PiHostedOptions {
  guarantees: Guarantees;
  releaseAfterMs?: number;
  /** Test hook or mock session factory. */
  createSession?: (config: SessionConfig) => Promise<AgentSessionLike>;
}

export class PiHostedSession implements Session {
  readonly mode = "hosted" as const;
  readonly id: string;
  readonly guarantees: Guarantees;
  readonly harnessVersion = VERIFIED_ON;
  readonly warnings?: readonly string[];

  private harnessSessionIdVal: string | null = null;
  private initializing: Promise<void> | null = null;
  private sessionInstance: AgentSessionLike | null = null;
  private eventQueue = new EventQueue<SessionEvent>();
  private sessionState: "idle" | "active" | "error" = "idle";
  private releaseTimer: NodeJS.Timeout | null = null;
  private pendingQueue: Array<{ content: string; options?: DeliveryOptions; messageId: string }> = [];
  private openRequests = new Map<string, (decision: PermissionDecision) => void>();
  private closed = false;
  private messageCounter = 0;
  private turnNumber = 0;
  private turnOpen = false;
  private currentTurnUsage?: TokenUsage;
  private currentTurnError?: string;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly config: SessionConfig,
    private readonly options: PiHostedOptions,
  ) {
    this.id = config.sessionId;
    this.guarantees = options.guarantees;
    this.harnessSessionIdVal = config.resume?.harnessSessionId ?? null;
  }

  get harnessSessionId(): string | null {
    return this.harnessSessionIdVal;
  }

  status(): "idle" | "active" | "error" {
    return this.sessionState;
  }

  events(): AsyncIterable<SessionEvent> {
    return this.eventQueue;
  }

  async init(): Promise<void> {
    if (this.sessionInstance) return;
    if (!this.initializing) this.initializing = this.initialize().finally(() => { this.initializing = null; });
    await this.initializing;
  }

  private async initialize(): Promise<void> {
    const config = this.harnessSessionIdVal ? { ...this.config, resume: { harnessSessionId: this.harnessSessionIdVal } } : this.config;
    if (this.options.createSession) {
      this.sessionInstance = await this.options.createSession(config);
    } else {
      this.sessionInstance = await this.createRealAgentSession(config);
    }

    if (this.closed) { await this.disposeSession(); throw new Error("Session is closed"); }
    this.harnessSessionIdVal = this.sessionInstance.sessionId;

    this.unsubscribe = this.sessionInstance.subscribe((rawEvent) => {
      const signals = piEventOf(rawEvent);
      for (const event of signals.events) {
        this.eventQueue.push(event);
      }
      if (signals.usage) {
        this.currentTurnUsage = sumUsage(this.currentTurnUsage, signals.usage);
      }
      if (signals.error) {
        this.currentTurnError = signals.error;
        this.eventQueue.push({ type: "error", error: signals.error });
      }
    });

    if (this.harnessSessionIdVal) {
      this.eventQueue.push({
        type: "init",
        harnessSessionId: this.harnessSessionIdVal,
      });
    }
  }

  private async createRealAgentSession(config: SessionConfig): Promise<AgentSessionLike> {
    const {
      createAgentSession,
      createMcpExtension,
      DefaultResourceLoader,
      getAgentDir,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");

    const modelName = config.model ?? "anthropic/claude-sonnet-5";
    const parsedModel = piModel(modelName);
    if (!config.endpoint) {
      requireDeclaredKey(parsedModel, config.env);
    }

    // In-memory credentials isolated from the user's ~/.pi/agent/auth.json
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
    });

    if (config.endpoint) {
      const isAnthropic = config.endpoint.baseUrl.includes("/anthropic") || config.endpoint.baseUrl.includes("/messages");
      const apiType = isAnthropic ? "anthropic-messages" : "openai-completions";
      modelRuntime.registerProvider(parsedModel.provider, {
        baseUrl: config.endpoint.baseUrl,
        api: apiType,
        apiKey: config.endpoint.apiKey,
        models: [
          {
            id: parsedModel.model,
            name: parsedModel.model,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 4096,
          },
        ],
      });
      if (config.endpoint.apiKey) {
        await modelRuntime.setRuntimeApiKey(parsedModel.provider, config.endpoint.apiKey);
      }
    } else {
      // Populate runtime API keys from config.env
      const providerKey = declaredKeyFor(parsedModel.provider, config.env);
      if (providerKey) {
        await modelRuntime.setRuntimeApiKey(parsedModel.provider, providerKey);
      }
    }

    const modelObj = modelRuntime.getModel(parsedModel.provider, parsedModel.model);
    if (!modelObj) {
      throw new ModelRefused(
        `pi catalog does not know model "${parsedModel.provider}/${parsedModel.model}"`,
      );
    }

    let sessionManager: ReturnType<typeof SessionManager.create>;
    if (config.resume?.harnessSessionId) {
      const existing = SessionManager.findById(config.cwd, config.resume.harnessSessionId);
      if (existing) {
        sessionManager = SessionManager.open(existing);
      } else {
        throw new Error(`Pi conversation ${config.resume.harnessSessionId} was not found in ${config.cwd}`);
      }
    } else {
      sessionManager = SessionManager.create(config.cwd);
    }

    const extensionFactories: import("@earendil-works/pi-coding-agent").ExtensionFactory[] = [];

    extensionFactories.push(createPiToolGate(config));

    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      const piMcpConfigs = toPiMcpConfigs(config.mcpServers);
      extensionFactories.push(createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) }));
      extensionFactories.push((pi) => {
        for (const [name, srv] of Object.entries(piMcpConfigs)) {
          pi.registerMcpServer(name, srv);
        }
      });
    }

    const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], skills: [] });
    const resourceLoader = new DefaultResourceLoader({
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      cwd: config.cwd,
      agentDir: getAgentDir(),
      additionalSkillPaths: config.pluginDirs ? [...config.pluginDirs] : [],
      appendSystemPrompt: config.systemPrompt ? [config.systemPrompt] : undefined,
      extensionFactories,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      settingsManager,
      noTools: "builtin",
      cwd: config.cwd,
      modelRuntime,
      model: modelObj,
      sessionManager,
      resourceLoader,
      excludeTools: disallowedTools(config),
    });

    if (session.bindExtensions) {
      await session.bindExtensions({});
    }

    if (allowedNative(config).length) session.setActiveToolsByName([...session.getActiveToolNames(), ...allowedNative(config)]);
    return session;
  }

  async deliver(content: string, options?: DeliveryOptions): Promise<DeliveryReceipt> {
    if (this.closed) throw new Error("Session is closed");

    await this.init();

    this.messageCounter += 1;
    const messageId = `msg-${this.messageCounter}`;

    if (this.sessionState === "active") {
      if (options?.ifActive === "steer" && this.sessionInstance) {
        await this.sessionInstance.steer(content);
        return { messageId, status: "steered" };
      }
      this.pendingQueue.push({ content, options, messageId });
      return { messageId, status: "queued" };
    }

    this.sessionState = "active";
    this.clearReleaseTimer();
    this.currentTurnUsage = undefined;
    this.currentTurnError = undefined;
    this.turnOpen = true;

    this.runTurn(content).catch(() => {
      this.sessionState = "error";
    });

    return { messageId, status: "started" };
  }

  private async runTurn(content: string): Promise<void> {
    const currentTurn = ++this.turnNumber;
    try {
      if (!this.sessionInstance) throw new Error("Session instance missing");
      await this.sessionInstance.prompt(content);
    } catch (err) {
      if (this.turnNumber === currentTurn && this.turnOpen) {
        this.currentTurnError = err instanceof Error ? err.message : String(err);
        this.eventQueue.push({ type: "error", error: this.currentTurnError });
      }
    } finally {
      if (this.turnNumber === currentTurn && this.turnOpen) {
        this.turnOpen = false;
        this.eventQueue.push({
          type: "done",
          ...(this.currentTurnUsage ? { usage: this.currentTurnUsage } : {}),
        });
        this.finishTurn();
      }
    }
  }

  async interrupt(): Promise<void> {
    if (this.sessionState !== "active" || !this.turnOpen) return;
    if (this.sessionInstance) {
      await this.sessionInstance.abort();
    }
    if (this.turnOpen) {
      this.turnOpen = false;
      this.eventQueue.push({
        type: "done",
        ...(this.currentTurnUsage ? { usage: this.currentTurnUsage } : {}),
      });
      this.finishTurn();
    }
  }

  async answer(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    const resolve = this.openRequests.get(request.id);
    if (!resolve) return;
    this.openRequests.delete(request.id);
    resolve(decision);
  }

  private finishTurn(): void {
    this.sessionState = "idle";
    const next = this.pendingQueue.shift();
    if (next && !this.closed) {
      this.sessionState = "active";
      this.currentTurnUsage = undefined;
      this.currentTurnError = undefined;
      this.turnOpen = true;
      this.runTurn(next.content).catch(() => {
        this.sessionState = "error";
      });
    } else {
      this.scheduleRelease();
    }
  }

  private scheduleRelease(): void {
    const after = this.options.releaseAfterMs;
    if (!after || this.closed) return;
    this.clearReleaseTimer();
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (this.sessionState === "idle" && !this.closed) {
        this.unsubscribe?.();
        this.unsubscribe = null;
        void this.disposeSession().catch(() => { this.sessionState = "error"; });
      }
    }, after);
    this.releaseTimer.unref();
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  private async disposeSession(): Promise<void> {
    const session = this.sessionInstance;
    this.sessionInstance = null;
    if (!session) return;
    // Pi's dispose removes listeners; MCP teardown needs the shutdown event first.
    try { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
    finally { session.dispose(); }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearReleaseTimer();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.initializing) await this.initializing.catch(() => undefined);
    await this.disposeSession();
    this.eventQueue.end();
  }
}

export async function startPiHosted(
  config: SessionConfig,
  options: PiHostedOptions,
): Promise<PiHostedSession> {
  const session = new PiHostedSession(config, options);
  await session.init();
  return session;
}
export async function createPiAgentSession(config: SessionConfig, options: { durable?: boolean } = {}): Promise<import("@earendil-works/pi-coding-agent").AgentSession> {
  const {
    createAgentSession,
    createMcpExtension,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");

  const modelName = config.model ?? "anthropic/claude-sonnet-5";
  const parsedModel = piModel(modelName);
  requireDeclaredKey(parsedModel, config.env);

  // In-memory credentials isolated from the user's ~/.pi/agent/auth.json
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
  });

  // Populate runtime API keys from config.env
  const providerKey = declaredKeyFor(parsedModel.provider, config.env);
  if (providerKey) {
    await modelRuntime.setRuntimeApiKey(parsedModel.provider, providerKey);
  }

  const modelObj = modelRuntime.getModel(parsedModel.provider, parsedModel.model);
  if (!modelObj) {
    throw new ModelRefused(
      `pi catalog does not know model "${parsedModel.provider}/${parsedModel.model}"`,
    );
  }

  // Session persistence / resume
  let sessionManager: ReturnType<typeof SessionManager.create>;
  if (options.durable) {
    // Sessions owns durable history; Pi's transcript must not become a second
    // authority or silently replace the checkpoint during request preparation.
    sessionManager = SessionManager.inMemory(config.cwd);
  } else if (config.resume?.harnessSessionId) {
    const existing = SessionManager.findById(config.cwd, config.resume.harnessSessionId);
    if (existing) {
      sessionManager = SessionManager.open(existing);
    } else {
      throw new Error(`Pi conversation ${config.resume.harnessSessionId} is missing; refusing to start a replacement`);
    }
  } else {
    sessionManager = SessionManager.create(config.cwd);
  }

  // MCP servers and tool gating extension
  const extensionFactories: import("@earendil-works/pi-coding-agent").ExtensionFactory[] = [];

  extensionFactories.push(createPiToolGate(config));

  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    const piMcpConfigs = toPiMcpConfigs(config.mcpServers);
    extensionFactories.push(createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) }));
    extensionFactories.push((pi) => {
      for (const [name, srv] of Object.entries(piMcpConfigs)) {
        pi.registerMcpServer(name, options.durable ? { ...srv, exposure: "direct" } : srv);
      }
    });
  }

  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], skills: [] });
  const resourceLoader = new DefaultResourceLoader({
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    cwd: config.cwd,
    agentDir: getAgentDir(),
    additionalSkillPaths: config.pluginDirs ? [...config.pluginDirs] : [],
    appendSystemPrompt: config.systemPrompt ? [config.systemPrompt] : undefined,
    extensionFactories,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    settingsManager,
    noTools: "builtin",
    cwd: config.cwd,
    modelRuntime,
    model: modelObj,
    sessionManager,
    resourceLoader,
    excludeTools: disallowedTools(config),
  });

  if (session.bindExtensions) {
    await session.bindExtensions({});
  }

  if (allowedNative(config).length) session.setActiveToolsByName([...session.getActiveToolNames(), ...allowedNative(config)]);
  return session;
}
