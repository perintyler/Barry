import { ensureBarry, ensureBarryCore } from "./lib/barry-init.js";
export { ensureBarry } from "./lib/barry-init.js";
import { setKnownCommands, checkKnownCommand } from "./commands/known-commands.js";
import { lazy } from "./lib/lazy.js";
import { mark, span } from "./lib/timing.js";
import { isCliError } from "./lib/cli-error.js";
import { registerWork } from "./commands/work.js";
import { registerWorkers } from "./commands/workers.js";
import { registerDevices } from "./commands/device.js";
import { registerOwner } from "./commands/owner.js";
import { useInstanceSecret } from "./config.js";
const ensureModelsInstalled = lazy(() => import("./lib/models-install.js"), module => module.ensureModelsInstalled);
import { program } from "commander";
import { applyCommandTarget, currentTarget } from "./target.js";
import { addHarnessFlags, flaggedHarness, installedHarnesses } from "./lib/harness-flags.js";
const startCommand = lazy(() => import("./commands/start.js"), module => module.startCommand);
import { makeGroupedHelpFormatter } from "./help-format.js";
import { registerReservedName } from "./reserved-names.js";
import { RESERVED_NAMES } from "./command-registry.js";
const resumeCommand = lazy(() => import("./commands/resume.js"), module => module.resumeCommand);
const listCommand = lazy(() => import("./commands/list.js"), module => module.listCommand);
import type { PromptCommandOptions } from "./commands/prompt.js";
const boundListCommand = lazy(() => import("./commands/bound.js"), module => module.boundListCommand);
import type { IdentityAdapterOptions, IdentityBoundSetOptions } from "./commands/identity.js";
const listIdentitiesCommand = lazy(() => import("./commands/identity.js"), module => module.listIdentitiesCommand);
const showIdentityCommand = lazy(() => import("./commands/identity.js"), module => module.showIdentityCommand);
const testIdentityCommand = lazy(() => import("./commands/identity.js"), module => module.testIdentityCommand);
const checkIdentityCommand = lazy(() => import("./commands/identity.js"), module => module.checkIdentityCommand);
const deleteIdentityCommand = lazy(() => import("./commands/identity.js"), module => module.deleteIdentityCommand);
const barryDoctorCommand = lazy(() => import("./commands/identity.js"), module => module.barryDoctorCommand);
const setIdentityAdapterCommand = lazy(() => import("./commands/identity.js"), module => module.setIdentityAdapterCommand);
const removeIdentityAdapterCommand = lazy(() => import("./commands/identity.js"), module => module.removeIdentityAdapterCommand);
const identityBagsCommand = lazy(() => import("./commands/identity.js"), module => module.identityBagsCommand);
const addIdentityBagsCommand = lazy(() => import("./commands/identity.js"), module => module.addIdentityBagsCommand);
const removeIdentityBagsCommand = lazy(() => import("./commands/identity.js"), module => module.removeIdentityBagsCommand);
const identityBoundsCommand = lazy(() => import("./commands/identity.js"), module => module.identityBoundsCommand);
const addIdentityBoundsCommand = lazy(() => import("./commands/identity.js"), module => module.addIdentityBoundsCommand);
const setIdentityBoundCommand = lazy(() => import("./commands/identity.js"), module => module.setIdentityBoundCommand);
const removeIdentityBoundsCommand = lazy(() => import("./commands/identity.js"), module => module.removeIdentityBoundsCommand);
const clearIdentityBoundsCommand = lazy(() => import("./commands/identity.js"), module => module.clearIdentityBoundsCommand);
const setIdentityNotifierCommand = lazy(() => import("./commands/identity.js"), module => module.setIdentityNotifierCommand);
const clearIdentityNotifierCommand = lazy(() => import("./commands/identity.js"), module => module.clearIdentityNotifierCommand);
const setIdentityGitHubInstallationCommand = lazy(() => import("./commands/identity.js"), module => module.setIdentityGitHubInstallationCommand);
const clearIdentityGitHubInstallationCommand = lazy(() => import("./commands/identity.js"), module => module.clearIdentityGitHubInstallationCommand);
const identitySecretSetCommand = lazy(() => import("./commands/identity-secrets.js"), module => module.identitySecretSetCommand);
const identitySecretGetCommand = lazy(() => import("./commands/identity-secrets.js"), module => module.identitySecretGetCommand);
const identitySecretListCommand = lazy(() => import("./commands/identity-secrets.js"), module => module.identitySecretListCommand);
const identitySecretImportCommand = lazy(() => import("./commands/identity-secrets.js"), module => module.identitySecretImportCommand);
const identitySecretRemoveCommand = lazy(() => import("./commands/identity-secrets.js"), module => module.identitySecretRemoveCommand);
const iosBuildCommand = lazy(() => import("./commands/ios.js"), module => module.iosBuildCommand);
const sessionListCommand = lazy(() => import("./commands/session.js"), module => module.sessionListCommand);
const sessionArchiveCommand = lazy(() => import("./commands/session.js"), module => module.sessionArchiveCommand);
const configCommand = lazy(() => import("./commands/config.js"), module => module.configCommand);
const configExportCommand = lazy(() => import("./commands/config-export.js"), module => module.configExportCommand);
const configImportCommand = lazy(() => import("./commands/config-export.js"), module => module.configImportCommand);
const configInitCommand = lazy(() => import("./commands/config-export.js"), module => module.configInitCommand);
const trashCommand = lazy(() => import("./commands/trash.js"), module => module.trashCommand);
const trashListCommand = lazy(() => import("./commands/trash.js"), module => module.trashListCommand);
const trashRestoreCommand = lazy(() => import("./commands/trash.js"), module => module.trashRestoreCommand);
const trashEmptyCommand = lazy(() => import("./commands/trash.js"), module => module.trashEmptyCommand);
const archiveCommand = lazy(() => import("./commands/archive.js"), module => module.archiveCommand);
const archiveListCommand = lazy(() => import("./commands/archive.js"), module => module.archiveListCommand);
const cursorSetupCommand = lazy(() => import("./commands/cursor.js"), module => module.cursorSetupCommand);
const mcpEnableCommand = lazy(() => import("./commands/mcp-agent.js"), module => module.mcpEnableCommand);
const mcpDisableCommand = lazy(() => import("./commands/mcp-agent.js"), module => module.mcpDisableCommand);
const completionCommand = lazy(() => import("./commands/completion.js"), module => module.completionCommand);
const completeCommand = lazy(() => import("./commands/completion.js"), module => module.completeCommand);
import { registerBagGroups } from "./bag-registration.js";
import { getRegistrySnapshotPath } from "@barry-rocks/sdk/internal/bags";
import { existsSync } from "node:fs";
const bagListCommand = lazy(() => import("./commands/bag.js"), module => module.bagListCommand);
const bagShowCommand = lazy(() => import("./commands/bag.js"), module => module.bagShowCommand);
const bagAccessCommand = lazy(() => import("./commands/bag.js"), module => module.bagAccessCommand);
const bagDoctorCommand = lazy(() => import("./commands/bag.js"), module => module.bagDoctorCommand);
const bagCreateCommand = lazy(() => import("./commands/bag.js"), module => module.bagCreateCommand);
const newCommand = lazy(() => import("./commands/bag.js"), module => module.newCommand);
const bagBuildCommand = lazy(() => import("./commands/bag.js"), module => module.bagBuildCommand);
const bagInfraCommand = lazy(() => import("./commands/bag.js"), module => module.bagInfraCommand);
const bagServeCommand = lazy(() => import("./commands/bag.js"), module => module.bagServeCommand);
const bagAuthCommand = lazy(() => import("./commands/bag.js"), module => module.bagAuthCommand);
const bagPublishSdkCommand = lazy(() => import("./commands/bag.js"), module => module.bagPublishSdkCommand);
const bagInstallCommand = lazy(() => import("./commands/bag.js"), module => module.bagInstallCommand);
const identityInstallCommand = lazy(() => import("./commands/bag.js"), module => module.identityInstallCommand);
const bagPackCommand = lazy(() => import("./commands/bag.js"), module => module.bagPackCommand);
const bagUnpackCommand = lazy(() => import("./commands/bag.js"), module => module.bagUnpackCommand);
const bagCheckCommand = lazy(() => import("./commands/bag-check.js"), module => module.bagCheckCommand);
const vaultAddCommand = lazy(() => import("./commands/vault.js"), module => module.vaultAddCommand);
const vaultAssignCommand = lazy(() => import("./commands/vault.js"), module => module.vaultAssignCommand);
const vaultListCommand = lazy(() => import("./commands/vault.js"), module => module.vaultListCommand);
const vaultGetCommand = lazy(() => import("./commands/vault.js"), module => module.vaultGetCommand);
const vaultStatusCommand = lazy(() => import("./commands/vault.js"), module => module.vaultStatusCommand);
const vaultRemoveCommand = lazy(() => import("./commands/vault.js"), module => module.vaultRemoveCommand);
const vaultProvisionCommand = lazy(() => import("./commands/vault.js"), module => module.vaultProvisionCommand);
const vaultExportCommand = lazy(() => import("./commands/vault.js"), module => module.vaultExportCommand);
const vaultImportCommand = lazy(() => import("./commands/vault.js"), module => module.vaultImportCommand);
const vaultRestoreCommand = lazy(() => import("./commands/vault-restore.js"), module => module.vaultRestoreCommand);
const notifyCommand = lazy(() => import("./commands/notify.js"), module => module.notifyCommand);
import { errorMessage } from "./lib/error-message.js";
import { registerInstanceCommands } from "./instance-commands.js";
const eventsListCommand = lazy(() => import("@barry-rocks/events-bag"), module => module.eventsListCommand);
const eventsReadCommand = lazy(() => import("@barry-rocks/events-bag"), module => module.eventsReadCommand);
const eventsCountCommand = lazy(() => import("@barry-rocks/events-bag"), module => module.eventsCountCommand);
const eventsEmitCommand = lazy(() => import("@barry-rocks/events-bag"), module => module.eventsEmitCommand);
const actionStopCommand = lazy(() => import("./commands/action-stop.js"), module => module.actionStopCommand);
const actionWorkStartCommand = lazy(() => import("./commands/action-work.js"), module => module.actionWorkStartCommand);
const actionWorkLookupCommand = lazy(() => import("./commands/action-work.js"), module => module.actionWorkLookupCommand);
const actionShowCommand = lazy(() => import("./commands/action.js"), module => module.actionShowCommand);
const actionRunsCommand = lazy(() => import("./commands/action.js"), module => module.actionRunsCommand);
const actionRunCommand = lazy(() => import("./commands/action.js"), module => module.actionRunCommand);
const scheduleListCommand = lazy(() => import("./commands/schedule.js"), module => module.scheduleListCommand);
const scheduleShowCommand = lazy(() => import("./commands/schedule.js"), module => module.scheduleShowCommand);
const scheduleRunCommand = lazy(() => import("./commands/schedule.js"), module => module.scheduleRunCommand);
const schedulePauseCommand = lazy(() => import("./commands/schedule.js"), module => module.schedulePauseCommand);
const scheduleLogsCommand = lazy(() => import("./commands/schedule.js"), module => module.scheduleLogsCommand);
const scheduleCancelCommand = lazy(() => import("./commands/schedule.js"), module => module.scheduleCancelCommand);
const heirCommand = lazy(() => import("./commands/heir.js"), module => module.heirCommand);
const identityCreateCommand = lazy(() => import("./commands/identity-create.js"), module => module.identityCreateCommand);
const useCommand = lazy(() => import("./commands/use.js"), module => module.useCommand);
const aliasCommand = lazy(() => import("./commands/alias.js"), module => module.aliasCommand);
import { barryVersion } from "./releases/release.js";
const dispatchBagTool = lazy(() => import("./bag-cli.js"), module => module.dispatchBagTool);
const redmarkCommand = lazy(() => import("./commands/redmark.js"), module => module.redmarkCommand);

