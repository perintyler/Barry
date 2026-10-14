// Method bodies extracted from session-runtime.ts for file size.
// Moved verbatim as free functions taking the runtime instance (`rt`);
// the SessionRuntime class delegates to these. Pure move + rewire.
import {SessionRuntime, log} from "../session-runtime.js";
import type { ActiveSession, McpServerConfig } from "../session-runtime.js";
import {getCreateSession, getDescribeAdapter, modelRefFor} from "../agent-runtime.js";
import {getSessionRecord, issueWorkflowCredential} from "../db.js";
import {resolveEnvForBarry} from "../identity-env.js";
import {canDenyNativeTools, nativeToolPolicy, resolveEgressSandbox} from "../session-agent-guards.js";
import {withWorkflowSessionCredential} from "../workflow-mcp-credentials.js";
import {installedModels} from "@barry-rocks/sdk/adapters/models";
import {executionScopeSchema, scopeFingerprint} from "@barry-rocks/sdk/bounds";
import {addActionCommandsToPlugin, buildActionCommandsDir, buildSkillsPlugin, listAllActions, resolveSkillDirs, selectSlashCommandActions} from "@barry-rocks/sdk/internal/actions";
import {mintWorkflowSessionCredential} from "@barry-rocks/sdk/internal/auth";
import {loadBagRegistrySnapshot} from "@barry-rocks/sdk/internal/bags";
import {assertSessionCredentials, requiredCredentials} from "@barry-rocks/sdk/internal/env";
import {type SessionConfig as HarnessSessionConfig, type PermissionDecision, type PermissionRequest, type Session, configureSession, isScopedMcpTool} from "@barry-rocks/sdk/sessions";
import {sessionGrants} from "@barry-rocks/sessions-bag";
import {rmSync} from "fs";

  /**
   * Run a single turn using the persistent session.
   * The session stays open between turns for follow-up messages.
   */
export async function rt_resolveHarnessEnvironment(rt: SessionRuntime, activeSession: ActiveSession): Promise<Record<string, string | undefined>> {
    const identityEnv = await resolveEnvForBarry(activeSession.identityId);
    const env = identityEnv.vars;

    // THE GATE. Every credential this turn authenticates with must come
    // from a declared source: the harness bag's `credentials:`, plus — for a
    // model of another vendor — that vendor row's credential. Checked
    // against this turn's environment, since a key can be added or rotated
    // between turns. Replaces both the routed-vendor refusal and the
    // log-and-proceed `session.missing_credential` warning it grew from:
    // now a codex session with no key refuses like a routed one, naming the
    // fix, instead of proceeding on whatever local login exists.
    const record = getDescribeAdapter()?.(activeSession.provider);
    if (record) {
      const routedVendors =
        activeSession.modelProvider && activeSession.modelProvider !== record.vendor
          ? installedModels().vendors().filter((vendor) => vendor.id === activeSession.modelProvider)
          : [];
      const required = requiredCredentials({
        harness: {
          id: record.id,
          credentials: record.bag?.manifest.credentials,
        },
        routedVendors,
      });
      for (const { env: name } of required) {
        const secret = identityEnv.environment?.vars[name];
        if (secret !== undefined) env[name] = secret;
      }
      try {
        assertSessionCredentials({
          required,
          env: identityEnv.environment ?? { vars: {}, sources: {} },
          // The turn env is built here from identity output — nothing ambient
          // is inherited — so there is nothing to strip.
          ambientEnv: {},
          credentialEnvs: new Set(),
        });
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err));
      }
    }

    return env;
  }

