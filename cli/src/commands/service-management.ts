import { installedServices } from "../services/barry.js";
import { executeService } from "../services/entry.js";
export async function serviceListCommand(
  options: { json?: boolean } = {},
): Promise<void> {
  const management = await installedServices();
  const services = await management.list();
  if (options.json)
    console.log(
      JSON.stringify({ instance: management.instance, services }, null, 2),
    );
  else
    for (const service of services)
      console.log(
        `${service.name}\t${service.registered ? "registered" : "unregistered"}\t${service.enabled ? "enabled" : "disabled"}\t${service.pid ? `running (${service.pid})` : "stopped"}${service.pending ? `\tpending ${service.pending}` : ""}${service.logs.rotationRecommended ? "\tlog rotation recommended" : ""}`,
      );
}
export async function serviceManageCommand(
  name: string,
  operation: "add" | "remove" | "enable" | "disable",
  options: { now?: boolean },
): Promise<void> {
  const management = await installedServices({ refresh: operation === "add" });
  await management.apply(name, operation, options);
  console.log(`${name}: ${operation}`);
}
export async function serviceRunCommand(name: string): Promise<void> {
  const { assertLaunchd } = await import("../lib/platform.js");
  assertLaunchd();
  const management = await installedServices();
  const state = await management.status(name);
  if (state.pid) throw new Error(`${name} is already running (${state.pid})`);
  management.assertCanStart(name);
  const definition = management.definition(name);
  if (definition.user) {
    if (process.getuid?.() !== 0)
      throw new Error(
        `running ${name} as ${definition.user} requires an administrative process`,
      );
    process.chdir(definition.directory);
    process.setgid!(definition.user);
    process.setuid!(definition.user);
    const runtime = process as typeof process & {
      execve(file: string, args: string[], env: Record<string, string>): never;
    };
    runtime.execve(
      definition.command[0],
      [...definition.command],
      definition.environment ?? {},
    );
  }
  await executeService(management.instance.home, name);
}
