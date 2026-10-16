import { BarryError, isBarryError, type Bags, type Caller } from "@barry-rocks/sdk";
import { BarryApiError, BarryClient } from "@barry-rocks/sdk/internal/client";
import { loadRegistry, loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";
import { instanceEnvValue, getServiceUrl } from "@barry-rocks/sdk/services";


function allowed(caller: Caller): void {
  if (caller.kind === "device") throw new BarryError("forbidden", "A device may not read bags or run their jobs");
}

/** Looked up per call so a moved sessions API is found. */
function runtimeAddress(): { baseUrl: string; secret: string } {
  const secret = instanceEnvValue("BARRY_SECRET");
  if (!secret) throw new BarryError("unavailable", "This instance has no BARRY_SECRET, so its sessions API cannot be reached", "Run barry setup");
  try {
    return { baseUrl: getServiceUrl("api"), secret };
  } catch (error) {
    throw new BarryError("unavailable", `The sessions API is not registered: ${error instanceof Error ? error.message : String(error)}`, "Start it with barry service start sessions.api");
  }
}

export const bags: Bags = {
  name: "bags",
  async list(caller) {
    allowed(caller);
    return Object.entries(loadRegistry()).map(([name, source]) => ({
      name,
      type: source.type,
      description: source.type === "local" ? `Local — ${source.path}` : (source.url ?? source.command ?? "Remote"),
    }));
  },
  async tools(name, caller) {
    allowed(caller);
    const { byName } = await loadBagRegistrySnapshot();
    const bag = byName.get(name);
    if (!bag) throw new BarryError("not_found", `Bag "${name}" not found`);
    return bag.tools.map((tool) => ({
      name: tool.toolName,
      namespace: tool.namespace,
      bag: name,
      access: tool.access === "readwrite" ? "write" : tool.access,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
    }));
  },
  async runJob(bag, job, inputs, options, caller) {
    allowed(caller);
    if (options.identity !== undefined) {
      throw new BarryError("unavailable", "Running a job as an identity is not available over HTTP yet");
    }
    try {
      const runtime = BarryClient.connect(runtimeAddress());
      return (await runtime.jobs.run(`${bag}:${job}`, inputs, {
        ...(options.key ? { key: options.key } : {}),
        ...(caller.kind === "session" ? { callerSessionId: caller.sessionId } : {}),
      })).state;
    } catch (error) {
      if (isBarryError(error)) throw error;
      if (!(error instanceof BarryApiError)) throw new BarryError("unavailable", error instanceof Error ? error.message : String(error));
      const reason = error.status === 403 ? "forbidden" : error.status === 404 ? "not_found"
        : error.status === 409 ? "conflict" : error.status === 400 || error.status === 422 ? "invalid" : "unavailable";
      throw new BarryError(reason, error.message);
    }
  },
};