export async function rt_prepareHarnessConfiguration(rt: SessionRuntime, 
    activeSession: ActiveSession,
    mcpServers: Record<string, McpServerConfig> = activeSession.mcpServers,
    suppliedEnv?: Record<string, string | undefined>,
    interactive = true,
  ): Promise<HarnessSessionConfig> {
    const env = suppliedEnv ?? await rt.resolveHarnessEnvironment(activeSession);
    const record = getDescribeAdapter()?.(activeSession.provider);
        // The running harness's bag maps effective restrictions to its native
        // inventory. Context removal depends on its capabilities; hosted
        // approval requests also run through the per-call ruling below.
        const native = await nativeToolPolicy(activeSession);
        if (Object.keys(native.conflicts).length) throw new Error(`session bounds cannot take back ${Object.keys(native.conflicts).join(", ")} on ${activeSession.provider} (hosted): ${[...new Set(Object.values(native.conflicts))].join("; ")}`);
        const deniedTools = native.denied;
        if (deniedTools.length && !canDenyNativeTools(activeSession.provider)) throw new Error("native-tool restrictions cannot be enforced by this harness");

        const scopedMcpServers = { ...mcpServers };
        if (activeSession.workflowScoped) {
          const secret = process.env.BARRY_SECRET;
          const record = await getSessionRecord(activeSession.id);
          if (!secret || !record?.metadata?.workflow_scope || !record.user_id || !activeSession.identityId || record.identity_id !== activeSession.identityId) {
            throw new Error("workflow session credential cannot be issued without its persisted identity and scope");
          }
          const scope = executionScopeSchema.parse(record.metadata.workflow_scope);
          const { fingerprint, ...evidence } = scope;
          if (!scope.identity || scopeFingerprint(evidence) !== fingerprint || record.metadata.workflow_identity_id !== activeSession.identityId || (scope.harness && scope.harness !== activeSession.provider)) {
            throw new Error("workflow session credential identity, harness, or scope is invalid");
          }
          const credentialId = await issueWorkflowCredential(activeSession.id, {
            actorId: record.user_id, identityId: activeSession.identityId, scopeFingerprint: scope.fingerprint,
          });
          if (!credentialId) throw new Error("workflow session credential run binding is unavailable");
          const credential = mintWorkflowSessionCredential(secret, {
            credentialId,
            actorId: record.user_id,
            identityId: activeSession.identityId,
            sessionId: activeSession.id,
            identity: scope.identity,
            scopeFingerprint: scope.fingerprint,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          });
          Object.assign(scopedMcpServers, withWorkflowSessionCredential(scopedMcpServers, credential));
        }
        for (const [name, server] of Object.entries(scopedMcpServers)) {
          if ("url" in server && server.url && server.url.includes("/mcp")) {
            const sep = server.url.includes("?") ? "&" : "?";
            scopedMcpServers[name] = { ...server, url: `${server.url}${sep}sessionId=${activeSession.id}` };
          }
        }

        // Resolve ${VAR} placeholders in MCP server args with actual env values.
        // A stdio entry's args reach spawn() as literal strings -- nothing
        // shell-expands "${KEY}" -- so resolve them here where the values exist.
        for (const [name, server] of Object.entries(scopedMcpServers)) {
          if ("args" in server && Array.isArray(server.args)) {
            const hasPlaceholders = server.args.some((a: string) => /\$\{[\w]+\}/.test(a));
            if (hasPlaceholders) {
              scopedMcpServers[name] = {
                ...server,
                args: server.args.map((a: string) =>
                  a.replace(/\$\{(\w+)\}/g, (_: string, v: string) => env[v] || "")
                ),
              };
            }
          }
        }

        log.info("sdk.scope", {
          sessionId: activeSession.id,
          traits: activeSession.traits,
        });

        // Mount skills as a loadable plugin where the provider can take one.
        // Best-effort: skill mounting must never block a session start.
        if (record?.capabilities.skillsMount === "plugin") {
          try {
            // Re-read session traits from the DB — PATCH /sessions/:id updates
            // the row + invalidates the SDK session without touching this
            // in-memory copy, and the next turn lands here.
            const freshTraits = (await getSessionRecord(activeSession.id))?.traits;
            if (freshTraits) activeSession.traits = freshTraits;
            const skillNames = (await sessionGrants(activeSession.id)).skills.map((skill) => skill.name);
            // This block runs EVERY TURN. `loadBagRegistrySnapshot` is the
            // process-wide memo — one load for the life of the server — which
            // is exactly the property the catalogs used to get by calling it
            // themselves. Never swap this for `loadAllBags()`: that re-reads
            // the registry and re-loads every bag, which for a remote bag with
            // `resources: true` means an MCP handshake per turn per bag.
            const registeredBags = (await loadBagRegistrySnapshot()).bags;
            const traitSkillDirs = await resolveSkillDirs(registeredBags, skillNames);
            // Recomputed per turn rather than reused from session start: traits
            // are re-read from the DB just above, so a trait added mid-session
            // gets its command on the next turn instead of the next restart.
            const commandActions = selectSlashCommandActions(
              await listAllActions(registeredBags),
              activeSession.bagNames,
              traitSkillDirs,
            );
            if (activeSession.skillsPluginDir) {
              try { rmSync(activeSession.skillsPluginDir, { recursive: true, force: true }); } catch { /* best-effort */ }
            }
            activeSession.skillsPluginDir = buildSkillsPlugin(activeSession.bagSkillsDirs, traitSkillDirs);
            // Slash commands ride inside the plugin here, not via --add-dir as
            // in the CLI: the SDK reads.claude/commands/ only from cwd and only
            // with settingSources containing "project", and this path sets
            // neither. The cost is the name — `/barry:wrap-up`, not `/wrap-up`.
            //
            // Cursor is the exception: cursor-agent takes --add-dir, so it gets
            // the same temp project root the CLI uses and keeps the bare name.
            if (activeSession.commandsDir) {
              try { rmSync(activeSession.commandsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
              activeSession.commandsDir = null;
            }
            // DELIBERATELY still a provider check, unlike the others in this
            // file. A `commandMount` capability cannot express it: claude
            // needs an added root in the TUI but in-plugin here, so the same
            // provider would need two different values. What varies is the
            // TRANSPORT, not the provider — the SDK cannot read
            // `.claude/commands/` from an added root, and cursor-agent can.
            // A capability that has to lie for one of its two callers is worse
            // than a name check that is honest about being local.
            if (activeSession.provider === "cursor") {
              activeSession.commandsDir = buildActionCommandsDir(commandActions);
              if (activeSession.commandsDir) {
                log.info("actions.commands_mounted", {
                  sessionId: activeSession.id,
                  count: commandActions.length,
                  bare: true,
                });
              }
            } else if (activeSession.skillsPluginDir && commandActions.length > 0) {
              const written = addActionCommandsToPlugin(
                commandActions,
                activeSession.skillsPluginDir,
              );
              if (written > 0) {
                log.info("actions.commands_mounted", { sessionId: activeSession.id, count: written, bare: false });
              }
            }
            if (activeSession.skillsPluginDir) {
              log.info("skills.mounted", { sessionId: activeSession.id, traitSkills: skillNames, pluginDir: activeSession.skillsPluginDir });
            }
          } catch (err) {
            log.warn("skills.load_failed", { sessionId: activeSession.id, error: err instanceof Error ? err.message : String(err) });
          }
        }

        // Resolve the network scope for kernel-level sandbox enforcement. It
        // MUST agree with what the MCP server enforces at the app layer, so it
        // merges the same four sources in the same order (trait ∪ named ∪
        // barry ∪ inline); resolving fewer would silently downgrade a session
        // from kernel enforcement to cooperative guards.
        const sandbox = await resolveEgressSandbox(activeSession, {
          provider: activeSession.provider,
          model: activeSession.model,
          modelProvider: activeSession.modelProvider,
        });

        const model = modelRefFor(activeSession.provider, activeSession.model, activeSession.modelProvider);
        return configureSession({
          sessionId: activeSession.id,
          cwd: activeSession.repoPath,
          // BARRY_PROVIDER/BARRY_SESSION_ID used to be spliced in here for
          // cursor. They are the adapter's to set — it knows its own id, and
          // `sessionId` carries Barry's session id to it.
          env,
          ...(model ? { model } : {}),
          mcpServers: scopedMcpServers,
          maxTurns: 50,
          // Traits grant native tools; the effective bound takes them back.
          deniedTools,
          allowedNativeTools: native.allowed,
          // The text only: each harness takes it in its own form, and one that
          // takes none gets it through the prompt prefix instead.
          ...(activeSession.bagInstructions ? { systemPrompt: activeSession.bagInstructions } : {}),
          ...(activeSession.skillsPluginDir ? { pluginDirs: [activeSession.skillsPluginDir] } : {}),
          // Cursor only — the Claude SDK ignores commands under an added dir
          // (it reads.claude/commands/ from cwd, and only with settingSources
          // "project"), so there those ride inside the plugin instead.
          ...(activeSession.commandsDir ? { projectRoots: [activeSession.commandsDir] } : {}),
          ...(activeSession.sessionId ? { resume: { harnessSessionId: activeSession.sessionId } } : {}),
          // No bag hooks: this runtime persists every streamed message
          // in-process (appendMessage below), so the session bag's tracker
          // hooks would double-write each message through POST
          // /messages/persist, which has no dedupe.
          ...(sandbox ? { egressSandbox: sandbox } : {}),
          // Tool-call gating over the wire: bounds/denied-tools first, followed
          // by interactive external ruling when an app is connected.
          decide: interactive
            ? rt.createDecideFunction(activeSession, deniedTools, Object.keys(scopedMcpServers), native.allowed)
            : (request) => rt.authorizeContinuationTool(activeSession.id, request),
        });
  }

export async function rt_authorizeContinuationTool(rt: SessionRuntime, sessionId: string, request: PermissionRequest): Promise<PermissionDecision> {
    const activeSession = rt.activeSessions.get(sessionId);
    if (!activeSession) return { allow: false, reason: "Session is not prepared" };
    const native = await nativeToolPolicy(activeSession);
    return Object.keys(native.conflicts).length || native.denied.includes(request.tool) || (!native.allowed.includes(request.tool) && !isScopedMcpTool(request.tool, Object.keys(activeSession.mcpServers)))
      ? { allow: false, reason: `${request.tool} is denied by current session bounds` }
      : { allow: true };
  }

  /**
   * The session's hosted harness, created now if nothing has created it yet.
   * Callers share one creation, so a TUI attaching while the first turn starts
   * cannot leave two harnesses running.
   */
export function rt_ensureHarnessSession(rt: SessionRuntime, 
    activeSession: ActiveSession,
    mcpServers: Record<string, McpServerConfig> = activeSession.mcpServers,
    env?: Record<string, string | undefined>,
  ): Promise<Session> {
    if (activeSession.session) return Promise.resolve(activeSession.session);
    activeSession.opening ??= rt.openHarnessSession(activeSession, mcpServers, env).finally(() => {
      activeSession.opening = null;
    });
    return activeSession.opening;
  }

export async function rt_openHarnessSession(rt: SessionRuntime, 
    activeSession: ActiveSession,
    mcpServers: Record<string, McpServerConfig>,
    env?: Record<string, string | undefined>,
  ): Promise<Session> {
    log.info("sdk.session_new", { sessionId: activeSession.id });
    const createSession = rt.createSessionOverride ?? getCreateSession();
    const config = await rt.prepareHarnessConfiguration(activeSession, mcpServers, env);
    const adoptedFrom = activeSession.adoptedFrom;
    const session = await createSession(activeSession.provider, config, adoptedFrom ? { adopt: true } : undefined);
    // Surface adapter warnings alongside Barry’s native grant diagnostics.
    for (const warning of session.warnings ?? []) {
      log.warn("sdk.session_warning", { sessionId: activeSession.id, provider: activeSession.provider, warning });
    }

    activeSession.session = session;
    activeSession.adoptedFrom = null;
    // Metadata, not a failure: a session that ran is more useful than one
    // refused because its mode could not be written. Awaited so a TUI
    // launcher's record of the mode it attached in lands after this one.
    await rt.recordSessionDeclaration(activeSession.id, activeSession.provider, session, adoptedFrom).catch((e) => {
      log.warn("session.mode_declaration_failed", {
        sessionId: activeSession.id,
        error: e instanceof Error ? e.message : String(e),
      });
    });
    return session;
  }
