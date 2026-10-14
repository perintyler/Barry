import type { StoreBinding } from "../stores/bindings.js";

export interface BagBinding {
  readonly name: string;
  store(name?: string): StoreBinding;
}

export const STORE_BINDING_RESOLVER = Symbol.for("barry.store-binding-resolver.v1");
export type StoreBindingResolver = (bag: string, name?: string) => StoreBinding;

export function bagBinding(name: string): BagBinding {
  if (!name) throw new TypeError("Barry.bag requires a registered bag name");
  return Object.freeze({
    name,
    store: (store?: string): StoreBinding => {
      const resolve = (globalThis as Record<symbol, unknown>)[STORE_BINDING_RESOLVER] as StoreBindingResolver | undefined;
      if (!resolve) throw new Error("bag.store requires a Barry execution context");
      return resolve(name, store);
    },
  });
}
