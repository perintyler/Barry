import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { assertToolAllowed, applyBoundGuards, type ExecutionContext } from "@barry-rocks/sdk/bounds";
import type { AnyToolDefinition } from "@barry-rocks/sdk/tools";
export async function runMcpAction(reference: string, inputs: Record<string, unknown>, context: ExecutionContext): Promise<unknown> {
    const [namespace, name, ...extra] = reference.split(":");
    if (!namespace || !name || extra.length)
        throw new Error("expected namespace:tool");
    assertToolAllowed(context, { namespace, toolName: name }, installationRegistry().id);
    const snapshot = await loadBagRegistrySnapshot();
    for (const bag of snapshot.bags) {
        if (bag.source.type !== "local" || !bag.manifest?.toolsEntry)
            continue;
        const module = await import(pathToFileURL(resolve(bag.source.path, bag.manifest.toolsEntry.entry)).href) as {
            tools?: AnyToolDefinition[];
        };
        const tool = module.tools?.find((entry) => entry.namespace === namespace && entry.name === name);
        if (tool) {
            const guarded = context.bound ? applyBoundGuards([tool], context.bound)[0] : tool;
            return withStoreContext({ identity: context.identity, execution: context }, () => guarded.handler(z.object(tool.schema).parse(inputs)));
        }
    }
    throw new Error(`unknown MCP action ${reference}`);
}
