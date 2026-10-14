// Method bodies extracted from session-runtime.ts for file size.
// Moved verbatim as free functions taking the runtime instance (`rt`);
// the SessionRuntime class delegates to these. Pure move + rewire.
import {SessionRuntime, buildBagAuthGuidance, getBagsNeedingAuth, log, recordBagAuthEvent, tuiModeOf} from "../session-runtime.js";
import type { ActiveSession, SessionConfig } from "../session-runtime.js";
import {getDescribeAdapter, providerFieldId, routeSessionModel} from "../agent-runtime.js";
import {buildSessionHistoryContext, createNamedSession, getSessionRecord, lastMessageSequence, updateSessionMetadata, updateSessionRecord} from "../db.js";
import {AdmissionError, type Reservation} from "../execution-admission.js";
import {getGitBranch, resolveRepoPath} from "../repo-paths.js";
import {nativeToolPolicy, resolveEgressSandbox} from "../session-agent-guards.js";
import {createWorktree} from "../worktree.js";
import {identityRecords, owner} from "@barry-rocks/identities-bag";
import {requestCaller} from "@barry-rocks/sdk";
import {HarnessIdSchema} from "@barry-rocks/sdk/ids";
import {type AuthPrincipal} from "@barry-rocks/sdk/internal/auth";
import {expandCompositionFromSnapshot, loadBagRegistrySnapshot, loadBags, mergeBags} from "@barry-rocks/sdk/internal/bags";
import {FALLBACK_HARNESS, adapterSettings, defaultHarness} from "@barry-rocks/sdk/internal/identities";
import {type Session, declareSession} from "@barry-rocks/sdk/sessions";
import {getProviderSessionsBySession} from "@barry-rocks/sessions-bag/client";
import {endSession as endSessionLifecycle} from "@barry-rocks/sessions-bag/lifecycle";
import {join} from "path";

  /**
   * Record what this session can do, as the session that started reports it.
   *
   * On the session itself (I2): send_prompt and the UI read it there instead
   * of re-deriving from the adapter, which would restate a running session's
   * capabilities whenever the adapter's table changed under it. Read from the
   * `Session` rather than the adapter's declaration so the record is of what
   * actually runs; the installed record supplies only the version the mode was
   * verified on.
   */
export async function rt_recordSessionDeclaration(rt: SessionRuntime, sessionId: string, harness: string, session: Session, adoptedFrom: string | null = null): Promise<void> {
    const mode = getDescribeAdapter()?.(harness)?.modes[session.mode];
    const unverified = mode && session.harnessVersion ? declareSession(mode, session.harnessVersion).guaranteesUnverified : false;
    await updateSessionMetadata(sessionId, {
      mode: session.mode,
      ...(adoptedFrom ? { adopted_from: adoptedFrom } : {}),
      guarantees: { ...session.guarantees },
      ...(session.harnessVersion ? { vendor_version: session.harnessVersion } : {}),
      ...(unverified ? { guarantees_unverified: true } : {}),
    });
  }