// This process hosts the identities, sessions, actions, events, schedules, tracker and mcp bags: `Barry`'s questions
// about them run in-process here, for every command and both entries (`barry`
// and an identity's own command) that come through this module.
mark("main:imports-done");




// The instance's credential first: every command that calls Barry needs it.


// This process runs bag tools in-process and probes local models before a
// launch; both reach models through this one install. What it installs is
// named here because naming it is this root's job: the shipped model list is
// registered bags' models and this tree's call code, and installed adapters'
// vendor code rides on top, loaded from their records.

async function initializeModels(): Promise<void> {
  await ensureModelsInstalled();
}



const target = currentTarget();

const harnessRecords = target.kind === "identity" ? await span("main:harnesses", () => installedHarnesses()) : [];






// NOT eagerly imported — prompt.js pulls in sdk.js, which
// loads harness adapters to run a session. Lazy, so --version and --help never
// load an adapter.


































program
  .name("barry")
  .description("Barry - personal AI coding agent CLI")
  .option("-V, --version", "output the version number");

// `-i, --identity` is the one identity selector. It is hidden in an identity's
// own generated CLI, where the identity is already fixed and naming another is
// refused in the preAction hook below.
{
  const { Option } = await import("commander");
  const identityOption = new Option("-i, --identity <identity>", "The identity to act as");
  if (target.kind === "identity") identityOption.hideHelp();
  program.addOption(identityOption);
}

// Checkout versions cost a git call; compute it only when asked, since identity commands start here too.
program.on("option:version", () => { console.log(barryVersion()); process.exit(0); });

registerWorkers(program);
registerWork(program);
registerDevices(program);
registerOwner(program);

// Groups the ROOT listing into named sections (Working / Your setup /
// Capabilities / This machine / Files / From your bags) read from
// command-registry.ts. Every other command's `--help` — `barry db --help`,
// `barry session start --help`, a bag group's own renderer — is untouched:
// the formatter delegates to Commander's real default for anything that
// isn't this exact `program` instance. No command's spelling changes; this
// only changes how the root listing renders.
program.configureHelp({ formatHelp: makeGroupedHelpFormatter(program) });

// Bare `barry` runs `session start` (both are `isDefault`), but Commander only
// lists the ROOT command's own options here — so every flag that shapes a
// session (--bag, --bound, --all, --show-builtin, --read, --none …) is invisible at
// the top level, and the options block reads as if `barry` takes none.
// Duplicating them onto the root would drift; pointing at the real command
// does not, and covers flags added later without touching this line.
if (target.kind === "identity") {
  program.addHelpText(
    "after",
    "\nStarting a session:\n  `barry` runs `barry session start`. See `barry session start --help`\n  for its options (--bag, --bound, --all, --show-builtin, --read, --none, ...).\n",
  );
} else {
  program.addHelpText(
    "after",
    "\nIdentity Personas:\n  Barry operates through identity personas. Run sessions under an identity:\n    <identity> session start       (e.g. `bux session start`)\n    barry --identity <name> ...    (explicit identity bridge)\n  Run `barry identity list` to see installed identities.\n",
  );
}

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ PUBLISHABLE COMMANDS — these ship in @barry-rocks/cli                      ║
// ║ Works on any machine with a Barry installation. No monorepo, no launchd.   ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

const session = program
  .command("session", { isDefault: true })
  .description("Manage sessions");

const start = session
  .command("start", { isDefault: true })
  .description("Start a session with Barry configuration. Harness flags come from installed adapters (`barry adapter list`)")
  .allowUnknownOption()
  .option("-b, --bag <bags>", "Comma-separated bag names to enable (supports <bag>:read)")
  .option("--bags <bags>", "Comma-separated bag names to enable (supports <bag>:read)")
  .option("--last", "Use remembered bags and bounds for this identity and harness, skipping the picker")
  .option("--bound <bounds>", "Named bound restricting the session (see `barry bound list`)")
  .option("--bounds <bounds>", "Comma-separated named bounds restricting the session (see `barry bound list`)")
  .option("--all", "Grant every packed bag's tools (skips capability selection)")
  .option("--show-builtin", "Show builtin bags in the overview and capability picker (hidden by default — they are always granted)")
  .option("-r, --read", "Read-only: --all under the readonly bound")
  .option("--relax", "Allow user-level MCP servers to merge in (default: strict, only Barry-configured MCPs)")
  .option("-d, --directive [directive]", "Set or prompt for a session directive")
  .option("-n, --none", "Skip capability/directive selection (identity bags still grant their tools)")
  .option("-t, --transport <mode>", "Transport mode: http (default, instant) or stdio (debugging)", "http")
  .option("--health-check", "Check MCP server health during startup (adds delay)")
  .option("--no-api-restart", "Do not restart an older sessions API during launch")
  .option("--rebuild-bags", "Check and rebuild stale bag bundles during this launch")
  .option("--zai", "Use z.ai (GLM) as the model vendor")
  .option("--ollama", "Use a local Ollama model as the model vendor")
  .option("--llamacpp", "Use a local llama.cpp model as the model vendor")
  .option("--model-provider <key>", "Select a model endpoint explicitly (for example, ollama)")
  .option(
    "--mode <mode>",
    "How Barry attaches: hosted, instrumented (was guest-plus), or guest. Defaults to the identity's adapters.<harness>.mode, then the adapter's own default",
  )
  .option("-p, --prompt <prompt>", "Initial prompt to send when the session starts")
  .option("-m, --model <model>", "Model to use (overrides the identity's adapters.<harness>.model)")
  .option("-N, --session-name <name>", "Name the session (skips the name prompt at exit)")
  .option("--ui <renderer>", "UI renderer to launch for the session (btui, web, app, raw, none)")
  .option("--no-ui", "Start session in background without launching a UI")
  .argument("[args...]", "Arguments to pass to the agent")
  .action((args, options) => startCommand(args, { ...options, name: program.opts().identity, harness: flaggedHarness(options, harnessRecords)?.id }));
addHarnessFlags(start, harnessRecords);

