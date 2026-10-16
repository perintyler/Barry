import {
  optionalIdentityBags,
  parseBounds,
  requiredIdentityBags,
  requiredNames,
} from "@barry-rocks/sdk/internal/identities";
import { currentInstallation } from "../releases/current.js";
import { serviceRequest, type ServiceStatus } from "@barry-rocks/mcp-bag";
import { listStores } from "@barry-rocks/sdk/internal/stores";
import { listSchedules } from "@barry-rocks/schedules-bag";
import { listStates } from "@barry-rocks/schedules-bag";
import { summarizeSchedule } from "@barry-rocks/schedules-bag";
import { identityRecords } from "@barry-rocks/identities-bag";
import { currentTarget } from "../target.js";
import { ownsSchedule } from "../resource-target.js";
import { bold, dim, green, red } from "../lib/ansi.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function serviceAlarm(s: ServiceStatus): string | null {
  if (s.state === "conflict") return `port ${s.port} held by ${s.conflict ?? "another program"}`;
  if (s.problem) return s.problem;
  if (s.loopbackOnly === false) return "listening beyond loopback";
  if (s.state === "backoff") return `restarting (exited ${s.restarts} times)`;
  if (s.state === "running" && s.health === "failing") return "health check failing";
  return null;
}

export async function statusOverviewCommand(options: { json?: boolean; full?: boolean } = {}): Promise<void> {
  // One answer to "is this instance set up?", shared with service/app/hosting.
  // A fresh instance refuses with exit 3; --json reports it as data so scripts
  // can branch on it rather than parse an error.
  const { isInstanceSetUp, requireInstance } = await import("../lib/require-instance.js");
  if (!(await isInstanceSetUp())) {
    if (options.json) {
      console.log(JSON.stringify({ setUp: false }, null, 2));
      return;
    }
    await requireInstance();
  }

  const target = currentTarget();
  const installation = currentInstallation();

  let services: ServiceStatus[] = [];
  let instanceId = "";
  try {
    const reply = await serviceRequest({ op: "status" });
    instanceId = reply.instance.id;
    services = reply.services;
  } catch {
    // Service control may be down
  }

  const allStores = await listStores();

  type ScheduleSummary = ReturnType<typeof summarizeSchedule> & { identity?: string };
  let schedulesList: ScheduleSummary[] = [];
  try {
    const { schedules } = await listSchedules();
    const states = listStates();
    schedulesList = schedules.map(s => ({
      ...summarizeSchedule(s, states.get(s.id)),
      identity: s.schedule.identity,
    }));
  } catch {
    // No schedules store yet: report none.
  }

  let identitiesList: Array<{ id: number; name: string; bags: string[]; bounds: string[] }> = [];
  try {
    identitiesList = (await identityRecords.list()).map(({ record }) => {
      const config = identityRecords.config(record);
      const bags = [
        ...new Set([
          ...requiredIdentityBags(config.bags, config.bag_configs),
          ...optionalIdentityBags(config.bags, config.bag_configs),
        ]),
      ];
      return {
        id: record.id,
        name: record.name,
        bags,
        bounds: requiredNames(parseBounds(record.metadata.bounds)),
      };
    });
  } catch {
    // No identities store or no owner yet: report none.
  }

  let filteredServices = services;
  let filteredStores = allStores;
  let filteredSchedules = schedulesList;

  if (target.kind === "identity") {
    const idObj = identitiesList.find(i => i.name === target.name);
    const packedBags = new Set(idObj?.bags ?? []);
    // Identity sees services belonging to its packed bags + shared core
    filteredServices = services.filter(s => s.bag === "mcp" || s.bag === "sessions" || packedBags.has(s.bag));
    // Identity sees stores owned by it or shared node stores
    filteredStores = allStores.filter(s => s.scope === "node" || s.identityName === target.name);
    // Identity sees schedules it owns
    filteredSchedules = schedulesList.filter(s => ownsSchedule(s.identity));
  }

  if (options.json) {
    console.log(JSON.stringify({
      scope: target.kind,
      identity: target.kind === "identity" ? target.name : undefined,
      instance: instanceId,
      installation,
      releases: (await import("../releases/state.js")).releaseState(),
      services: filteredServices,
      stores: filteredStores,
      schedules: filteredSchedules,
      identities: target.kind === "system" ? identitiesList : undefined,
    }, null, 2));
    return;
  }

  const header = target.kind === "identity"
    ? `Identity Status: ${bold(target.name)} (id: ${target.binding.id})`
    : `Barry System Status · instance ${dim(instanceId)}`;

  console.log();
  console.log(`  ${bold(header)}`);
  const commit = installation.commit ?? "unknown commit";
  const description = installation.kind === "missing"
    ? red(`current points at ${installation.target}, which does not exist`)
    : installation.kind === "release"
      ? installation.current ? `release ${installation.version}` : `release ${installation.version} at ${installation.root}, not set up: run barry setup`
      : installation.kind === "link" ? `linked checkout at ${installation.target} (${commit})` : `checkout at ${installation.root} (${commit})`;
  console.log(`  ${description}`);
  const releases = (await import("../releases/state.js")).releaseState();
  const { installationLabel } = await import("../releases/receipts.js");
  if (releases.previous) console.log(`  previous: ${installationLabel(releases.previous)}`);
  if (releases.lastChange) {
    const change = releases.lastChange;
    console.log(`  last change: ${change.kind} from ${installationLabel(change.from)} to ${installationLabel(change.to)}, ${change.time}`);
  }
  if (releases.interrupted) {
    const change = releases.interrupted;
    console.log(`  ${red(`${change.kind} to ${installationLabel(change.to)} interrupted at ${change.started}: run barry upgrade${change.kind === "rollback" ? " --rollback" : ""} again`)}`);
  }
  console.log(`  ${dim("─".repeat(70))}`);

  const runningServices = filteredServices.filter(s => s.state === "running").length;
  console.log();
  console.log(`  ${bold("Services")} ${dim(`(${runningServices}/${filteredServices.length} running)`)}`);
  for (const s of filteredServices.sort((a, b) => a.key.localeCompare(b.key))) {
    const problem = serviceAlarm(s);
    const up = s.state === "running";
    const mark = problem ? red("✗") : up ? green("●") : dim("○");
    const port = s.port !== undefined ? String(s.port).padStart(5) : "     ";
    const state = s.state === "stopped" && s.autostart === "manual" ? "stopped (manual)" : s.state;
    const note = problem ? red(problem) : up ? dim(`pid ${s.pid} · health ${s.health}`) : "";
    console.log(`    ${mark} ${s.key.padEnd(25)} ${port}  ${up ? state : dim(state)}  ${note}`);
  }

  console.log();
  console.log(`  ${bold("Stores")} ${dim(`(${filteredStores.length} stores)`)}`);
  for (const s of filteredStores.slice(0, options.full ? undefined : 8)) {
    const scopeTag = s.scope === "node" ? "[node]" : `[id:${s.identityName ?? s.identityId}]`;
    const label = `${scopeTag} ${s.bag}:${s.store}`.padEnd(32);
    const size = formatBytes(s.bytes).padStart(8);
    console.log(`    ● ${label} ${size}  ${dim(`ver: ${s.version}`)}`);
  }
  if (!options.full && filteredStores.length > 8) {
    console.log(`    ${dim(`... and ${filteredStores.length - 8} more (pass --full or \`barry store list\` to see all)`)}`);
  }

  if (filteredSchedules.length > 0) {
    console.log();
    console.log(`  ${bold("Schedules")} ${dim(`(${filteredSchedules.length} active)`)}`);
    for (const sc of filteredSchedules.slice(0, 5)) {
      const mark = !sc.enabled || sc.paused ? dim("○") : sc.consecutive_failures > 0 ? red("✗") : green("●");
      const idLabel = sc.identity ? `${sc.identity}/` : "";
      console.log(`    ${mark} ${idLabel}${sc.id.padEnd(24)} ${dim(sc.trigger)} → ${sc.action}`);
    }
    if (filteredSchedules.length > 5) {
      console.log(`    ${dim(`... and ${filteredSchedules.length - 5} more`)}`);
    }
  }

  if (target.kind === "system" && identitiesList.length > 0) {
    console.log();
    console.log(`  ${bold("Identities")} ${dim(`(${identitiesList.length} configured)`)}`);
    for (const id of identitiesList) {
      const bagsInfo = id.bags.length > 0 ? `packed: ${id.bags.slice(0, 4).join(", ")}${id.bags.length > 4 ? "..." : ""}` : "no bags";
      console.log(`    • ${bold(id.name.padEnd(14))} ${dim(`(id: ${id.id} · ${bagsInfo})`)}`);
    }
  }

  console.log();
}
