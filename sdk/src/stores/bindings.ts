import { isAbsolute } from "node:path";
import { StoreOptionsSchema, type StoreOptions } from "./options.js";
export { mergeStoreOptions, type StoreOptions } from "./options.js";
import { activeStoreRoot } from "./migration.js";
import { storeKey, storePath, type StoreDeclaration, type StoreScope } from "./registry.js";

export type StoreBinding = Readonly<{
  node: string;
  identity?: string;
  bag: string;
  store: string;
  owned_by: StoreScope;
  engine: "sqlite";
  app_url?: string;
} & ({ filepath: string; url?: never } | { url: string; filepath?: never })>;

export interface StoreResolution {
  node: string;
  identity?: string;
  name?: string;
  root?: string;
  overrides?: Readonly<Record<string, StoreOptions>>;
  remoteProtocols?: readonly string[];
}

export function resolveStoreBinding(
  bag: string,
  declarations: Readonly<Record<string, StoreDeclaration>>,
  resolution: StoreResolution,
): StoreBinding {
  const names = Object.keys(declarations);
  const name = resolution.name ?? (names.length === 1 ? names[0] : undefined);
  if (!name) throw new Error(`${bag}: store() requires exactly one declared store; found ${names.length}`);
  const declaration = Object.hasOwn(declarations, name) ? declarations[name] : undefined;
  if (!declaration) throw new Error(`${bag}: unknown store ${name}`);
  if (declaration.engine !== "sqlite") throw new Error(`${bag}: unsupported store engine ${declaration.engine}`);
  if (!["identity", "node"].includes(declaration.owned_by)) throw new Error(`${bag}: unsupported store ownership`);
  const identity = declaration.owned_by === "identity" ? resolution.identity : undefined;
  if (declaration.owned_by === "identity" && !identity) throw new Error(`${bag}: identity-owned store requires an execution identity`);
  for (const override of Object.keys(resolution.overrides ?? {})) {
    if (!Object.hasOwn(declarations, override)) throw new Error(`${bag}: configuration names unknown store ${override}`);
  }
  const ref = { node: resolution.node, identity, bag, store: name };
  storeKey(ref);
  const configured = StoreOptionsSchema.parse(resolution.overrides?.[name] ?? {});
  if (configured.filepath && !isAbsolute(configured.filepath)) throw new Error(`${bag}: store filepath must be absolute on this host`);
  const base = {
    node: ref.node, ...(identity ? { identity } : {}), bag, store: name,
    owned_by: declaration.owned_by, engine: declaration.engine,
    ...(configured.app_url ? { app_url: configured.app_url } : {}),
  };
  if (configured.url) {
    const endpoint = new URL(configured.url);
    if (endpoint.username || endpoint.password) throw new Error(`${bag}: store URL cannot embed credentials; use secrets`);
    if (!(resolution.remoteProtocols ?? []).includes(endpoint.protocol))
      throw new Error(`${bag}: no installed store adapter supports ${endpoint.protocol}`);
    return Object.freeze({ ...base, url: configured.url });
  }
  if (!configured.filepath && resolution.root !== undefined && !isAbsolute(resolution.root))
    throw new Error(`${bag}: managed store root must be absolute`);
  return Object.freeze({ ...base, filepath: configured.filepath ?? storePath(ref, declaration.owned_by, resolution.root ?? activeStoreRoot()) });
}
