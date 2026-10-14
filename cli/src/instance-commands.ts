/**
 * The commands that run and install a Barry instance: `up`, `setup`,
 * `service`, `hosting`, `env` and `db`.
 *
 * Registered from one place so the work that builds each one edits only its
 * own module. An instance is something anyone who installs Barry has, so these
 * sit at the root rather than under `devops`, which is contributor tooling.
 */
import type { Command } from "commander";
import {
  stopCommand,
  startCommand as serviceStartCommand,
  serviceRestartCommand,
  servicePortCommand,
  statusCommand,
  serviceUrlCommand,
} from "./commands/service.js";
import { logsCommand } from "./commands/logs.js";
import { dbBackupCommand } from "./commands/db.js";
import { envAuditCommand } from "./commands/env.js";
import { statusOverviewCommand } from "./commands/status.js";
import { storeListCommand, storeVerifyCommand } from "./commands/store.js";

export function registerInstanceCommands(program: Command): void {
  program
    .command("status")
    .description("Show operational status of services, stores, and schedules")
    .option("--json", "Print status as JSON, for scripts")
    .option("--full", "Show all stores and resources without truncation")
    .action((options: { json?: boolean; full?: boolean }) => statusOverviewCommand(options));

  const store = program
    .command("store")
    .description("Inspect and verify Barry stores (SQLite databases)");
  store
    .command("list")
    .description("List all active stores, sizes, WAL status and migration versions")
    .option("--json", "Print store list as JSON")
    .action((options: { json?: boolean }) => storeListCommand(options));
  store
    .command("verify")
    .description("Verify SQLite integrity and healthy WAL limits for all stores")
    .option("--deep", "Perform deep integrity checks")
    .option("--json", "Print verification results as JSON")
    .action((options: { deep?: boolean; json?: boolean }) => storeVerifyCommand(options));
  store
    .command("migrate")
    .description("Split a legacy install's stores into per-node and per-identity stores, keeping the originals")
    .requiredOption("--services-stopped", "Confirm this instance's services have been stopped")
    .option("--id <id>", "Resume an archived migration with this ID")
    .action(async (options: { servicesStopped: boolean; id?: string }) => {
      const { storeMigrateCommand } = await import("./commands/store-migrate.js");
      await storeMigrateCommand(options);
    });

  store
    .command("remove-originals")
    .description("Delete the legacy store files barry store migrate kept, once the active generation holds their data; their archived copies stay")
    .option("--report <path>", "The migration report to act on (default: the one in this instance's archives)")
    .option("--dry-run", "Print what would be removed and what is kept, and change nothing")
    .option("--yes", "Remove without an interactive confirmation")
    .action(async (options: { report?: string; dryRun?: boolean; yes?: boolean }) => {
      const { storeRemoveOriginalsCommand } = await import("./commands/store-remove-originals.js");
      await storeRemoveOriginalsCommand(options);
    });

  program
    .command("up")
    .description("Start registered enabled services through launchd")
    .action(async () => {
      const { assertLaunchd } = await import("./lib/platform.js");
      assertLaunchd();
      const { startInstalledServices } = await import("./services/barry.js");
      await startInstalledServices();
    });

  program
    .command("down")
    .description("Stop registered services without changing automatic startup")
    .action(async () => {
      const { assertLaunchd } = await import("./lib/platform.js");
      assertLaunchd();
      const { stopInstalledServices } = await import("./services/barry.js");
      await stopInstalledServices();
    });

  program
    .command("setup")
    .description(
      "Install this instance: its CLI, apps, configuration, and declared service registrations",
    )
    .option("--dry-run", "Print what setup (or --system) would change, and change nothing")
    .option("-y, --yes", "Skip confirmation prompts")
    .option("--system", "Install the services that run as their own account, as LaunchDaemons (needs sudo)")
    .option("--link <checkout>", "Point this instance's current installation at a Barry checkout, then set up from it")
    .option("--no-start", "Prepare service registrations without starting them")
    .option("--owner <actor-id>", "Bind an existing user as this installation's owner")
    .option(
      "--app <bag.App>",
      "Rebuild this app from source and reinstall it (repeatable)",
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .action(
      async (opts: {
        link?: string;
        dryRun?: boolean;
        yes?: boolean;
        system?: boolean;
        start?: boolean;
        owner?: string;
        app: string[];
      }) => {
        const { setupCommand } = await import("./commands/setup.js");
        await setupCommand({
          link: opts.link,
          dryRun: opts.dryRun,
          yes: opts.yes,
          system: opts.system,
          start: opts.start,
          owner: opts.owner,
          apps: opts.app,
        });
      },
    );

  program
    .command("upgrade")
    .description("Move this instance onto the release this barry belongs to: snapshot, migrate a copy of the stores when their schemas change, switch, restart and verify")
    .option("--rollback", "Return to the release or linked checkout the last upgrade replaced")
    .option("--yes", "Upgrade without an interactive confirmation")
    .action(async (options: { yes?: boolean; rollback?: boolean }) => {
      const { upgradeCommand } = await import("./releases/upgrade.js");
      try { await upgradeCommand(options); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    });

  program
    .command("uninstall")
    .description(
      "Uninstall Barry: stop services, remove launchd agents, and delete shims",
    )
    .option(
      "--purge",
      "Permanently remove all Barry databases, conversation history, and configs",
    )
    .option(
      "--dry-run",
      "Preview files and services that would be removed without making changes",
    )
    .option("-y, --yes", "Skip interactive confirmation prompts")
    .option(
      "--system",
      "Also unload system-level LaunchDaemons (requires sudo)",
    )
    .option("--json", "Print uninstallation summary as JSON")
    .action(
      async (opts: {
        purge?: boolean;
        dryRun?: boolean;
        yes?: boolean;
        system?: boolean;
        json?: boolean;
      }) => {
        const { uninstallCommand } = await import("./commands/uninstall.js");
        await uninstallCommand(opts);
      },
    );

  const service = program
    .command("service")
    .description("See and control this instance's services");
  // Every service verb refuses a fresh instance with the one shared message
  // and exit code 3 (see lib/require-instance.ts), so status/service/app/hosting
  // agree before any of them touch a missing registry.
  service.hook("preAction", async () => {
    const { requireInstance } = await import("./lib/require-instance.js");
    await requireInstance();
  });
  service
    .command("status [services...]")
    .description(
      "Show services (all, or the named ones or bags): state, port, health. Non-zero when one needs attention",
    )
    .option("--json", "Print service management status as JSON, for scripts")
    .action((names: string[], options: { json?: boolean }) =>
      statusCommand(names, options),
    );
  service
    .command("list")
    .description("List declared services and their management state")
    .option("--json")
    .action(async (options: { json?: boolean }) => {
      const { serviceListCommand } = await import(
        "./commands/service-management.js"
      );
      await serviceListCommand(options);
    });
  const serviceVerbDescriptions: Record<"add" | "remove" | "enable" | "disable", string> = {
    add: "Register a service (disabled unless already enabled); does not start it",
    remove: "Unregister a service and remember the removal; stops it but keeps its software and data",
    enable: "Enable a service's launch at next login/boot; does not start it unless --now",
    disable: "Disable a service's launch at next login/boot; keeps it running unless --now",
  };
  for (const operation of ["add", "remove", "enable", "disable"] as const) {
    service
      .command(`${operation} <service>`)
      .description(serviceVerbDescriptions[operation])
      .option("--now", "Also start or stop now")
      .action(async (name: string, options: { now?: boolean }) => {
        const { serviceManageCommand } = await import(
          "./commands/service-management.js"
        );
        await serviceManageCommand(name, operation, options);
      });
  }
  service
    .command("run <service>")
    .description("Run one prepared service in the foreground")
    .action(async (name: string) => {
      const { serviceRunCommand } = await import(
        "./commands/service-management.js"
      );
      await serviceRunCommand(name);
    });
  service
    .command("url <service>")
    .description("Print where a service listens, for scripts")
    .action(serviceUrlCommand);
  service
    .command("start [services...]")
    .description("Start named services or bags; all starts enabled, registered user services that are not running")
    .action(serviceStartCommand);
  service
    .command("stop [services...]")
    .description("Stop named services or bags; all stops running, enabled user services")
    .action(stopCommand);
  service
    .command("restart [services...]")
    .description("Restart named services or bags; all restarts running, enabled user services except apps")
    .option("--dry-run", "Print what would restart, without restarting")
    .action(serviceRestartCommand);
  service
    .command("logs [service]")
    .description("Show a service's logs")
    .option("-f, --follow", "Follow logs in real time")
    .option("-n, --lines <number>", "Number of lines to show", "50")
    .option("--stderr", "Show stderr instead of stdout")
    .option(
      "--rotate",
      "Rotate a stopped service log, retaining three archives",
    )
    .action(logsCommand);
  service
    .command("port <service> <port>")
    .description(
      "Move a service to another port, and wait until every route that targets it follows",
    )
    .action(servicePortCommand);

  const app = program
    .command("app")
    .description("See and open this instance's registered GUI apps");
  app.hook("preAction", async () => {
    const { requireInstance } = await import("./lib/require-instance.js");
    await requireInstance();
  });
  app
    .command("list")
    .description(
      "Show registered apps: id, display name, protocol version, and capabilities",
    )
    .option("--json", "Print the registered apps as JSON, for scripts")
    .action(async (options: { json?: boolean }) => {
      const { appListCommand } = await import("./commands/app.js");
      await appListCommand(options);
    });
  app
    .command("url <app>")
    .description("Print where an app is reached or its deep link scheme")
    .option("--session <id>", "Append session id to deep link")
    .action(async (name: string, options: { session?: string }) => {
      const { appUrlCommand } = await import("./commands/app.js");
      await appUrlCommand(name, options);
    });

  const hosting = program
    .command("hosting")
    .description(
      "What this instance exposes, where, and whether it is applied",
    );
  hosting.hook("preAction", async () => {
    const { requireInstance } = await import("./lib/require-instance.js");
    await requireInstance();
  });
  hosting
    .command("status [service]")
    .description(
      "Each route's address, provider, reach and gate, wanted target beside applied",
    )
    .option("--public", "Only what is reachable from the internet")
    .action(
      async (service: string | undefined, options: { public?: boolean }) => {
        const { hostingStatusCommand } = await import("./commands/hosting.js");
        await hostingStatusCommand(service, options);
      },
    );

  const env = program
    .command("env")
    .description("This instance's secrets file");
  env
    .command("set <key>")
    .description(
      "Set a key in the instance env (value read from stdin, never the command line)",
    )
    .action(async (key: string) => {
      const { envSetCommand } = await import("./commands/env-set.js");
      await envSetCommand(key);
    });
  env
    .command("audit")
    .description(
      "Keys declared but missing, and keys present that nothing declares",
    )
    .action(envAuditCommand);

  const db = program
    .command("db")
    .description("Back up, restore, roll back, recover or prune the stores this instance runs on");
  db.command("backup [destination]")
    .description("Back up every store and the vault")
    .option(
      "--vault",
      "Include the machine's vault even when BARRY_HOME names another instance",
    )
    .action(dbBackupCommand);
  db.command("rollback")
    .description("Make the store generation that was active before this one active again")
    .option("--yes", "Roll back without an interactive confirmation")
    .action(async (options: { yes?: boolean }) => {
      const { dbRollbackCommand } = await import("./commands/db-rollback.js");
      await dbRollbackCommand(options);
    });
  db.command("recover")
    .description("Finish a store generation switch that was interrupted, or undo it when it cannot finish")
    .action(async () => {
      const { dbRecoverCommand } = await import("./commands/db-recover.js");
      await dbRecoverCommand();
    });
  db.command("prune")
    .description("Delete store generations older than the active one and the one before it")
    .option("--yes", "Prune without an interactive confirmation")
    .action(async (options: { yes?: boolean }) => {
      const { dbPruneCommand } = await import("./commands/db-prune.js");
      await dbPruneCommand(options);
    });
  db.command("restore <directory>")
    .description("Restore a `barry db backup` into a new store generation and switch to it")
    .option("--replace-installation", "Restore onto a home with a different installation id, making it the backup's installation")
    .action(async (directory: string, options: { replaceInstallation?: boolean }) => {
      const { dbRestoreCommand } = await import("./commands/db-restore.js");
      await dbRestoreCommand(directory, options);
    });
}
