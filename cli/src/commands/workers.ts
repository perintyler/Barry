import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { decodeJoinToken, encodeJoinToken, installationRegistry, NodeRegistry, ownerUrl } from "@barry-rocks/sdk/internal/nodes";
import { ownerCall, WorkerCredentialRejected } from "@barry-rocks/sdk/internal/workflows";

const RESTART = "Restart the workflows service to apply it: `barry service restart workflows.runtime`.";

function inviteToken(registry: NodeRegistry, worker: { id: string; name: string; jobs: string[] | null; inviteExpiresAt: number | null }, credential: string, url: string): string {
  const fields = { owner: registry.id, name: worker.name, worker: worker.id, url, credential };
  if (worker.jobs === null && worker.inviteExpiresAt === null) return encodeJoinToken({ v: 1, ...fields });
  return encodeJoinToken({ v: 2, ...(worker.jobs === null ? {} : { jobs: worker.jobs }), ...(worker.inviteExpiresAt === null ? {} : { expiresAt: worker.inviteExpiresAt }), ...fields });
}

/** Ask the owner who it is with the joined credential; the answer must name the owner the token names. */
async function verifyOwner(url: string, credential: string, owner: string): Promise<{ reached: true } | { reached: false; reason: string }> {
  try {
    const response = await ownerCall(url, credential)({ version: 2, operation: "hello", session: randomUUID() });
    const answered = response && typeof response === "object" && "owner" in response ? String(response.owner) : undefined;
    if (answered !== owner) throw new Error(`the owner at ${url} is installation ${answered ?? "unknown"}, not ${owner}; this token was issued elsewhere`);
    return { reached: true };
  } catch (error) {
    if (error instanceof WorkerCredentialRejected) throw new Error(`the owner at ${url} refused this token's credential; ask for a new one with \`barry workers invite\``);
    if (error instanceof Error && error.message.includes("issued elsewhere")) throw error;
    return { reached: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function registerWorkers(program: Command): void {
  const workers = program.command("workers").description("Machines that run this Barry's workflow activities, and the owners this machine works for");
  workers.command("invite <name>")
    .description("Invite a machine to run workflow activities for this Barry; prints a join token, shown once")
    .option("--url <url>", "The https address the worker should call (default: the route hosting.yaml publishes for workflows.runtime)")
    .option("--jobs <jobs>", "Comma-separated versioned jobs this worker may claim (default: any advertised job)")
    .option("--expires-in <seconds>", "Expire an unused invite after this many seconds (default: no expiry for unscoped legacy-compatible tokens; 86400 for scoped tokens)")
    .action(async (name: string, options: { url?: string; jobs?: string; expiresIn?: string }) => {
      const expiryMs = options.expiresIn === undefined ? (options.jobs === undefined ? null : 86_400_000) : Number(options.expiresIn) * 1000;
      if (expiryMs !== null && (!/^[1-9][0-9]*$/.test(options.expiresIn ?? "86400") || !Number.isSafeInteger(expiryMs))) throw new Error("--expires-in must be a positive whole number of seconds");
      const { workflowsUrl } = await import("./workers-url.js");
      const url = ownerUrl(options.url ?? await workflowsUrl());
      const registry = installationRegistry();
      const { worker, credential } = registry.inviteWorker(name, options.jobs === undefined ? null : options.jobs.split(","), "local-operator", expiryMs);
      console.log(`Invited ${worker.name} (worker ${worker.id}). On that machine, run:\n`);
      console.log(`  barry workers join ${inviteToken(registry, worker, credential, url)}\n`);
      console.log("The token is a credential: anyone holding it can claim work as this worker. Revoke it with `barry workers revoke " + worker.name + "`.");
    });
  workers.command("join <token>")
    .description("Join an owner as one of its workers, from the token `barry workers invite` printed there")
    .action(async (text: string) => {
      const token = decodeJoinToken(text);
      if (token.v === 1) console.log("Version 1 token: compatible with older workers; no job scope or invite expiry.");
      const registry = installationRegistry();
      const check = await verifyOwner(token.url, token.credential, token.owner);
      const owner = registry.join({ id: token.owner, name: new URL(token.url).host, url: token.url, workerId: token.worker, jobs: token.jobs }, token.credential);
      console.log(`Joined ${owner.url} as worker ${token.name} (${token.worker}).`);
      if (!check.reached) console.log(`Could not reach the owner yet (${check.reason}); the workflows service keeps retrying.`);
      console.log(RESTART);
    });
  workers.command("list")
    .description("Workers this Barry invited, and owners this machine joined")
    .option("--json", "Print as JSON")
    .action((options: { json?: boolean }) => {
      const registry = installationRegistry();
      const listing = { installation: registry.id, workers: registry.workers(), owners: registry.owners(), audit: registry.audits() };
      if (options.json) { console.log(JSON.stringify(listing, null, 2)); return; }
      console.log(`This installation: ${listing.installation}`);
      console.log(listing.workers.length ? "\nWorkers (machines that run this Barry's activities):" : "\nNo invited workers.");
      for (const worker of listing.workers) console.log(`  ${worker.name}  ${worker.id}  invited ${worker.createdAt}${worker.joinedAt === null ? `; pending, expires ${worker.inviteExpiresAt === null ? "never (legacy)" : new Date(worker.inviteExpiresAt).toISOString()}` : "; joined"}; jobs ${worker.jobs?.join(",") ?? "all"}`);
      console.log(listing.owners.length ? "\nOwners (installations this machine works for):" : "\nNot a worker of any other installation.");
      for (const owner of listing.owners) console.log(`  ${owner.url}  owner ${owner.id}  as worker ${owner.workerId}`);
    });
  workers.command("status")
    .description("The bag jobs this machine can run for an owner, and why any are not offered")
    .action(async () => {
      const { installationJobs, unmetRequirement, workerLabels } = await import("@barry-rocks/sdk/internal/workflows");
      const { bounds } = await import("@barry-rocks/identities-bag");
      const { installationEnvironment } = await import("../services/installation-environment.js");
      const { platform, arch } = await import("node:os");
      // The service's labels: its barry.yaml override when one is set, else this shell's.
      const configured = installationEnvironment("workflows.runtime", [{ name: "BARRY_WORKFLOW_LABELS", source: "value", value: process.env.BARRY_WORKFLOW_LABELS ?? "" }]).find(entry => entry.name === "BARRY_WORKFLOW_LABELS")?.value;
      const labels = workerLabels(configured, { os: platform(), arch: arch() });
      const inventory = await installationJobs(async name => await bounds.get({ name }));
      for (const owner of installationRegistry().owners()) console.log(`Owner ${owner.url}: job scope ${owner.jobs?.join(", ") ?? "all advertised jobs"}`);
      console.log(`Labels: ${Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(", ")}`);
      console.log(inventory.jobs.length ? "\nJobs this machine can run for an owner:" : "\nNo installed job can run on another machine.");
      for (const job of inventory.jobs) {
        const unmet = unmetRequirement(job, labels);
        console.log(`  ${job.type}  ${unmet ? `not offered: it ${unmet}` : "offered"}`);
      }
      if (inventory.skipped.length) console.log("\nVersioned jobs that run only where they are started:");
      for (const skipped of inventory.skipped) console.log(`  ${skipped.type}  ${skipped.reason}`);
    });
  workers.command("rotate <worker>")
    .description("Issue a worker a new credential; the old one keeps working for five minutes")
    .option("--url <url>", "The https address the worker should call")
    .action(async (name: string, options: { url?: string }) => {
      const { workflowsUrl } = await import("./workers-url.js");
      const registry = installationRegistry();
      const worker = registry.worker(name);
      const url = ownerUrl(options.url ?? await workflowsUrl());
      const rotated = registry.rotateCredential(worker.id);
      console.log(`New token for ${worker.name}; run this on it within five minutes:\n`);
      console.log(`  barry workers join ${inviteToken(registry, worker, rotated.secret, url)}\n`);
    });
  workers.command("revoke <worker>")
    .description("Remove a worker; its next call to this Barry is refused and its running activities stop")
    .action((name: string) => {
      const worker = installationRegistry().revokeWorker(name);
      console.log(`Revoked ${worker.name} (${worker.id}). Activities it still holds are retried elsewhere when their leases expire.`);
    });
  workers.command("leave <owner>")
    .description("Stop working for an owner this machine joined")
    .action((name: string) => {
      const owner = installationRegistry().leave(name);
      console.log(`Left ${owner.url}. The owner still lists this machine until it runs \`barry workers revoke\`. ${RESTART}`);
    });
}
