import { AsyncLocalStorage } from "node:async_hooks";
import { STORE_BINDING_RESOLVER } from "../bags/store.js";
import { resolveStoreBinding, type StoreOptions } from "./bindings.js";
import type { StoreDeclaration } from "./registry.js";
import type { ToolCallBounds } from "../bounds/resolve-bound.js";
import type { WorkflowActorContext } from "../auth/workflow-actor.js";
export interface StoreBagConfiguration {
  stores: Readonly<Record<string, StoreDeclaration>>;
  overrides?: Readonly<Record<string, StoreOptions>>;
  remoteProtocols?: readonly string[];
}
export interface StoreContext {
  node?: string;
  root?: string;
  bags?: Readonly<Record<string, StoreBagConfiguration>>;
  identity?: string;
  execution?: WorkflowActorContext | ToolCallBounds;
  workflowActor?: (path: string, body?: unknown) => string | Promise<string>;
}
// Independently bundled bags must share the engine's execution context.
const contextKey = Symbol.for("barry.store-context");
const shared = globalThis as typeof globalThis & { [contextKey]?: AsyncLocalStorage<StoreContext> };
/** Install the host's shared invocation context explicitly; importing this module is inert. */
export function installStoreContext(): void {
  shared[contextKey] ??= new AsyncLocalStorage<StoreContext>();
  const bindings = globalThis as Record<symbol, unknown>;
  bindings[STORE_BINDING_RESOLVER] ??= (bag: string, name?: string) => {
    const context = shared[contextKey]?.getStore();
    if (!context) throw new Error("bag.store requires a Barry execution context");
    const configuration =
      context.bags && Object.hasOwn(context.bags, bag) ? context.bags[bag] : undefined;
    if (!configuration) throw new Error(`${bag}: bag is not bound in this execution context`);
    return resolveStoreBinding(bag, configuration.stores, {
      node: context.node ?? "local",
      identity: context.identity,
      name,
      root: context.root,
      overrides: configuration.overrides,
      remoteProtocols: configuration.remoteProtocols,
    });
  };
}

/** Entering a host invocation installs the shared context before resolving authored bag handles. */
export function withStoreContext<T>(context: StoreContext, operation: () => T): T {
  installStoreContext();
  return shared[contextKey]!.run(context, operation);
}
export function currentStoreContext(): StoreContext | undefined {
  return shared[contextKey]?.getStore();
}