const resume = session
  .command("resume")
  .description("Resume a previous session")
  .argument("[sessionId]", "Barry session ID to resume (resolves to the agent's session)")
  .option("--last", "Resume the most recent session for the current directory")
  .option("-N, --session-name <name>", "Rename the resumed session")
  .option("--ui <renderer>", "UI renderer to launch for the session (btui, web, app, raw, none)")
  .option("--no-ui", "Start session in background without launching a UI")
  .option("--zai", "Use z.ai (GLM) as the model vendor")
  .option("--ollama", "Use a local Ollama model as the model vendor")
  .option("--llamacpp", "Use a local llama.cpp model as the model vendor")
  .option("--model-provider <key>", "Select a model endpoint explicitly (for example, ollama)")
  // Resume shows the capability picker with the previous session's bags checked.
  // These are the same escape hatches `start` offers, so a resume can skip the
  // picker (scripts, non-interactive shells) or change capabilities outright
  // without having to abandon the conversation and start a fresh session.
  .option("-b, --bag <bags>", "Comma-separated bag names to enable (skips the picker)")
  .option("--bags <bags>", "Comma-separated bag names to enable (skips the picker)")
  .option("--bound <bounds>", "Comma-separated bound names restricting the session")
  .option("--bounds <bounds>", "Comma-separated bound names restricting the session")
  .option("--last-bags", "Use remembered bags and bounds instead of the resumed session’s selection")
  .option("--all", "Grant every packed bag's tools (skips the picker)")
  .option("--show-builtin", "Show builtin bags in the overview and capability picker (hidden by default — they are always granted)")
  .option("-r, --read", "Read-only: --all under the readonly bound (skips the picker)")
  .option("--none", "Clear selected optional bags (skips the picker; identity bags still grant their tools)")
  .option("-p, --prompt <prompt>", "Send an initial prompt instead of starting interactively")
  .action((sessionId, options) => resumeCommand(sessionId, { ...options, barry: program.opts().identity, harness: flaggedHarness(options, harnessRecords)?.id }));
addHarnessFlags(resume, harnessRecords);

for (const operation of ["interrupt","stop"] as const) session.command(`${operation} <id>`)
  .description(operation === "stop" ? "Stop a hosted session immediately" : "Interrupt the current turn, keeping the session open")
  .action(async(id:string)=>(await import("./commands/session-control.js")).sessionControlCommand(operation,id));

session.command("bench <id>")
  .description("Measure hosted turn admission, thinking and streaming cadence")
  .requiredOption("--prompts <prompts...>", "Prompts to run sequentially")
  .option("--repeat <count>", "Repeat each prompt", "1")
  .option("--json", "Print one JSON result per turn")
  .option("--ps", "Include Claude process counts")
  .action(async (id, options) => (await import("./commands/session-bench.js")).sessionBenchCommand(id, options));

session
  .command("prompt")
  .description("Run a prompt using the Claude Agent SDK (non-interactive)")
  .requiredOption("-p, --prompt <prompt>", "The prompt to send to Claude")
  .option("--max-turns <turns>", "Maximum number of turns", "15")
  .option("-c, --cwd <directory>", "Working directory for the query")
  .option("-b, --bag <bags>", "Comma-separated bag names granting tools and skills")
  .option("--bags <bags>", "Comma-separated bag names granting tools and skills")
  .option("--bound <bounds>", "Comma-separated bound names restricting the session")
  .option("--bounds <bounds>", "Comma-separated bound names restricting the session")
  .option("-m, --model <model>", "Model to use (overrides the identity's default)")
  .action(async (options: PromptCommandOptions) => {
    const { promptCommand } = await import("./commands/prompt.js");
    return promptCommand({ ...options, name: program.opts().identity });
  });

// `session run` is the old name of `session prompt`, kept hidden for one
// release. It re-parses the real target's own argv (so flags stay in sync)
// rather than hand-copying option values, and prints the new name once.
session
  .command("run", { hidden: true })
  .helpOption(false)
  .allowUnknownOption()
  .allowExcessArguments(true)
  .argument("[args...]")
  .action(async (args: string[]) => {
    console.error("`barry session run` is now `barry session prompt`; `run` still works for one release.");
    await program.parseAsync(["session", "prompt", ...args], { from: "user" });
  });

session
  .command("adopt <id> [message...]")
  .description("Move a TUI's session to hosted, optionally with its next message (close the TUI first)")
  .action(async (id: string, message: string[]) => {
    const { runAdopt } = await import("./commands/adopt.js");
    const { harnessAdapter } = await import("./adapters/installed.js");
    const { getSession, getProviderSessionsBySession } = await import("@barry-rocks/sessions-bag/client");
    const { classify } = await import("@barry-rocks/sessions-bag/process-liveness");
    const { parseMetadata } = await import("@barry-rocks/sessions-bag/store/session-helpers");
    const { getServicePort } = await import("@barry-rocks/sdk/services");

    process.exitCode = await runAdopt(
      {
        session: async (sessionId) => {
          const row = await getSession(sessionId);
          if (!row) return undefined;
          const metadata = parseMetadata(row.metadata);

          // From the `provider_sessions` TABLE, not from session metadata.
          // An earlier version read `metadata.provider_session_id`, which is
          // never written — so every adopt refused with "no recorded harness
          // session id" while the id sat in the table the whole time.
          //
          // Newest first: a session resumed several times has a row per
          // conversation, and the live one is the last to be recorded.
          const harnessSessions = await getProviderSessionsBySession(sessionId);
          const latest = harnessSessions
            .filter((ps) => typeof ps.provider_session_id === "string" && ps.provider_session_id)
            .at(-1);

          return {
            id: row.id,
            provider: latest?.provider ?? (typeof metadata.provider === "string" ? metadata.provider : ""),
            mode: typeof metadata.mode === "string" ? metadata.mode : null,
            harnessSessionId: latest?.provider_session_id ?? null,
            // The recorded pid, checked against its start time: a TUI still
            // running is the one verdict that refuses.
            driverAlive: classify(metadata).state === "alive",
          };
        },
        adapter: async (harness) => {
          try {
            return await harnessAdapter(harness);
          } catch {
            return undefined;
          }
        },
        deliver: async (sessionId, content) => {
          const response = await fetch(`http://localhost:${getServicePort("api")}/api/v1/sessions/${sessionId}/message`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(process.env.BARRY_SECRET ? { Authorization: `Bearer ${process.env.BARRY_SECRET}` } : {}),
            },
            body: JSON.stringify({ content }),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `the API answered ${response.status}`);
          }
        },
        write: (line) => console.log(line),
      },
      id,
      message.length > 0 ? message.join(" ") : undefined,
    );
  });

session
  .command("list")
  .alias("ls")
  .description("List active sessions")
  .action(sessionListCommand);

session
  .command("archive [id]")
  .description("Archive a session (hide from resume picker)")
  .option("--all-closed", "Archive all closed sessions")
  .action(sessionArchiveCommand);

// ── Identity group ──────────────────────────────────────────────────────────────
// Every identity verb lives under `barry identity <verb>` — see
// command-registry.ts's comment on the "identity" namespace entry. `doctor`
// stays at root (it reports on all identities, not the active one, and
// never fit the per-identity pattern); `ls` stays at root as a permanent,
// visible alias for `identity list`. The 20 old flat top-level spellings
// this group replaced (add-bags, set-model,...) no longer exist as
// commands at all — see reserved-names.ts for the two (list, delete) that
// still occupy their old name as a permanent blocker, and command-registry.ts's
// RESERVED_NAMES for why those two specifically.
const identity = program
  .command("identity")
  .description("Create and configure identities");

// `show`/`test`/`check`/`delete` take the identity as a POSITIONAL, not
// `--name` — unlike every verb below this block. `list` takes neither.
identity
  .command("create")
  .description("Create an identity")
  .argument("<name>", "Its name; quote spaces (\"B. Goode\" is created as bgoode)")
  .option("-d, --dir <path>", "Where to create the identity (default: ./barry-<slug>)")
  .option("-e, --email <email>", "Email for vault account provisioning")
  .action((name: string, options: { dir?: string; email?: string }) => identityCreateCommand(name, options));

identity
  .command("list")
  .description("List all identities")
  .action(listIdentitiesCommand);

identity
  .command("show [name]")
  .description("Show barry details (uses the active barry if not specified)")
  .action(showIdentityCommand);

identity
  .command("test [name]")
  .description("Test a barry (validate secrets load correctly)")
  .action(testIdentityCommand);

identity
  .command("check [name]")
  .description("Check barry health: vault, secrets, bag credentials")
  .action(checkIdentityCommand);

identity
  .command("delete <name>")
  .description("Delete a barry")
  .action(deleteIdentityCommand);

