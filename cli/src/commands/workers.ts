import type { Command } from "commander";
import { lazy } from "../lib/lazy.js";

export function registerWorkers(program: Command): void {
  const workers = program.command("workers").description("Machines that run this Barry's workflow activities, and the owners this machine works for");
  workers.command("invite <name>")
    .description("Invite a machine to run workflow activities for this Barry; prints a join token, shown once")
    .option("--url <url>", "The https address the worker should call (default: the route hosting.yaml publishes for workflows.runtime)")
    .option("--jobs <jobs>", "Comma-separated versioned jobs this worker may claim (default: any advertised job)")
    .option("--expires-in <seconds>", "Expire an unused invite after this many seconds (default: no expiry for unscoped legacy-compatible tokens; 86400 for scoped tokens)")
    .action(lazy(() => import("./workers-actions.js"), module => module.inviteWorkerCommand));
  workers.command("join <token>")
    .description("Join an owner as one of its workers, from the token `barry workers invite` printed there")
    .action(lazy(() => import("./workers-actions.js"), module => module.joinOwnerCommand));
  workers.command("list")
    .description("Workers this Barry invited, and owners this machine joined")
    .option("--json", "Print as JSON")
    .action(lazy(() => import("./workers-actions.js"), module => module.listWorkersCommand));
  workers.command("status")
    .description("The bag jobs this machine can run for an owner, and why any are not offered")
    .action(lazy(() => import("./workers-actions.js"), module => module.workerStatusCommand));
  workers.command("rotate <worker>")
    .description("Issue a worker a new credential; the old one keeps working for five minutes")
    .option("--url <url>", "The https address the worker should call")
    .action(lazy(() => import("./workers-actions.js"), module => module.rotateWorkerCommand));
  workers.command("revoke <worker>")
    .description("Remove a worker; its next call to this Barry is refused and its running activities stop")
    .action(lazy(() => import("./workers-actions.js"), module => module.revokeWorkerCommand));
  workers.command("leave <owner>")
    .description("Stop working for an owner this machine joined")
    .action(lazy(() => import("./workers-actions.js"), module => module.leaveOwnerCommand));
}