export async function rt_startSessionUncoordinated(rt: SessionRuntime, config: SessionConfig, principal?: AuthPrincipal): Promise<ActiveSession> {
    // Reserved SYNCHRONOUSLY, before the first await below. The old check
    // (`getRunningSessionCount() >= maxSessions`) read the map, then ~370
    // lines of awaited work happened before `activeSessions.set(...)` ever
    // ran — so N concurrent startSession calls could all read the same
    // under-capacity count and all pass. A synchronous reservation cannot
    // be raced the same way: JS has no preemption inside this call, so only
    // as many callers as there is real capacity can successfully reserve.
    const reservation = await rt.reserveResidentSession();

    let sessionId: string = config.sessionId ?? "";
    let dbSession;
    const createdNew = !config.sessionId;
    let activeInserted = false;

    try {
      if (sessionId) {
        dbSession = await getSessionRecord(sessionId);
        if (!dbSession) {
          throw new Error(`Session ${sessionId} not found`);
        }
      }

      const persistedBarryId = dbSession?.identity_id ?? null;
      const requestedBarryId = config.identityId !== undefined ? config.identityId : persistedBarryId;
      const user = principal ? await owner.users.get(principal.actorId) : dbSession?.user_id != null
        ? await owner.users.get(dbSession.user_id)
        : await owner.current();
      if (!user) throw new Error("No Barry user is configured");
      const selection = await identityRecords.resolve(
        { id: requestedBarryId, repoPath: config.repoPath },
        principal ? requestCaller(principal) : { kind: "owner", actorId: user.id },
      );
      // NOT `selection.barry.id`. A file-based Barry's id is a NAME HASH with
      // no `identities` row, and nothing in the schema refuses it: written
      // raw, the session quietly loses its traits, bags and credentials,
      // because every reader of `sessions.identity_id` finds no row.
      // `identityRecords.rowId` syncs the cache row and returns an id that has
      // one, which is what every other writer of this column already does
      // (POST /sessions/draft, POST /actions/trigger).
      const effectiveBarryId =
        (await identityRecords.rowId(selection.barry, { actorId: user.id })) ?? undefined;
      const persistedBarrySource = dbSession?.metadata?.barry_source as string | undefined;
      const identitySource = persistedBarryId
        && persistedBarrySource
        && (config.identityId === undefined || config.identityId === persistedBarryId)
        ? persistedBarrySource
        : selection.source;

      if (!sessionId) {
        dbSession = await createNamedSession({
          user_id: user.id,
          system_prompt: config.prompt,
          traits: config.traits,
          bound: config.scope,
          bounds: config.bounds,
          identity_id: effectiveBarryId,
          metadata: {
            source: "barry-works",
            working_directory: config.repoPath,
            name: config.name || undefined,
            barry_source: identitySource,
            ...config.metadata,
          },
        });
        sessionId = dbSession.id;
      } else if (dbSession && (dbSession.identity_id !== effectiveBarryId || dbSession.metadata?.barry_source !== identitySource)) {
        await updateSessionRecord(sessionId, {
          identity_id: effectiveBarryId,
          metadata: { ...dbSession.metadata, barry_source: identitySource },
        });
        dbSession = (await getSessionRecord(sessionId))!;
      }
      if (!dbSession) throw new Error(`Session ${sessionId} could not be loaded`);

      // Provision worktree if requested
      let effectiveRepoPath = config.repoPath;
      const useWorktree = config.useWorktree || !!(dbSession.metadata?.use_worktree);
      const baseRepoPath = resolveRepoPath(config.repoPath);

      if (useWorktree && !dbSession.metadata?.worktree_path) {
        try {
          const worktreePath = await createWorktree(baseRepoPath, sessionId);
          effectiveRepoPath = worktreePath;
          log.info("worktree.provisioned", { sessionId, worktreePath });
          // Update metadata with worktree info before starting
          await updateSessionRecord(sessionId, {
            metadata: {
              ...dbSession.metadata,
              use_worktree: true,
              worktree_path: worktreePath,
              base_repo_path: baseRepoPath,
              working_directory: worktreePath,
              worktree_status: "active",
            },
          });
          // Refresh dbSession after metadata update
          dbSession = (await getSessionRecord(sessionId))!;
        } catch (err) {
          log.error("worktree.provision_failed", { sessionId, error: err instanceof Error ? err.message : String(err) });
          throw new Error(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (useWorktree && dbSession.metadata?.worktree_path) {
        // Already has worktree from previous run
        effectiveRepoPath = dbSession.metadata.worktree_path as string;
      }

      const updates: Record<string, unknown> = { status: "running", active: true, state: "open", ended_at: null };
      if (!dbSession.started_at) {
        updates.started_at = new Date();
      }
      // Ensure working_directory and git_branch are set in metadata
      const repoForBranch = effectiveRepoPath || config.repoPath;
      if (repoForBranch) {
        const currentMeta = (updates.metadata as Record<string, unknown>) ?? { ...dbSession.metadata };
        if (effectiveRepoPath && dbSession.metadata?.working_directory !== effectiveRepoPath) {
          currentMeta.working_directory = effectiveRepoPath;
        }
        const branch = await getGitBranch(repoForBranch);
        if (branch) {
          currentMeta.git_branch = branch;
        }
        updates.metadata = currentMeta;
      }
      // Resolve barry (name, bags, defaults) BEFORE persisting so the
      // resolved model/provider land in the session metadata in the same write.
      // Read from the selected record rather than re-fetching by id: a
      // file-based Barry's id is synthetic and matches no row.
      // `?? null` because the DB writers above take `undefined` for "unset"
      // while ActiveSession types this field as nullable.
      const identityId = effectiveBarryId ?? null;
      const barryConfig = identityRecords.config(selection.barry);
      const adapters = barryConfig.adapters ?? {};
      const identityName: string | null = selection.barry.name;
      const barryBags: string[] = barryConfig.bags;
      const workflowScoped = config.metadata?.workflow_scope !== undefined || dbSession?.metadata?.workflow_scope !== undefined;

      // An explicit provider wins; otherwise the identity selects the harness.
      const providerParse = HarnessIdSchema.safeParse(
        config.provider || defaultHarness(adapters) || FALLBACK_HARNESS,
      );
      if (!providerParse.success) {
        throw new Error(`Unknown provider: "${config.provider || defaultHarness(adapters)}"`);
      }
      // Stored and reported in the spelling rows already carry: "claude-code"
      // and "claude" are one harness, and a row must not say it two ways.
      const effectiveProvider = providerFieldId(providerParse.data);
      // `HarnessIdSchema` validates SHAPE, not membership. Membership is an
      // installed adapter: refused here, before a worktree or a vault login
      // exists, rather than as a failed turn several layers later.
      const describeAdapter = getDescribeAdapter();
      if (describeAdapter && !describeAdapter(effectiveProvider)) {
        throw new Error(
          `No adapter is installed for "${effectiveProvider}". \`barry adapter list\` shows the ones that are.`,
        );
      }
      // Refuses a model the harness cannot reach, here — before a worktree, a
      // vault login or a provider session exists. The alternative is a request
      // in an API nobody on the other end speaks, which comes back as an opaque
      // vendor error several layers from the model choice that caused it.
      const { model: effectiveModel, vendor: effectiveModelProvider } = routeSessionModel(effectiveProvider, {
        ...(config.model ? { model: config.model } : {}),
        ...(config.modelProvider ? { vendor: config.modelProvider } : {}),
        identity: { model: adapterSettings(adapters, describeAdapter?.(effectiveProvider) ?? { id: effectiveProvider })?.model },
      });

      let resumeProviderSessionId: string | null = null;
      if (config.sessionId) {
        const providerSessions = await getProviderSessionsBySession(config.sessionId);
        resumeProviderSessionId = providerSessions.find(
          (ps) => ps.provider === effectiveProvider && ps.provider_session_id,
        )?.provider_session_id ?? null;
      }

      // Persist the resolved model/provider so the UI can show what a session ran on
      {
        const metaForRun = (updates.metadata as Record<string, unknown>) ?? { ...dbSession.metadata };
        metaForRun.provider = effectiveProvider;
        if (effectiveModel) metaForRun.model = effectiveModel;
        // Recorded so a restart or resume returns to the same endpoint: a custom
        // Ollama id cannot be re-inferred from the catalog.
        if (effectiveModelProvider) metaForRun.model_provider = effectiveModelProvider;
        updates.metadata = metaForRun;
      }
      await updateSessionRecord(sessionId, updates);
      // Resolve persisted policy before loading tools, resolving secrets or
      // opening a harness. A sandbox requirement cannot become guard-only.
      await resolveEgressSandbox(
        { id: sessionId, provider: effectiveProvider, workflowScoped },
        { provider: effectiveProvider, model: effectiveModel, modelProvider: effectiveModelProvider },
      );

      const mcpServers = config.mcpServers || {};
      let bagInstructions: string | undefined;
      let pendingActionsIndex: string | undefined;
      let pendingInstructionsIndex: string | undefined;
      let pendingAlwaysInstructions: string | undefined;
      let pendingBagNames: string[] = [];
      let bagSkillsDirs: string[] = [];

      // Load and merge bags from barry.
      //
      // No ALWAYS_ON_BAGS injection here, unlike the CLI (cli/src/commands/
      // start.ts). That is deliberate, and narrower than it looks:
      //   - TOOLS are unaffected. Both paths gate on `resolveSessionBound`,
      //     whose DEFAULT_TRAITS already grant sessions/changes/system/events/
      //     actions/instructions. A server session gets those tools whether or
      //     not its identity lists the bags.
      //   - HOOKS are deliberately excluded: session-runtime persists every
      //     streamed message in-process, so the session bag's trackers would
      //     double-write each message through POST /messages/persist, which
      //     has no dedupe.
      // What an identity omitting them DOES lose is bag prose and assets:
      // skills (`wrap-up`, the system trio), instructions, and actions dirs.
      // Inject here only if that content is wanted server-side; it is not a
      // tool-access gap.
      if (barryBags.length > 0) {
        try {
          // Composition is resolved HERE rather than read from the stored list:
          // a bag's manifest `bags:` children must reach the session even when
          // only the parent is packed, and a manifest edit should take effect
          // on the next session rather than waiting for a re-pack.
          const loadNames = await expandCompositionFromSnapshot(barryBags);
          const bags = await loadBags(loadNames);
          const skipped = loadNames.filter(n => !bags.some(p => p.name === n));
          if (skipped.length > 0) {
            log.warn("bags.skipped", { sessionId, skipped });
          }
          if (bags.length > 0) {
            const bagConfig = mergeBags(bags);
            // Keep skills dirs so the spawn path can mount them as a Claude
            // Code plugin (alongside trait-granted skills).
            bagSkillsDirs = bagConfig.skillsDirs;
            // Bag MCP servers are deliberately NOT added to the session here.
            // The engine proxies every server a bag declares and filters it by
            // the session's grant; a direct entry skips that filter, and since
            // this list is PACKED bags, it handed ungranted bags to the agent.
            const instructionSections: string[] = [];
            const sessionBagNamesForProse = bags.map((p) => p.name);
            // Kept on the session so the per-turn slash-command scoping below
            // can union these with whatever traits grant on that turn.
            pendingBagNames = sessionBagNamesForProse;

            // Resolve this session's instructions. Two sources: the enabled
            // bags, then the active identity's own instructions dir, which
            // wins a name collision — a user overriding a bag author's
            // guidance is the point of having a personal channel.
            //
            // Best-effort throughout: prose must never stop a session starting.
            try {
              const { listAllInstructions, joinAlwaysInstructions, buildInstructionsIndex } =
                await import("@barry-rocks/sdk/internal/instructions");

              const identityDirs: string[] = [];
              if (identityId) {
                const identityDir = identityRecords.directory({ id: identityId });
                if (identityDir) identityDirs.push(join(identityDir, "instructions"));
              }

              const instructions = await listAllInstructions((await loadBagRegistrySnapshot()).bags, {
                bagNames: sessionBagNamesForProse,
                identityDirs,
              });

              // Always-on bodies, under one shared ceiling. Previously each
              // bag's `instructions:` was concatenated with no bound on the
              // sum, so standing cost grew with every bag a barry enabled.
              const always = joinAlwaysInstructions(instructions);
              if (always) instructionSections.push(always);

              // On-demand entries cost only their description until fetched.
              const index = buildInstructionsIndex(instructions);
              if (index) {
                instructionSections.push(index);
                pendingInstructionsIndex = index;
              }
              pendingAlwaysInstructions = always ?? undefined;
            } catch (err) {
              log.warn("instructions.resolve_failed", { sessionId, error: err instanceof Error ? err.message : String(err) });
            }

            // Index the actions available to this session. Best-effort: a
            // broken action must not stop a session from starting.
            try {
              const { listAllActions, buildActionsIndex } = await import("@barry-rocks/sdk/internal/actions");
              const sessionActions = await listAllActions((await loadBagRegistrySnapshot()).bags, { bagNames: sessionBagNamesForProse });
              const actionsIndex = buildActionsIndex(sessionActions);
              if (actionsIndex) {
                instructionSections.push(actionsIndex);
                // Kept for harnesses requiring the prompt-prefix fallback.
                pendingActionsIndex = actionsIndex;
              }
            } catch (err) {
              log.warn("actions.index_failed", { sessionId, error: err instanceof Error ? err.message : String(err) });
            }

            // Loaded bags may contribute computed prompt sections. The
            // contributor host isolates failures from session startup.
            try {
              const { collectPromptSections } = await import("@barry-rocks/sdk/internal/instructions");
              const memoryCwd = effectiveRepoPath || (await import("node:os")).homedir();
              const sections = await collectPromptSections(bags, {
                cwd: memoryCwd,
                repo: effectiveRepoPath,
                sessionId,
                provider: effectiveProvider,
              });
              if (sections.length) instructionSections.push(sections.join("\n\n"));
            } catch (err) {
              log.warn("bags.prompts_failed", { sessionId, error: err instanceof Error ? err.message : String(err) });
            }

            // Bags this session actually wants that aren't authorized.
            // Scoped by the session's granted bags via /bag-status?sessionId=.
            // If scoped, only report bags the session can reach.
            // Sessions without traits do not fallback to all packed bags.
            const authStatus = await getBagsNeedingAuth(sessionId);
            let relevant: string[] = [];
            if (authStatus.scoped) {
              relevant = authStatus.bags;
            } else {
              log.warn("bag_auth.scope_unresolved", { sessionId });
            }

            if (relevant.length > 0) {
              // Guidance tells the agent what to do; the event tells the user.
              instructionSections.push(buildBagAuthGuidance(relevant));
              void recordBagAuthEvent(sessionId, relevant);
            }

            if (instructionSections.length > 0) {
              bagInstructions = instructionSections.join("\n\n");
            }
            log.info("bags.loaded", { sessionId, bags: bags.map(p => p.name), hasInstructions: Boolean(bagInstructions) });
          }
        } catch (err) {
          log.warn("bags.load_failed", { sessionId, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const activeSession: ActiveSession = {
        id: sessionId,
        sessionId: resumeProviderSessionId,
        prompt: config.prompt,
        repoPath: effectiveRepoPath,
        name: config.name || config.prompt.slice(0, 50) || sessionId.slice(0, 8),
        status: "starting",
        subscribers: new Set(),
        session: null,
        opening: null,
        renderers: new Map(),
        toolsChangedWhileAttached: false,
        adoptedFrom: resumeProviderSessionId ? tuiModeOf(dbSession?.metadata) : null,
        abortController: null,
        interruptedTurn: null,
        outputBuffer: "",
        lastSequence: -1,
        mcpServers,
        createdAt: new Date(),
        unlisted: !!config.metadata?.unlisted,
        identityId,
        identityName,
        // Fall back to the DB row's traits so restarted sessions (message-start
        // path passes no traits) keep their trait-granted tools and skills.
        traits: config.traits ?? dbSession?.traits ?? [],
        consecutiveFailures: 0,
        provider: effectiveProvider,
        model: effectiveModel,
        ...(effectiveModelProvider ? { modelProvider: effectiveModelProvider } : {}),
        bagInstructions,
        actionsIndex: pendingActionsIndex,
        instructionsIndex: pendingInstructionsIndex,
        alwaysInstructions: pendingAlwaysInstructions,
        bagSkillsDirs,
        bagNames: pendingBagNames,
        skillsPluginDir: null,
        commandsDir: null,
        workflowScoped,
        turnQueue: Promise.resolve(),
        lastTurn: null,
        pendingTurns: 0,
        generation: 0,
        interruptGeneration: 0,
      };

      // Validate restrictions before admitting a resident session or acknowledging
      // startup. The per-turn check remains necessary when policy changes later.
      const native = await nativeToolPolicy(activeSession);
      if (Object.keys(native.conflicts).length) throw new Error(`session bounds cannot take back ${Object.keys(native.conflicts).join(", ")} on ${activeSession.provider} (hosted): ${[...new Set(Object.values(native.conflicts))].join("; ")}`);
      for (const [tool, reason] of Object.entries(native.refused)) log.warn("sdk.session_warning", { sessionId, warning: `${tool} refused: ${reason}` });
      if (Object.keys(native.uncontrolled).length) log.warn("sdk.session_warning", { sessionId, warning: `${activeSession.provider} (hosted) cannot turn off ${Object.keys(native.uncontrolled).join(", ")}`, reasons: native.uncontrolled });
      if ("operatorOverride" in native && native.operatorOverride) log.warn("sdk.session_warning", { sessionId, warning: native.operatorOverride });
      rt.activeSessions.set(sessionId, activeSession);
      activeInserted = true;
      rt.residentBudget.commit(reservation, sessionId);

      // Max, not assignment: a message broadcast while this read was in
      // flight has already raised it past what the read saw.
      activeSession.lastSequence = Math.max(activeSession.lastSequence, await lastMessageSequence(sessionId));

      if (config.prepareOnly) return activeSession;

      let initialPrompt = config.prompt;

      // For existing sessions being restarted (cold start), prepend their history
      if (config.sessionId && dbSession) {
        const historyContext = await buildSessionHistoryContext(config.sessionId);
        if (historyContext) {
          initialPrompt = `${historyContext}\n<new-message>\n${config.prompt}\n</new-message>`;
        }
      } else if (config.continueFromSessionId) {
        // Continuing from a different session — use that session's history
        const historyContext = await buildSessionHistoryContext(config.continueFromSessionId);
        if (historyContext) {
          initialPrompt = `${historyContext}\n<new-message>\n${config.prompt}\n</new-message>`;
        }
      }

      // Record the accepted user turn, exactly as the warm `sendMessage` path
      // does. Without this, a message that starts a draft/stopped/absent
      // session went straight into the provider prompt and left no
      // user-message row: the request was missing from transcript history,
      // from message search, and from the DB-built continuation context that
      // the NEXT cold start reads — so the agent's own first instruction
      // vanished from its history.
      //
      // Emitted AFTER buildSessionHistoryContext above, so the turn being
      // started cannot appear in the history prepended to itself.
      rt.broadcastToSession(sessionId, {
        type: "text",
        sessionId,
        content: config.prompt,
        role: "user",
        metadata: {
          source: "api_message",
          delivery: "accepted",
          ...(config.clientMessageId ? { clientMessageId: config.clientMessageId } : {}),
        },
        reuseClientMessageRow: config.reuseClientMessageRow,
      });

      log.info("session.start", {
        sessionId,
        repoPath: effectiveRepoPath,
        provider: effectiveProvider,
        model: effectiveModel,
        modelProvider: effectiveModelProvider,
        identityId: activeSession.identityId,
        identityName: activeSession.identityName,
        useWorktree,
        hasContinuation: !!config.continueFromSessionId,
      });

      void rt.runSession(activeSession, initialPrompt, mcpServers);

      return activeSession;
    } catch (err) {
      // Covers both cases with one call: `release` checks the pending set
      // AND the committed map, so it is correct whether this failure
      // happened before or after `residentBudget.commit()` above.
      rt.residentBudget.release(reservation);
      if (activeInserted && sessionId) {
        rt.activeSessions.delete(sessionId);
      }
      if (sessionId) {
        await (async () => {
          await endSessionLifecycle({ session_id: sessionId, reason: "start-failed" });
          await updateSessionRecord(sessionId, { status: "failed" });
        })().catch((updateErr) => {
          log.warn("session.start_failure_status_update_failed", {
            sessionId,
            error: updateErr instanceof Error ? updateErr.message : String(updateErr),
          });
        });
      }
      if (createdNew && sessionId) {
        log.error("session.start_setup_failed", { sessionId, error: err instanceof Error ? err.message : String(err) });
      }
      throw err;
    }
  }

export async function rt_reserveResidentSession(rt: SessionRuntime): Promise<Reservation> {
    const previous = rt.admissionChain;
    let unlock!: () => void;
    rt.admissionChain = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try {
      try {
        return rt.residentBudget.reserve();
      } catch (error) {
        if (!(error instanceof AdmissionError) || error.code !== "resident_budget") throw error;
      }

      // Resting sessions can be resumed from persisted history. Close the
      // oldest one to make room while keeping active turns untouched.
      const idle = [...rt.activeSessions.values()]
        .filter((session) => session.status === "waiting" && !session.abortController && session.pendingTurns === 0 && session.renderers.size === 0)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      if (!idle) return rt.residentBudget.reserve();
      await rt.stopSession(idle.id, undefined, "evicted");
      return rt.residentBudget.reserve();
    } finally {
      unlock();
    }
  }