// `doctor` is deliberately NOT under `identity` — see the comment above.
program
  .command("doctor")
  .description("Report installation health, adapters and identity configuration drift")
  .option("--fix", "Migrate retired identity keys, repair row drift and install missing commands")
  .option("--json", "Print the install health report as JSON")
  .option("--strict", "Exit 1 when any install health check fails")
  .action(async (options) => {
    if (options.fix && options.json) throw new Error("--fix cannot be combined with --json; run doctor --fix, then doctor --json");
    const { installationChecks } = await import("./commands/doctor-install.js");
    const checks = await installationChecks();
    if (options.json) {
      const { adapterStore } = await import("./adapters/installed.js");
      const { checkRequirements } = await import("@barry-rocks/sdk/adapters/models");
      const { hostProbes } = await import("./commands/doctor.js");
      const { adapters } = await adapterStore();
      const probes = hostProbes();
      const adapterChecks = adapters.installed().map(adapter => ({ id: adapter.id, checks: checkRequirements(adapter.requirements, probes) }));
      const failing = adapterChecks.filter(adapter => adapter.checks.find(check => check.name === "binary")?.status !== "ok").length;
      console.log(JSON.stringify({ installation: checks, adapters: adapterChecks }, null, 2));
      process.exitCode = options.strict && checks.some(check => check.status === "fail") ? 1 : failing;
      return;
    }
    for (const check of checks) console.log(`${check.status === "pass" ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    const { adapterStore } = await import("./adapters/installed.js");
    const { runDoctor } = await import("./commands/doctor.js");
    const { adapters } = await adapterStore();
    const failingAdapters = runDoctor(adapters.installed());
    const refused = await modelAdapterGroupCommand("check");
    await barryDoctorCommand(options);
    const { reportReleaseProblems } = await import("./releases/state.js");
    reportReleaseProblems();
    process.exitCode = options.strict && checks.some(check => check.status === "fail") ? 1 : Math.max(Number(process.exitCode ?? 0), refused, failingAdapters);
  });

// `barry ls` — permanent, visible, NOT a deprecation alias (it is never
// removed): a short root-level spelling for `identity list`, kept for muscle
// memory. Forwards the same way a deprecated alias does (re-parsing the real
// target's own argv, not hand-copying option values — see
// reserved-names.ts's doc comment for why that matters), but prints no
// "moved to" notice, because nothing has moved out from under it.
program
  .command("ls", { hidden: false })
  .helpOption(false)
  .allowUnknownOption()
  .allowExcessArguments(true)
  .argument("[args...]")
  .description("List all identities (alias for `identity list`)")
  .action(async (args: string[]) => {
    await program.parseAsync(["identity", "list", ...args], { from: "user" });
  });

const identityBags = identity
  .command("bags")
  .description("Manage the bags configured on an identity")
  .action(() => identityBagsCommand({ name: program.opts().identity }));

identityBags
  .command("add <bags...>")
  .description("Add bags to an identity (additive)")
  .option("--optional", "Offer in the session picker rather than requiring on every session")
  .action((bagNames: string[], opts: { optional?: boolean }) =>
    addIdentityBagsCommand(bagNames, { name: program.opts().identity, optional: opts.optional }));

identityBags
  .command("remove <bags...>")
  .description("Remove bags from an identity (others preserved)")
  .action((bagNames: string[]) => removeIdentityBagsCommand(bagNames, { name: program.opts().identity }));

const identityBounds = identity
  .command("bounds")
  .description("Manage the identity's bounds")
  .action(() => identityBoundsCommand({ name: program.opts().identity }));
identityBounds
  .command("add <names...>")
  .description("Add bounds to the identity")
  .option("--optional", "Offer in the session picker rather than requiring on every session")
  .action((names: string[], opts: { optional?: boolean }) =>
    addIdentityBoundsCommand(names, { name: program.opts().identity, optional: opts.optional }));
identityBounds
  .command("set <name>")
  .description("Create or update an inline bound on the identity's identity.yaml")
  .option("--description <text>", "Description for the bound")
  .option("--optional", "Offer in the session picker rather than requiring on every session")
  .option("--allow-tools <patterns>", "Comma-separated allowed tool patterns")
  .option("--deny-tools <patterns>", "Comma-separated denied tool patterns")
  .option("--allow-native <patterns>", "Comma-separated allowed native tool patterns (e.g. *:Read)")
  .option("--deny-native <patterns>", "Comma-separated denied native tool patterns (e.g. *:Bash)")
  .option("--allow-files <globs>", "Comma-separated allowed file path globs")
  .option("--deny-files <globs>", "Comma-separated denied file path globs")
  .option("--allow-bash <patterns>", "Comma-separated allowed bash command patterns")
  .option("--deny-bash <patterns>", "Comma-separated denied bash command patterns")
  .option("--allow-network <patterns>", "Comma-separated allowed network URL globs or classes")
  .option("--deny-network <patterns>", "Comma-separated denied network URL globs or classes")
  .option("--enforce-network <mode>", "Network enforcement mode: auto, required, or off")
  .option("--allow-nodes <nodes>", "Comma-separated allowed node names")
  .option("--deny-nodes <nodes>", "Comma-separated denied node names")
  .action((boundName: string, opts: IdentityBoundSetOptions) =>
    setIdentityBoundCommand(boundName, { ...opts, name: program.opts().identity }));
identityBounds
  .command("remove <names...>")
  .description("Remove bounds from the identity (others preserved)")
  .action((names: string[]) => removeIdentityBoundsCommand(names, { name: program.opts().identity }));
identityBounds
  .command("clear")
  .description("Clear every bound from the identity")
  .action(() => clearIdentityBoundsCommand({ name: program.opts().identity }));

const identityAdapters = identity.command("adapters").description("Configure each harness's model, mode and default");
identityAdapters.command("set <harness>")
  .description("Configure an installed harness on an identity")
  .option("--model <model>", "Model id or vendor/model ref")
  .option("--provider <vendor>", "Vendor serving a bare model id")
  .option("--mode <mode>", "Launch mode declared by this adapter")
  .option("--effort <level>", "Thinking effort: low, medium, high, xhigh, max")
  .option("--default", "Make this the identity's default harness")
  .action((harness: string, options: IdentityAdapterOptions) => setIdentityAdapterCommand(harness, { ...options, name: program.opts().identity }));
identityAdapters.command("remove <harness>")
  .description("Remove an identity's own adapter entry")
  .action((harness: string) => removeIdentityAdapterCommand(harness, { name: program.opts().identity }));

const notifier = identity
  .command("notifier")
  .description("Set or clear the status-update notifier tool on a barry");

notifier
  .command("set <tool>")
  .description("Set the status-update notifier tool on a barry (e.g. send_slack_message)")
  .option("--target <target>", "Delivery target (Slack channel, phone number, …)")
  .action((tool: string, opts: { target?: string }) => setIdentityNotifierCommand(tool, { ...opts, name: program.opts().identity }));

notifier
  .command("clear")
  .description("Clear the status-update notifier from a barry")
  .action(() => clearIdentityNotifierCommand({ name: program.opts().identity }));

const github = identity
  .command("github")
  .description("Claim or release a GitHub App installation for a barry");

github
  .command("set <installationId>")
  .description("Claim a GitHub App installation for a barry (routes its webhooks here)")
  .action((installationId: string) =>
    setIdentityGitHubInstallationCommand(installationId, { name: program.opts().identity }));

github
  .command("clear")
  .description("Release a barry's claim on a GitHub App installation")
  .action(() => clearIdentityGitHubInstallationCommand({ name: program.opts().identity }));

program
  .command("notify <message>")
  .description("Send a notification through the configured channel (Slack, SMS)")
  .option("-c, --channel <channel>", "Notification channel: slack or sms (overrides barry notifier)")
  .option("-t, --type <type>", "Event type to record (default: notification)")
  .option("-s, --severity <severity>", "Event severity to record (default: info)")
  .action((message: string, options: { channel?: string; type?: string; severity?: string }) =>
    notifyCommand(message, { ...options, name: program.opts().identity })
  );

const mcp = program
  .command("mcp")
  .description("MCP server management");

mcp
  .command("list")
  .alias("ls")
  .description("List configured MCP servers")
  .action(listCommand);

mcp
  .command("enable <name>")
  .description("Enable an MCP server in Cursor for this project")
  .action(mcpEnableCommand);

mcp
  .command("disable <name>")
  .description("Disable an MCP server in Cursor for this project")
  .action(mcpDisableCommand);

const bound = program
  .command("bound")
  .description("Manage bounds");

bound
  .command("list")
  .alias("ls")
  .description("List all bounds and what each restricts")
  .option("--json", "Output as JSON")
  .action((opts: { json?: boolean }) => boundListCommand(opts));

const configGroup = program
  .command("config")
  .description("Barry configuration (show, export, import)");

configGroup
  .command("show")
  .description("Show Barry configuration (environment, hosting, security)")
  .action(configCommand);

configGroup.action(configCommand);

configGroup
  .command("export")
  .description("Export identities and config to the backup repo")
  .option("-d, --dir <path>", "Config repo directory (default: ~/repos/my-barry-config)")
  .option("--plaintext", "Write the export with normal permissions; without it files are written 0600")
  .action(configExportCommand);

configGroup
  .command("import")
  .description("Import identities and config from the backup repo")
  .option("-d, --dir <path>", "Config repo directory (default: ~/repos/my-barry-config)")
  .action(configImportCommand);

configGroup
  .command("init")
  .description("Initialize the config backup repo")
  .option("-d, --dir <path>", "Config repo directory (default: ~/repos/my-barry-config)")
  .action(configInitCommand);

const trash = program
  .command("trash")
  .description("Soft-delete files by moving them to this instance's trash")
  .argument("[files...]", "Files to trash")
  .action(trashCommand);

trash
  .command("list")
  .alias("ls")
  .description("List items in trash")
  .action(trashListCommand);

trash
  .command("restore <files...>")
  .description("Restore files from trash to current directory")
  .action(trashRestoreCommand);

trash
  .command("empty")
  .description("Permanently delete all items in trash")
  .action(trashEmptyCommand);

const archive = program
  .command("archive")
  .description("Move files to this instance's archive")
  .argument("[files...]", "Files to archive")
  .option("-r, --recursive", "Archive directories")
  .action(archiveCommand);

archive
  .command("list")
  .alias("ls")
  .description("List items in archive")
  .action(archiveListCommand);

const cursor = program
  .command("cursor")
  .description("Cursor agent integration");

cursor
  .command("setup")
  .description("Configure Barry MCP in ~/.cursor/mcp.json (run once)")
  .action(cursorSetupCommand);

const vault = program
  .command("vault")
  .description("Manage secrets in the encrypted vault");

vault
  .command("assign <vault>")
  .description("Point an identity at a named vault (several identities may share one)")
  .option("--email <email>", "Account email, required the first time a vault is named")
  .action((vaultName, options) =>
    vaultAssignCommand(vaultName, { identity: program.opts().identity, email: options.email }));

vault
  .command("add <key> [secret]")
  .description("Add or update a secret in the vault (secret read from stdin or a masked prompt when omitted)")
  .option("--force", "Overwrite an existing item even when the vault is shared")
  .option("--vault <vault>", "Vault to act on directly (mutually exclusive with -i/--identity)")
  .action((key, secret, options) =>
    vaultAddCommand(program.opts().identity, key, secret, { force: options.force, vault: options.vault }));

vault
  .command("list")
  .alias("ls")
  .description("List all vault items")
  .option("--vault <vault>", "Vault to act on directly (mutually exclusive with -i/--identity)")
  .action((options) => vaultListCommand(program.opts().identity, { vault: options.vault }));

vault
  .command("get <key>")
  .description("Get a vault item by name")
  .option("--vault <vault>", "Vault to act on directly (mutually exclusive with -i/--identity)")
  .action((key, options) => vaultGetCommand(program.opts().identity, key, { vault: options.vault }));

vault
  .command("status")
  .description("Check vault connectivity and auth status")
  .option("--vault <vault>", "Vault to act on directly (mutually exclusive with -i/--identity)")
  .action((options) => vaultStatusCommand(program.opts().identity, { vault: options.vault }));

vault
  .command("provision")
  .description("Give an existing barry a vault account (identity create --email only does this at creation)")
  .requiredOption("--email <email>", "Email to register the vault account under")
  .option("--force", "Replace an existing vault account — its secrets become unreachable")
  .action((options) => vaultProvisionCommand(program.opts().identity, options.email, { force: options.force }));

vault
  .command("remove <key>")
  .alias("rm")
  .description("Delete a secret from the vault")
  .option("--force", "Delete even if an env mapping still references it")
  .action((key, options) => vaultRemoveCommand(program.opts().identity, key, { force: options.force }));

vault
  .command("export")
  .description("Write every vault item to a plaintext JSON file (for moving to another account)")
  .requiredOption("--out <path>", "File to write")
  .action((options) => vaultExportCommand(program.opts().identity, options.out));

vault
  .command("import")
  .description("Load items from a vault export file")
  .requiredOption("--file <path>", "Export file to read")
  .option("--overwrite", "Replace items that already exist instead of skipping them")
  .action((options) => vaultImportCommand(program.opts().identity, options.file, { overwrite: options.overwrite }));

vault
  .command("restore <path>")
  .description("Restore a vault backup (vault.db or vault.db.age) — stops the daemon, installs the file, restarts it")
  .option("--dry-run", "Verify the snapshot and print what would happen, without touching anything")
  .option("--force", "Actually perform the restore (required — refuses by default)")
  .option("--accept-stale", `Restore a snapshot older than 30 days anyway`)
  .option("--age-key-path <path>", "Path to the age private key (default: vault-backup-key.txt in the instance's application support directory)")
  .action((path, options) => vaultRestoreCommand(path, {
    name: program.opts().identity,
    dryRun: options.dryRun,
    force: options.force,
    acceptStale: options.acceptStale,
    ageKeyPath: options.ageKeyPath,
  }));

const identitySecrets = identity.command("secret").description("Manage explicit identity secret references");
identitySecrets
  .command("set <key> [value]")
  .description("Store a secret and bind it to an identity (value read from stdin or a masked prompt when omitted)")
  .requiredOption("--in <source>", "Secret source: vault or keychain")
  .option("--force", "Overwrite an existing vault item even when the vault is shared")
  .action((key, value, options) => identitySecretSetCommand(key, value, { force: options.force, source: options.in, name: program.opts().identity }));

identitySecrets
  .command("get <key>")
  .description("Read a secret value (masked)")
  .action((key: string) => identitySecretGetCommand(key, { name: program.opts().identity }));

identitySecrets
  .command("list")
  .description("List secret names for a barry")
  .action(() => identitySecretListCommand({ name: program.opts().identity }));

identitySecrets
  .command("remove <key>")
  .description("Remove a secret reference (leaves the secret it points at in place)")
  .action((key: string) => identitySecretRemoveCommand(key, { name: program.opts().identity }));

identitySecrets
  .command("import <envfile>")
  .description("Import secrets from a .env file")
  .requiredOption("--in <source>", "Secret source: vault or keychain")
  .option("--force", "Overwrite an existing vault item even when the vault is shared")
  .action((path, options) => identitySecretImportCommand(path, { force: options.force, source: options.in, name: program.opts().identity }));

const bag = program
  .command("bag")
  .description("Manage capability bags");

bag
  .command("list")
  .alias("ls")
  .description("List all registered bags and status")
  .action(bagListCommand);

bag
  .command("show <name>")
  .description("Show bag manifest and what it provides")
  .action(bagShowCommand);

bag
  .command("access <name> <level>")
  .description("Set registry-wide bag visibility: enabled | deferred | disabled (distinct from pack/unpack, which are per-barry)")
  .action(bagAccessCommand);

bag
  .command("doctor")
  .description("Audit every barry for stale bag references, retired manifest keys, un-enabled sub-bags and missing launchd plists")
  .option("--fix", "Repair the problems found")
  .action(bagDoctorCommand);

// Kept as `bag create` for muscle memory; `barry new` is the documented spelling.
bag
  .command("create <name>")
  .description("Scaffold a new bag directory")
  .option("--path <dir>", "Directory to create bag in")
  .option("--server", "Include MCP server for barry:// resource discovery")
  .option("--template <type>", "Template: local (default, monorepo) or npm (standalone, uses @barry-rocks/sdk/tools)", "local")
  .action(bagCreateCommand);

bag
  .command("build [name]")
  .description("Build local bags to plain JS (all bags if no name given)")
  .option("-f, --force", "Rebuild even when output is up to date")
  .option("-w, --watch", "Rebuild on source changes")
  .option("--if-stale", "Build only stale bags, retaining failures until inputs change")
  // bagBuildCommand returns a boolean so programmatic callers can see whether
  // the build succeeded. Commander ignores a handler's return value, so it is
  // discarded here rather than widening the command's own signature.
  .action(async (name: string | undefined, options: { force?: boolean; watch?: boolean; ifStale?: boolean }) => {
    await bagBuildCommand(name, options);
  });

bag
  .command("infra <name> <action>")
  .description("Run terraform against a bag's declared infrastructure (infra: in bag.yaml)")
  .option("--auto-approve", "Skip terraform interactive approval")
  .option("--var <var...>", "Pass -var to terraform (repeatable)")
  .action(bagInfraCommand);

bag
  .command("serve <name>")
  .description("Serve a local bag over MCP (for remote-bag testing and as a reference server)")
  .option("--port <port>", "Port to listen on (default: 9878)")
  .option("--host <host>", "Host to bind (default: 127.0.0.1)")
  .action(bagServeCommand);

bag
  .command("auth <name>")
  .description("Authenticate with a bag's MCP server (OAuth flow)")
  .action(bagAuthCommand);

bag
  .command("check <path>")
  .description("Validate a bag directory without installing it: manifest, referenced files, skills, actions")
  .option("--deep", "Also boot the bag's tools entry on a real MCP server (runs bag code)")
  .option("--json", "Emit findings as JSON")
  .action(bagCheckCommand);

bag
  .command("publish-sdk")
  .description("Publish @barry-rocks/sdk/tools to npm")
  .option("--dry-run", "Run pnpm publish --dry-run without actually publishing")
  .action(bagPublishSdkCommand);

const action = program.command("action").description("Run actions and read their recorded runs");

action
  .command("run <name>")
  .description("Run an action now: a script action here, an agent action via the API")
  .option("--input <key=value>", "An input value (JSON if it parses, else a string); repeatable", (v: string, prev: string[] = []) => [...prev, v])
  .option("--inputs-json <json>", "All inputs as one JSON object")
  .option("-b, --bag <bags>", "Comma-separated bag names to enable for this action run")
  .option("--bags <bags>", "Comma-separated bag names to enable for this action run")
  .option("--bound <bounds>", "Comma-separated bound names restricting this action run")
  .option("--bounds <bounds>", "Comma-separated bound names restricting this action run")
  .option("--json", "Print the whole run record as JSON")
  .action(actionRunCommand);

action
  .command("stop <run_id>")
  .description("Request workflow Stop for an inspected action; acknowledgement does not prove cessation")
  .requiredOption("--session <id>", "Open caller session belonging to this identity")
  .requiredOption("--revision <revision>", "Inspected canonical work revision")
  .requiredOption("--reason <reason>", "Reason for requesting Stop")
  .option("--request-id <id>", "Reuse this UUID after an unconfirmed Stop reply")
  .action(actionStopCommand);

action.command("work-start <name>")
  .description("Admit an installed script to durable work using this identity's selected session")
  .requiredOption("--session <id>", "Open caller session belonging to this identity")
  .requiredOption("--input-json <json>", "Original action inputs as a JSON object")
  .option("--key <key>", "Reuse the original key and inputs after an unconfirmed reply")
  .option("--request-id <uuid>", "Transport request UUID")
  .option("--recovery-epoch <uuid>", "Inspected active restore epoch for a new invocation")
  .action(actionWorkStartCommand);

action.command("work-lookup <key>")
  .description("Recover accepted work by original key without submitting another invocation")
  .requiredOption("--session <id>", "Original caller session belonging to this identity")
  .action(actionWorkLookupCommand);

action
  .command("show <run_id>")
  .description("Print an action run's recorded deliverable")
  .option("--json", "Output the whole run record as JSON")
  .action(actionShowCommand);

action
  .command("runs", { isDefault: true })
  .alias("ls")
  .description("List recorded action runs, newest first")
  .option("--action <name>", "Filter by action name")
  .option("--session <id>", "Filter by session ID")
  .option("--status <status>", "Filter by status: started, complete, failed, cancelled")
  .option("--trigger <trigger>", "Filter by what started it: session, api, cli, schedule, job (job runs, subagents among them)")
  .option("--limit <n>", "Number of runs to show", "20")
  .option("--json", "Output as JSON")
  .action(actionRunsCommand);

const schedule = program.command("schedule").description("See, run and pause schedules (actions on a trigger)");

schedule
  .command("list", { isDefault: true })
  .alias("ls")
  .description("List schedules with their next and last fire, and whether the scheduler is alive")
  .option("--json", "Output as JSON")
  .action(scheduleListCommand);

schedule
  .command("show <id>")
  .alias("history")
  .description("Show a schedule (<bag>/<name>) and its recent runs, or a one-off (sch_…) and its attempts")
  .option("--limit <n>", "Number of runs to show", "20")
  .option("--json", "Output as JSON")
  .action(scheduleShowCommand);

schedule
  .command("run <id>")
  .description("Run a schedule's action now, outside its trigger")
  .option("-b, --bag <bags>", "Comma-separated bag names to enable for this schedule run")
  .option("--bags <bags>", "Comma-separated bag names to enable for this schedule run")
  .option("--bound <bounds>", "Comma-separated bound names restricting this schedule run")
  .option("--bounds <bounds>", "Comma-separated bound names restricting this schedule run")
  .action(scheduleRunCommand);

schedule
  .command("pause <id>")
  .description("Stop a schedule firing until resumed")
  .action((id: string) => schedulePauseCommand(id, true));

schedule
  .command("resume <id>")
  .description("Resume a paused schedule (its next fire is computed from now)")
  .action((id: string) => schedulePauseCommand(id, false));

schedule
  .command("cancel <id>")
  .description("Cancel a one-off schedule (sch_…) that has not started")
  .action(scheduleCancelCommand);

schedule
  .command("logs <id>")
  .description("Print the log of a schedule's latest run")
  .option("--run <run_id>", "A specific run instead of the latest")
  .option("-f, --follow", "Follow the log")
  .action(scheduleLogsCommand);

const events = program.command("events").description("Manage barry events");

events
  .command("list", { isDefault: true })
  .alias("ls")
  .description("List recent events")
  .option("--type <type>", "Filter by event type (progress, notification, task_finished, system_alert)")
  .option("--session <id>", "Filter by session ID")
  .option("--unread", "Show only unread events")
  .option("--limit <n>", "Number of events to show", "20")
  .option("--json", "Output as JSON")
  .action(eventsListCommand);

events
  .command("read [id]")
  .description("Mark event(s) as read (all if no ID given)")
  .action(eventsReadCommand);

events
  .command("count")
  .description("Show unread event count")
  .action(eventsCountCommand);

events
  .command("emit <title>")
  .description("Create an event")
  .option("--type <type>", "Event type", "notification")
  .option("--severity <level>", "Severity: info, warn, error, success", "info")
  .option("--session <id>", "Associate with a session")
  .option("--body <text>", "Event body text")
  .option("--metadata <json>", "JSON metadata object")
  .action(eventsEmitCommand);

// ── Heir command (easter-egg spelling of `identity create`) ──────────────────────────────────────────
// Hidden: it still works, but `identity create` is the one help and hints name.
program
  .command("heir", { hidden: true })
  .description("Birth a new identity: barry heir to the <name> empire")
  .allowUnknownOption()
  .allowExcessArguments()
  .helpOption(false)
  .argument("[args...]")
  .option("-e, --email <email>", "Email for vault account provisioning")
  .option("-d, --dir <path>", "Where to create the identity (default: ./barry-<slug>)")
  .action((args: string[], options) => heirCommand(args, options));

// ── ACP (Barry as an agent for editors: Zed, JetBrains, Toad) ────────────────
// Lazily imported: it pulls in the ACP protocol and a WebSocket client, which
// no other command needs.
program
  .command("acp")
  .description("Serve Barry as an ACP agent on stdin/stdout, for an editor to run")
  .action(async () => {
    const { acpCommand } = await import("./commands/acp.js");
    await acpCommand();
  });

// ── Use command (choose the identity, globally or per-repo) ──────────────────
// `switch` is the old name, kept as an alias so muscle memory and scripts work.
program
  .command("use [name]")
  .alias("switch")
  .description("Use an identity (interactive picker if no name given)")
  .option("-l, --local", "Set it for this repo only, via a .barry file")
  .option("--clear", "Remove this repo's .barry (with --local)")
  .option("--list", "Show the global default and this repo's binding")
  .action(useCommand);

program
  .command("alias [identity] [alias]")
  .description("Give an identity another command name (e.g. `bgo` for bgoode)")
  .option("--remove", "Remove an alias")
  .option("--list", "Show every identity and its aliases")
  .action(aliasCommand);

// ── Bag lifecycle: new → install → pack → unpack ─────────────────────────────
program
  .command("new <kindOrName> [name]")
  .description("Scaffold a bag, action, instruction, or bound (bare name = bag)")
  .option("--path <path>", "Where to create it (default: ./<name>) — bags only")
  .option("--server", "Include an MCP server entry point — bags only")
  .option("--template <template>", "local | npm", "local")
  .option("--bag <bag>", "Bag to scaffold into (default: the bag in cwd)")
  .option("--description <text>", "Description for the generated item")
  .option("--mode <mode>", "always | on-demand — instructions only")
  .action(newCommand);

// Installing is system-level; packing is per identity. `barry install` only
// installs. An identity's `install` installs and then asks whether to pack the
// bag onto that identity too (`--yes` skips the question).
const installCommand = program
  .command("install <target>")
  .description(
    target.kind === "identity"
      ? `Install a bag on this machine, then offer to pack it onto ${target.name}. Repos are cloned to ~/repos/bags.`
      : "Install a bag on this machine and register it (local dir, npm package, git repo, or MCP URL). Repos are cloned to ~/repos/bags. Pack it onto an identity with `<identity> pack <bag>`.",
  )
  // NOT --name: everywhere else in this CLI --name is the IDENTITY, so reusing
  // it for the bag name would make `barry install ./foo --name bux` register a
  // bag called "bux" instead of installing for barry "bux".
  .option("--as <name>", "Register under a different bag name")
  .option("--force", "Rebuild even when output is up to date");
if (target.kind === "identity") {
  installCommand
    .option("-y, --yes", `Pack it onto ${target.name} without asking`)
    .action(async (targetArg: string, opts: { as?: string; force?: boolean; yes?: boolean }) => identityInstallCommand(targetArg, opts));
} else {
  installCommand.action(async (targetArg: string, opts: { as?: string; force?: boolean }) => { await bagInstallCommand(targetArg, opts); });
}

program
  .command("pack <bag>")
  .description("Add an installed bag to this identity's identity.yaml and create its stores")
  .option("--optional", "Offer in the session picker rather than requiring on every session")
  .action((bag: string, opts: { optional?: boolean }) =>
    bagPackCommand(bag, { name: program.opts().identity, optional: opts.optional }));

program
  .command("unpack <bag>")
  .description("Remove a bag from this identity's identity.yaml (files on disk are untouched)")
  .option("--unregister", "Also remove it from the registry, unless another barry uses it")
  .action((bag: string, opts: { unregister?: boolean }) =>
    bagUnpackCommand(bag, { ...opts, name: program.opts().identity }),
  );

// ── Adapters ──────────────────────────────────────────────────────────────────
// `barry adapter doctor`, not `barry doctor`: the root `doctor` is identity
// health and `bag doctor` is bag health, so this follows the same shape. The
// group is also where WP-C4's add/remove/list land.
const adapterGroup = program
  .command("adapter")
  .description("Agent adapters — which are usable on this machine");

// Exits with the NUMBER of unusable adapters rather than 0/1, so a caller can
// tell "one vendor missing" from "nothing works" without parsing the output.
adapterGroup
  .command("doctor [adapter]")
  .description("Check adapter runtime availability, recommended versions and compatibility")
  .action(async (adapter: string | undefined) => {
    const { runDoctor } = await import("./commands/doctor.js");
    const { adapterStore } = await import("./adapters/installed.js");
    const { adapters } = await adapterStore();
    process.exitCode = runDoctor(adapters.installed(), { only: adapter });
  });

async function adapterDeps() {
  const { adapterStore } = await import("./adapters/installed.js");
  const { adapters } = await adapterStore();
  return { adapters, write: (line: string) => console.log(line) };
}

adapterGroup
  .command("list")
  .description("Agent adapters installed on this machine, and any with problems")
  .action(async () => {
    const { listAdapters } = await import("./commands/adapter.js");
    process.exitCode = await listAdapters(await adapterDeps());
  });

adapterGroup
  .command("check [adapter]")
  .description("Load each installed adapter again and check its declarations")
  .action(async (adapter: string | undefined) => {
    const { checkAdapters } = await import("./commands/adapter.js");
    process.exitCode = await checkAdapters(await adapterDeps(), adapter);
  });

/**
 * `barry adapter add <path>`: load the adapter package at a path, check its
 * declarations and this machine, and record it. The user installs the package
 * with their own package manager; Barry never fetches third-party code.
 */
adapterGroup
  .command("add <path>")
  .description("Record the agent adapter package at a path, after checking it")
  .action(async (path: string) => {
    const { addAdapter } = await import("./commands/adapter.js");
    const { blockingProblems } = await import("./commands/doctor.js");
    process.exitCode = await addAdapter({ ...(await adapterDeps()), vet: async (adapter) => blockingProblems(adapter) }, path);
  });

adapterGroup
  .command("remove <adapter>")
  .description("Remove an agent adapter selection, preserving its package and bag data")
  .action(async (id: string) => {
    const { removeAdapter } = await import("./commands/adapter.js");
    process.exitCode = removeAdapter(await adapterDeps(), id);
  });

// Setup records shipped call code; this group also accepts third-party packages.
const modelAdapterGroup = adapterGroup.command("model").description("Select completion, decision and embedding adapters");
async function modelAdapterGroupCommand(action: "list" | "add" | "remove" | "check", argument?: string) {
  try {
    const { loadModelVendors, shippedModelVendors } = await import("@barry-rocks/sdk/adapters/models");
    const { barryModelVendorsPath, installationRoot } = await import("@barry-rocks/sdk/services");
    const { modelAdapterCommand } = await import("./commands/adapter.js");
    return await modelAdapterCommand({
      providers: loadModelVendors({ file: barryModelVendorsPath() }),
      shipped: action === "list" || action === "check" ? shippedModelVendors(installationRoot()) : [],
      write: line => console.log(line),
      error: line => console.error(line),
    }, action, argument);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
    console.error(`Refused to ${action} model adapter: ${message}; check the package manifests and model-providers.json, then retry.`);
    return 1;
  }
}
modelAdapterGroup.command("list").description("List selected model adapters and refusals").action(async () => {
  process.exitCode = await modelAdapterGroupCommand("list");
});
modelAdapterGroup.command("add <path>").description("Check and select a compiled model adapter package").action(async (path: string) => {
  process.exitCode = await modelAdapterGroupCommand("add", path);
});
modelAdapterGroup.command("remove <package>").description("Remove a selection while preserving the installed package").action(async (name: string) => {
  process.exitCode = await modelAdapterGroupCommand("remove", name);
});
modelAdapterGroup.command("check [package]").description("Load selected model adapters and check their contracts and factory ownership").action(async (name: string | undefined) => {
  process.exitCode = await modelAdapterGroupCommand("check", name);
});

// ── Track: sessions barry did not launch ───────────────────────────────────────
/**
 * `plan` and `setup` are separate commands rather than one with `--dry-run`
 * because these write into the user's OWN home (`~/.cursor/hooks.json`,
 * `~/.claude/settings.json`). The safe path should be the short one, and
 * writing should take an explicit `--yes`.
 */
const trackGroup = program
  .command("track")
  .description("Track sessions Barry did not launch (Cursor, IDE Claude) via your own hooks");

async function trackDeps() {
  const { planTracking } = await import("@barry-rocks/sessions-bag/capture");
  const { homedir } = await import("node:os");
  return {
    home: homedir(),
    plan: planTracking,
    write: (line: string) => console.log(line),
    // Read off the live command tree rather than hardcoded, so this answer
    // cannot drift from what the binary actually provides — the point of the
    // check is that it is true of THIS build, today.
    hookCommandExists: () => program.commands.some((c) => c.name() === "hook"),
  };
}

trackGroup
  .command("plan [vendor]", { isDefault: true })
  .description("Show exactly what `track setup` would write, and change nothing")
  .action(async (vendor: string | undefined) => {
    const { trackPlan } = await import("./commands/track.js");
    process.exitCode = trackPlan(await trackDeps(), vendor);
  });

trackGroup
  .command("setup <vendor>")
  .description("Add Barry's hooks to that vendor's config in your home directory")
  .option("--yes", "Apply the plan. Without this, setup only shows what it would do")
  .action(async (vendor: string, options: { yes?: boolean }) => {
    const { runTrackSetup } = await import("./commands/track.js");
    process.exitCode = await runTrackSetup(await trackDeps(), vendor, options.yes === true);
  });

trackGroup
  .command("remove <vendor>")
  .description("Take back only the hooks Barry added, leaving your own untouched")
  .action(async (vendor: string) => {
    const { runTrackRemove } = await import("./commands/track.js");
    process.exitCode = await runTrackRemove(await trackDeps(), vendor);
  });

/**
 * The receiving end of the hooks `barry track setup` installs.
 *
 * Hidden: a vendor invokes this on every event of a tracked session, and a
 * user has no reason to run it by hand. It appears in `~/.cursor/hooks.json`
 * and `~/.claude/settings.json`, which is where it is meant to be read.
 *
 * `allowUnknownOption` because vendors append their own flags over time; an
 * unrecognised one must not turn into a parse error inside someone's editor.
 */
program
  .command("hook <vendor>", { hidden: true })
  .description("Receive a hook event from a tracked session (invoked by the vendor, not by you)")
  .allowUnknownOption()
  .action(async (vendor: string) => {
    const { runHook } = await import("./commands/hook.js");
    const { vendorFromPayload, providerSessionIdFromPayload } = await import(
      "@barry-rocks/sessions-bag/capture"
    );
    const { holdForLaunchedSession, launchedSessionId, recordForeignEvent, waitForQueuedMessage } = await import(
      "./commands/hook-record.js"
    );
    // A TUI Barry launched: its hooks serve its own session, which already
    // exists, rather than a foreign one filed under the vendor's id.
    const launched = launchedSessionId();

    process.exitCode = await runHook(
      {
        read: readStdin,
        emit: (json) => process.stdout.write(`${json}\n`),
        // stderr, never stdout: stdout is the vendor's channel and anything
        // else there is a parse error in the user's own agent.
        warn: (line) => console.error(line),
        record: recordForeignEvent,
        // Delivery, at turn-end only. This is what makes the hook the RELAY
        // WP-B4 asks for rather than a pure recorder.
        waitForMessage: launched
          ? (_harnessSessionId, payload) => holdForLaunchedSession(launched, typeof payload.generation_id === "string" ? { generationId: payload.generation_id } : {})
          : waitForQueuedMessage,
        vendorOf: vendorFromPayload,
        providerSessionIdOf: providerSessionIdFromPayload,
      },
      vendor,
    );
  });

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: Buffer | string) => (data += chunk.toString()));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

// ── Completion command ─────────────────────────────────────────────────────────
program
  .command("completion")
  .description("Output shell completion script (eval \"$(barry completion)\")")
  .action(completionCommand);

program
  .command("__complete", { hidden: true })
  .argument("[args...]")
  .helpOption(false)
  .action(async (args: string[]) => {
    // Safe to pass `program` here even though `.parse()` (below) hasn't
    // returned yet: this action only RUNS once Commander has already
    // dispatched to it, by which point registerBagGroups has already run
    // (it's called above, before.parse()), so program.commands already
    // holds the full static + bag-generated tree.
    await completeCommand(args, program);
  });

// ── Run command (escape hatch for shadowed bag tools) ──────────────────────

// `helpOption(false)` stays: `--help` after a tool name belongs to that TOOL,
// and dispatchBagTool renders it. The cost was that `barry run --help` with no
// tool named hit Commander's required-argument check first and died with
// "error: missing required argument 'tool'" — a help request answered with an
// error. Optional positionals let the action own that case and print usage.
// `tool` dispatches a bag tool directly. `run` is the old name, kept hidden
// for one release; it prints the new name once then forwards unchanged.
async function dispatchToolCommand(
  bagName: string | undefined,
  toolName: string | undefined,
  args: string[],
  usageVerb: string,
): Promise<void> {
  if (!bagName || !toolName || bagName === "--help" || bagName === "-h") {
    console.log(`Usage: barry ${usageVerb} <bag> <tool> [args...]`);
    console.log("\nRun a bag tool directly, bypassing static command groups.");
    console.log("Useful when a bag tool is shadowed by a built-in command.");
    console.log("\nExamples:");
    console.log(`  barry ${usageVerb} memory search "launchd"`);
    console.log(`  barry ${usageVerb} git status`);
    console.log("\nList bags with `barry bag list`; a bag's tools with `barry <bag> --help`.");
    return;
  }
  await dispatchBagTool(bagName, toolName, args, program);
}

program
  .command("tool [bag] [tool] [args...]")
  .description("Run a bag tool directly (bypasses static command groups)")
  .helpOption(false)
  .allowUnknownOption()
  .action((bagName: string | undefined, toolName: string | undefined, args: string[]) =>
    dispatchToolCommand(bagName, toolName, args, "tool"));

program
  .command("run [bag] [tool] [args...]", { hidden: true })
  .description("Run a bag tool directly (renamed to `tool`)")
  .helpOption(false)
  .allowUnknownOption()
  .action((bagName: string | undefined, toolName: string | undefined, args: string[]) => {
    // Only a real tool invocation gets the deprecation line; a bare
    // `barry run`/`barry run --help` is a usage request, not a renamed use.
    if (bagName && toolName && bagName !== "--help" && bagName !== "-h") {
      console.error("`barry run <bag> <tool>` is now `barry tool <bag> <tool>`; `run` still works for one release.");
    }
    return dispatchToolCommand(bagName, toolName, args, "run");
  });

// Developer operations require the host tooling used by each command. Hidden
// from help unless BARRY_DEV=1: these are contributor tooling, not something a
// user who installed Barry needs to see. The commands still run either way.
const devops = program
  .command("devops", { hidden: process.env.BARRY_DEV !== "1" })
  .description("Contributor-machine operations (ios, redmark)");

// ── ios command ────────────────────────────────────────────────────────────────
// Not part of./install: an iOS bundle has no install destination on this host,
// so these apps are built and side-loaded onto a device on demand instead.
devops.command("ios")
  .description("Build the iOS apps bags declare")
  .command("build [app]")
  .description("Build every declared iOS app, or one by name")
  .option("-d, --device", "Sign and install onto a connected iPhone")
  .option("-s, --simulator <name>", "Simulator to target when not using --device")
  .action(iosBuildCommand);

devops.command("redmark").description("Annotate any web page (proxy + overlay)").allowUnknownOption().helpOption(false).argument("[args...]").action((args) => redmarkCommand(args));

// Root instance commands and reserved names register before dynamic bag groups.
registerInstanceCommands(program);

for (const [oldName, newPath] of RESERVED_NAMES) {
  registerReservedName(program, oldName, newPath);
}

// Generate bag commands from the prepared snapshot, rebuilding it if missing.
const snapshotPath = getRegistrySnapshotPath();
// `up` and `setup` are what create a new instance's registry, so its absence
// is expected there and a warning would only be noise before the first run.
const createsRegistry = ["up", "setup"].includes(process.argv[2] ?? "");
const registry = existsSync(snapshotPath)
  ? { expected: true }
  : await (await import("./bags/registration.js")).ensureRegistrySnapshot();
const requestedCommand = process.argv[2];
const staticCommand = !requestedCommand || requestedCommand.startsWith("-") || requestedCommand === "help" || program.commands.some(command => command.name() === requestedCommand || command.aliases().includes(requestedCommand));
const bagGroupNames = registerBagGroups(program, { quietWhenMissing: !registry.expected || createsRegistry || staticCommand });

mark("main:bag-groups");

// ── Boundary check ───────────────────────────────────────────────────────────
// Command target is the registration boundary; package boundaries no longer split the CLI.

applyCommandTarget(program, target, bagGroupNames);

// `barry __describe` / `<identity> __describe`: this target's command surface as
// JSON, for generated reference docs (see describe.ts). Answered before parse()
// and the preAction hook, so it starts nothing and opens no store.
if (process.argv[2] === "__describe") {
  const { describeProgram } = await import("./describe.js");
  const json = `${JSON.stringify(describeProgram(program, target.kind, bagGroupNames), null, 2)}\n`;
  // Wait for the write: on a pipe stdout is asynchronous, and exiting first
  // truncates the output.
  await new Promise<void>((resolve) => process.stdout.write(json, () => resolve()));
  process.exit(0);
}

program.hook("preAction", async (_root, command) => {
  if (command.name() !== "__complete" && command.name() !== "completion") {
    await span("preaction:ensure-barry", () => command.parent?.name() === "session" && command.name() === "start" ? ensureBarryCore() : ensureBarry());
  }
  await span("preaction:instance-secret", () => useInstanceSecret());
  if (target.kind === "identity") {
    // `-i/--identity` is the one selector now (hidden in identity target). An
    // identity's own CLI is bound to that identity; naming another is a job
    // for that identity's generated CLI.
    const selected = command.optsWithGlobals().identity;
    if (selected !== undefined && selected !== target.name) throw new Error(`this CLI is bound to ${target.name}; use the other identity's generated CLI`);
    if (command.parent?.name() === "identity" && ["show", "test", "check", "delete"].includes(command.name()) && command.args[0] && command.args[0] !== target.name) throw new Error("cannot act on another identity");
    if (command.parent?.name() === "session" && command.name() !== "start") {
      const id = command.args[0];
      // Control commands resolve prefixes and check the resolved row's owner
      // themselves; looking up the raw prefix here rejects valid sessions.
      if (typeof id === "string" && id && !["list", "run", "prompt", "stop", "interrupt"].includes(command.name())) {
        const { getSession } = await import("@barry-rocks/sessions-bag/client");
        const { assertOwnedSession } = await import("./target.js");
        assertOwnedSession(await getSession(id), target.binding.id);
      }
    }
    // Cancellation must remain available even when model setup is broken or slow.
    const controlsSession = command.parent?.name() === "session" && ["stop", "interrupt"].includes(command.name());
    if (command !== start && !controlsSession) await span("preaction:models", () => initializeModels());
  }
});
setKnownCommands(program.commands.map((c) => c.name()));

