import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import {
  assertNodeAllowed,
  assertToolAllowed,
  applyBoundGuards,
} from "@barry-rocks/sdk/bounds";
import type { AnyToolDefinition } from "@barry-rocks/sdk/tools";
import type { ScheduleAccess } from "./permissions.js";

function parseInputsIfZodShape(
  schema: Readonly<Record<string, unknown>> | undefined,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return inputs;
  const entries = Object.values(schema);
  if (entries.length > 0 && entries.some((v) => v && typeof v === "object" && "_def" in v)) {
    return z.object(schema as z.ZodRawShape).parse(inputs);
  }
  return inputs;
}

export async function runMcpAction(
  reference: string,
  inputs: Record<string, unknown>,
  access: ScheduleAccess,
): Promise<unknown> {
  const [namespace, name, ...extra] = reference.split(":");
  if (!namespace || !name || extra.length) {
    throw new Error("expected namespace:tool");
  }
  assertNodeAllowed(installationRegistry().id, access.bound);
  assertToolAllowed(access, { namespace, toolName: name }, installationRegistry().id);

  const preloaded =
    "tools" in access && Array.isArray(access.tools)
      ? access.tools.find((entry) => entry.namespace === namespace && entry.name === name)
      : undefined;
  if (preloaded && typeof preloaded.handler === "function") {
    const parsedInputs = parseInputsIfZodShape(preloaded.schema, inputs);
    return withStoreContext({ identity: access.identity, execution: access }, () =>
      preloaded.handler!(parsedInputs, {} as never),
    );
  }

  const snapshot = await loadBagRegistrySnapshot();
  for (const bag of snapshot.bags) {
    if (bag.source.type !== "local" || !bag.manifest?.toolsEntry) continue;
    const module = (await import(
      pathToFileURL(resolve(bag.source.path, bag.manifest.toolsEntry.entry)).href
    )) as {
      tools?: AnyToolDefinition[];
    };
    const tool = module.tools?.find(
      (entry) => entry.namespace === namespace && entry.name === name,
    );
    if (tool) {
      const guarded = access.bound ? applyBoundGuards([tool], access.bound)[0] : tool;
      return withStoreContext({ identity: access.identity, execution: access }, () =>
        guarded.handler(z.object(tool.schema).parse(inputs)),
      );
    }
  }
  throw new Error(`unknown MCP action ${reference}`);
}
