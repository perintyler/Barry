/** Session adapters are explicitly selected in the installation registry. */
export interface AdapterStore {
  adapters: import("@barry-rocks/sdk/adapters/harnesses").Adapters;
}

let store: AdapterStore | null = null;

/** Read installation selections without discovering sibling packages. */
export async function adapterStore(): Promise<AdapterStore> {
  if (store) return store;
  const { loadAdapters } = await import("@barry-rocks/sdk/internal/adapters");
  const { barryAdaptersPath } = await import("@barry-rocks/sdk/services");
  const adapters = loadAdapters({ file: barryAdaptersPath(), registerBag: async (name, path) => {
    const { getBag, upsertBag } = await import("../bags/registration.js");
    const previous = await getBag(name);
    const source = previous?.source as { type?: string; path?: string } | undefined;
    if (source && (source.type !== "local" || source.path !== path)) throw new Error(`adapter bag ${name} conflicts with its existing registration`);
    if (!previous) await upsertBag(name, { type: "local", path });
  } });
  store = { adapters };
  return store;
}

/** An installed adapter's code, loaded and checked: what a launch runs. */
export async function harnessAdapter(id: string): Promise<import("@barry-rocks/sdk/adapters/harnesses").Adapter> {
  const { adapters } = await adapterStore();
  return adapters.load(id);
}

/** For tests that need a fresh store. */
export function resetAdapterStore(): void {
  store = null;
}