// Bare `barry` with no arguments in system target shows the dashboard/help cleanly with exit 0.
if (target.kind === "system" && process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

// Catch `barry <typo> --help` (and `barry <typo>` on its own) before parse():
// Commander resolves `--help`/`-h` at the root before any action runs, so a
// guard living only inside the start action's resolveLaunchContext never sees
// the `--help` shape — that invocation fell through to root help with exit 0
// instead of reporting the unknown command.
//
// Only the LITERAL first argv token is inspected, deliberately not scanning
// past leading flags to find "the real first positional" — resolveLaunchContext
// never did that either (its args[0] is start's own first positional, i.e.
// this same rule already applied one level down), and a flag before a command
// name is not a shape Commander's default-command dispatch actually supports:
// `barry --name bux list` fails on unpatched master too (Commander binds
// `--name` to the default `start` command, so `list` becomes start's
// positional argument, not a separate command). Trying to out-guess that here
// by hand-skipping option values risks a hand-maintained list of "which flags
// take a value" drifting exactly like completion.ts's hardcoded array did —
// and was tried and reverted after it broke `barry --name bux --help`.
{
  const first = process.argv[2];
  // "help" is exempt: Commander adds its own implicit `help [command]` command
  // lazily, so it is not yet in `program.commands` (and so not in
  // `knownCommands`, populated just above) at this point — only at parse time.
  // Without this, `barry help` would misreport itself as unknown before
  // Commander ever gets to handle it.
  if (first && first !== "help" && !first.startsWith("-")) checkKnownCommand(first);
}

// Commander invokes async actions without awaiting them, so anything a command
// throws after its first await lands here rather than at `parse()`. Node's
// default for that is to dump the raw Error with its stack — node: internals,
// node_modules paths, a property dump — which reads as a crash even when the
// cause is something ordinary like a service not running.
//
// Deliberately NOT process.exit(0)-adjacent: the exit code stays non-zero so
// scripts and `&&` chains still see the failure. BARRY_DEBUG=1 restores the
// stack for debugging (see lib/error-message.ts).
process.on("unhandledRejection", (reason) => {
  console.error(`Error: ${errorMessage(reason)}`);
  if (!process.env.BARRY_DEBUG) {
    console.error("Run with BARRY_DEBUG=1 for the full stack trace.");
  }
  process.exit(1);
});

mark("main:parse-start");
try { await program.parseAsync(); }
catch (error) {
  if (isCliError(error)) {
    if (error.message) console.error(error.message);
    process.exitCode = error.exitCode;
  } else {
    console.error(`Error: ${errorMessage(error)}`);
    if (!process.env.BARRY_DEBUG) console.error("Run with BARRY_DEBUG=1 for the full stack trace.");
    process.exitCode = 1;
  }
}
