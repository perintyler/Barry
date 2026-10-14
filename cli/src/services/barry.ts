import { installationRoot, writeServiceRegistry, type ServiceEntry, barryAppSupportDir, bagLogsDir, readServiceRegistry, readHostingPolicy } from "@barry-rocks/sdk/services";
import { systemPaths, systemDefinition, isSystemService } from "./system.js";
import {
  listBagNames,
  seedBagRegistry,
  shippedRegistryEntries,
  writeRegistrySnapshot,
} from "../bags/registration.js";
import { isAbsolute } from "node:path";
import { discoverBuiltinBags, loadAllBags, loadRegistry } from "@barry-rocks/sdk/internal/bags";
import {
  buildServiceSpecs,
  retainUnreadableBagServices,
  type ServiceSpec,
} from "./specs.js";
import { assignPorts } from "./ports.js";
import { openInstance, instanceOwnerHome, stableNodePath, installedCommand, installedProgramPath } from "@barry-rocks/sdk/internal/services";
import { serviceOS, type ServiceOS } from "@barry-rocks/mcp-bag";
import {
  ServiceManagement,
  type ServiceChoice,
  type ServiceDefinition,
} from "@barry-rocks/mcp-bag";
import { dirname, join } from "node:path";
import {
  mkdirSync,
  renameSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { readAssignments, moveAssignment } from "./ports.js";
import { resolveHosting } from "./hosting/resolve.js";
import {
  publishHostingPlan,
  waitForRoutes,
} from "./hosting/publish.js";

export async function prepareBagRegistry(): Promise<void> {
  const { traits } = await import("@barry-rocks/identities-bag");
  let names: string[] = [];
  const previous = process.env.BARRY_CONFIG_ALLOW_EMPTY;
  process.env.BARRY_CONFIG_ALLOW_EMPTY = "1";
  try {
    names = await listBagNames();
    if (names.length === 0) {
      const seeded = await seedBagRegistry(shippedRegistryEntries());
      console.log(
        `seeded a fresh instance with ${seeded.builtins} shipped bags`,
      );
    }
    if (names.length > 0) {
      // Add the builtin bags this instance lacks, and re-anchor the ones whose
      // folder moved: Barry stores a builtin's path relative to bags/, and a
      // stale one names a folder that no longer exists. Only such a relative
      // row is Barry's to rewrite; an absolute or ~ path is a user's override
      // of a builtin name (the row keeps its builtin flag), and stays.
      const { getBag, upsertBag } = await import("../bags/registration.js");
      const shippedPaths = discoverBuiltinBags().local;
      for (const [name, source] of Object.entries(shippedRegistryEntries())) {
        const row = names.includes(name) ? await getBag(name) : null;
        if (!row) {
          await upsertBag(name, source, { builtin: true });
          continue;
        }
        const storedPath = row.source.type === "local" ? row.source.path : undefined;
        const anchoredHere = storedPath !== undefined && !isAbsolute(storedPath) && !storedPath.startsWith("~");
        if (row.builtin && anchoredHere && storedPath !== shippedPaths[name]) await upsertBag(name, source);
      }
    }
    // Insert-when-absent, so a machine's tuned bound is never overwritten and a
    // bound Barry starts shipping reaches an existing instance too.
    const bags = await loadAllBags();
    const builtinNames = new Set(Object.keys(shippedRegistryEntries()));
    const declared = bags.filter(bag => builtinNames.has(bag.name) && (bag.manifest?.bounds || bag.manifest?.jobs || bag.name === "bash")).map(bag => bag.name);
    await traits.syncBags(declared, { strict: true });
  } finally {
    if (previous === undefined) delete process.env.BARRY_CONFIG_ALLOW_EMPTY;
    else process.env.BARRY_CONFIG_ALLOW_EMPTY = previous;
  }
  await writeRegistrySnapshot();
}











/**
 * The earlier definitions to keep beside the current ones: a service its bag no
 * longer declares stays while launchd may still hold it, so `barry service
 * remove` can unload it. Once removed (and no operation left pending), nothing
 * on the machine names it, and keeping it would list a service that no longer
 * exists and shadow the name it was renamed to.
 */
export function retainedDefinitions(
  previous: readonly ServiceDefinition[],
  current: readonly ServiceDefinition[],
  choice: (name: string) => ServiceChoice,
): ServiceDefinition[] {
  return previous.filter((definition) => {
    if (current.some((kept) => kept.name === definition.name)) return false;
    const recorded = choice(definition.name);
    return recorded.registered || recorded.pending !== undefined;
  });
}

/** Application boundary: default-instance discovery and installed implementations live here. */
export async function installedServices(
  options: { prepare?: boolean; refresh?: boolean; os?: ServiceOS } = {},
): Promise<ServiceManagement> {
  if ((options.prepare || options.refresh) && process.getuid?.() === 0) throw new Error("service preparation must run as the instance owner, not root");
  if (options.prepare) await prepareBagRegistry();
  const instance = openInstance(barryAppSupportDir());
  const managedPath = join(instance.home, "managed-definitions.json");
  if (!options.prepare && !options.refresh) {
    const definitions = existsSync(managedPath)
      ? (JSON.parse(readFileSync(managedPath, "utf8")) as ServiceDefinition[])
      : [];
    return new ServiceManagement(
      instance,
      definitions,
      options.os ?? serviceOS(),
    );
  }
  const ownerHome = instanceOwnerHome(instance);
  const previousDefinitions = existsSync(managedPath)
    ? (JSON.parse(readFileSync(managedPath, "utf8")) as ServiceDefinition[])
    : [];
  const bags = await loadAllBags();
  const { specs, problems } = buildServiceSpecs(bags, loadRegistry(), (bag, key) => systemPaths(instance, bag, key).state);
  if (problems.length)
    throw new Error(
      problems
        .map((problem) => `${problem.key}: ${problem.message}`)
        .join("\n"),
    );
  const preparedPath = join(instance.home, "service-definitions.json");
  const retained = retainUnreadableBagServices(
    bags,
    specs,
    existsSync(preparedPath)
      ? (JSON.parse(readFileSync(preparedPath, "utf8")) as Record<string, ServiceSpec & { port?: number }>)
      : {},
  );
  if (retained.length)
    console.warn(
      `warning: kept the prepared services of bags whose manifest could not be read: ${retained.map((spec) => spec.key).join(", ")}`,
    );
  specs.push(...retained);
  const ports = await assignPorts(
    specs.filter((spec) => spec.serves && !spec.socket),
  );
  const definitions: ServiceDefinition[] = [];
  const resources: Record<string, ServiceEntry> = {};
  const prepared: Record<string, unknown> = {};
  const root = installationRoot();
  for (const spec of specs) {
    const previous = previousDefinitions.find(
      (definition) => definition.name === spec.key,
    );
    const domain = spec.user
      ? "system"
      : `gui/${instance.uid ?? process.getuid?.() ?? 501}`;
    definitions.push(spec.user ? systemDefinition(spec, systemPaths(instance, spec.bag, spec.key)) : {
      name: spec.key,
      directory: spec.cwd,
      domain,
      plistDirectory: spec.user
        ? "/Library/LaunchDaemons"
        : (previous?.plistDirectory ??
          join(ownerHome, "Library", "LaunchAgents")),
      logDirectory: bagLogsDir(spec.bag),
      shutdownMs: spec.shutdownMs ?? 40000,
      user: spec.user,
      command: [...installedCommand("barry-service").argv, instance.home, spec.key],
      environment: {
        HOME: ownerHome,
        PATH: [
          dirname(stableNodePath()),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
        ].join(":"),
        ...(process.env.BARRY_HOME
          ? { BARRY_HOME: process.env.BARRY_HOME }
          : {}),
        BARRY_DIR: root,
        // Session settings a service writes name this as each hook's command.
        BARRY_HOOK_DISPATCHER: installedProgramPath("barry-hook"),
        ...installedCommand("barry-service").environment,
      },
      health: spec.health,
      automatic: spec.autostart === "login",
    });
    const port = ports.get(spec.key);
    prepared[spec.key] = { ...spec, port };
    resources[spec.key] = {
      bag: spec.bag,
      name: spec.name,
      kind: "service",
      ...(spec.socket
          ? { url: `unix://${spec.socket}` }
          : spec.serves && port !== undefined
            ? { url: `http://127.0.0.1:${port}` }
            : {}),
      ...(spec.health ? { health: spec.health } : {}),
    };
  }
  for (const bag of bags) {
    for (const app of bag.apps ?? []) {
      resources[`${bag.name}.${app.name}`] = {
        bag: bag.name,
        name: app.name,
        kind: "app",
        ...(app.id ? { id: app.id } : {}),
        ...(app.displayName ? { displayName: app.displayName } : {}),
        ...(app.protocolVersion !== undefined
          ? { protocolVersion: app.protocolVersion }
          : {}),
        ...(app.capabilities ? { capabilities: app.capabilities } : {}),
        ...(app.urlSchemes
          ? { urlSchemes: app.urlSchemes, url: `${app.urlSchemes[0]}://` }
          : {}),
      };
      const appPath = join(
        instance.home,
        "apps",
        `${app.name}.app`,
        "Contents",
        "MacOS",
        app.name,
      );
      definitions.push({
        name: `${bag.name}.${app.name}`,
        command: [appPath],
        directory: dirname(appPath),
        domain: `gui/${instance.uid ?? process.getuid?.() ?? 501}`,
        plistDirectory: join(ownerHome, "Library", "LaunchAgents"),
        logDirectory: bagLogsDir(bag.name),
        restart: false,
        automatic: app.loginItem === true,
      });
    }
  }
  const os = options.os ?? serviceOS();
  const recorded = new ServiceManagement(instance, previousDefinitions, os);
  definitions.push(
    ...retainedDefinitions(previousDefinitions, definitions, (name) =>
      recorded.choice(name),
    ),
  );
  mkdirSync(instance.home, { recursive: true });
  writeFileSync(`${preparedPath}.tmp`, JSON.stringify(prepared, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(`${preparedPath}.tmp`, preparedPath);
  writeFileSync(managedPath, JSON.stringify(definitions, null, 2) + "\n", {
    mode: 0o600,
  });
  writeServiceRegistry({
    version: 2,
    generated: new Date().toISOString(),
    resources,
  });
  return new ServiceManagement(instance, definitions, os);
}

/**
 * Declared services that service management has not taken up, for `barry doctor`.
 *
 * Nothing else notices a dropped service: its launchd job is simply gone, and
 * `barry service list` only lists what was prepared. `unprepared` are declared
 * by a bag but missing from service-definitions.json; `unregistered` are
 * prepared but were never added (system daemons need the explicit privileged
 * setup pass, so they are left out); `retained` are kept from an earlier preparation because their
 * bag's manifest cannot be read now.
 */
export async function serviceDrift(): Promise<{ unprepared: string[]; unregistered: string[]; retained: string[] }> {
  const bags = await loadAllBags();
  const management = await installedServices();
  const { specs } = buildServiceSpecs(bags, loadRegistry(), (bag, key) => systemPaths(management.instance, bag, key).state);
  const preparedPath = join(management.instance.home, "service-definitions.json");
  const prepared = existsSync(preparedPath)
    ? (JSON.parse(readFileSync(preparedPath, "utf8")) as Record<string, ServiceSpec & { port?: number }>)
    : {};
  return {
    unprepared: specs.map((spec) => spec.key).filter((key) => !(key in prepared)),
    unregistered: Object.values(prepared)
      .filter((spec) => !spec.user && !management.hasChoice(spec.key))
      .map((spec) => spec.key),
    retained: retainUnreadableBagServices(bags, specs, prepared).map((spec) => spec.key),
  };
}

async function applyInstalledServices(
  operation: "start" | "stop",
): Promise<void> {
  const services = await installedServices(),
    failures: Error[] = [];
  for (const service of await services.list()) {
    if (isSystemService(services.definition(service.name))) continue;
    if (!service.registered || (operation === "start" && !service.enabled))
      continue;
    try {
      await services.apply(service.name, operation);
    } catch (error) {
      failures.push(new Error(`${service.name}: ${String(error)}`));
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      failures.map((error) => error.message).join("; "),
    );
}
export async function startInstalledServices(): Promise<void> {
  await applyInstalledServices("start");
}
export async function stopInstalledServices(): Promise<void> {
  await applyInstalledServices("stop");
}

/** Refresh declarations without overriding a user's disabled or removed registrations. */
export async function refreshInstalledServices(): Promise<{
  started: string[];
  stopped: string[];
}> {
  const services = await installedServices({ refresh: true });
  const active = new Set(
    Object.keys(
      JSON.parse(
        readFileSync(
          join(services.instance.home, "service-definitions.json"),
          "utf8",
        ),
      ),
    ),
  );
  const stopped: string[] = [];
  for (const service of await services.list()) {
    if (isSystemService(services.definition(service.name))) continue;
    const declared =
      active.has(service.name) ||
      readServiceRegistry().resources[service.name]?.kind === "app";
    if (service.registered && !declared) {
      await services.apply(service.name, "remove");
      stopped.push(service.name);
    } else if (
      declared &&
      !services.hasChoice(service.name)
    ) {
      await services.apply(service.name, "add");
      if (services.definition(service.name).automatic) {
        await services.apply(service.name, "enable");
      }
    } else if (declared && service.registered)
      await services.apply(service.name, "add");
  }
  await publishInstalledHosting();
  // The service protocol retains started for compatibility; refresh never starts a process.
  return { started: [], stopped };
}





async function publishInstalledHosting() {
  const resources = readServiceRegistry().resources;
  const prepared = JSON.parse(
    readFileSync(
      join(barryAppSupportDir(), "service-definitions.json"),
      "utf8",
    ),
  ) as Record<string, { localOnly?: boolean }>;
  const plan = resolveHosting(
    readHostingPolicy(),
    Object.entries(resources)
      .filter(([, resource]) => resource.kind === "service")
      .map(([key, resource]) => ({
        key,
        bag: resource.bag,
        name: resource.name,
        url: resource.url,
        localOnly: prepared[key]?.localOnly ?? false,
      })),
    (await loadAllBags()).flatMap((bag) =>
      bag.manifest?.provides
        ? [{ bag: bag.name, provides: bag.manifest.provides }]
        : [],
    ),
  );
  if (plan.errors.length) throw new Error(plan.errors.join("; "));
  return { plan, published: publishHostingPlan(plan) };
}
export async function moveServicePort(service: string, port: number) {
  const previous = await installedServices();
  previous.definition(service);
  const receiptPath = join(previous.instance.home, `port-${service}.json`);
  const existing = existsSync(receiptPath)
    ? (JSON.parse(readFileSync(receiptPath, "utf8")) as {
        instance: string;
        from: number;
        to: number;
        wasRunning: boolean;
        phase: string;
      })
    : undefined;
  if (existing && existing.instance !== previous.instance.id)
    throw new Error("port operation belongs to another instance");
  const receipt =
    existing && existing.phase !== "complete" && existing.to === port
      ? existing
      : {
          instance: previous.instance.id,
          from: readAssignments().get(service),
          to: port,
          wasRunning: Boolean((await previous.status(service)).pid),
          phase: "prepared",
        };
  const save = (phase: string, problem?: string) => {
    const temporary = `${receiptPath}.${process.pid}.tmp`;
    receipt.phase = phase;
    writeFileSync(temporary, JSON.stringify({ ...receipt, problem }) + "\n", {
      mode: 0o600,
    });
    renameSync(temporary, receiptPath);
  };
  save("prepared");
  try {
    const assignment = await moveAssignment(service, port);
    save("preparing");
    const services = await installedServices({ refresh: true });
    const restarted: string[] = [];
    if (receipt.wasRunning) {
      save("restarting");
      await services.apply(service, "restart");
      restarted.push(service);
    }
    save("publishing");
    const hosting = await publishInstalledHosting();
    const routes = await waitForRoutes(
      hosting.plan,
      hosting.published,
      service,
      `http://127.0.0.1:${assignment.to}`,
    );
    save("complete");
    return {
      service,
      from: receipt.from ?? assignment.from,
      to: assignment.to,
      restarted,
      routes,
    };
  } catch (error) {
    save(receipt.phase, String(error));
    throw error;
  }
}
