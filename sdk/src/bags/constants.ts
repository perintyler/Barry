/** Resolve whole-value references without evaluating strings or executing code. */
export function resolveConstants(raw: unknown, loadBag: (name: string, owner: string) => unknown): unknown {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const root = object(raw);
  if (!root) return raw;
  const rootName = typeof root.name === "string" ? root.name : "manifest";
  const bags = new Map<string, Record<string, unknown>>([[rootName, root]]);
  const visiting = new Set<string>();
  let expanded = 0;

  function provider(name: string, owner = rootName): Record<string, unknown> {
    const cached = bags.get(name);
    if (cached) return cached;
    const loaded = object(loadBag(name, owner));
    if (!loaded || loaded.name !== name) throw new Error(`constant provider ${name} has no matching manifest`);
    bags.set(name, loaded);
    return loaded;
  }

  function walk(value: unknown, owner: string, path: string, depth = 0): unknown {
    if (++expanded > 100_000 || depth > 100) throw new Error(`${path}: constant expansion exceeds its limit`);
    if (Array.isArray(value)) return value.map((item, i) => walk(item, owner, `${path}.${i}`, depth + 1));
    const record = object(value);
    if (!record) return value;
    if (Object.hasOwn(record, "constant")) {
      if (Object.keys(record).length !== 1 || typeof record.constant !== "string" || !record.constant) {
        throw new Error(`${path}: a constant reference must contain only a non-empty constant name`);
      }
      const split = record.constant.indexOf(":");
      const target = split < 0 ? owner : record.constant.slice(0, split);
      const name = split < 0 ? record.constant : record.constant.slice(split + 1);
      const manifest = provider(owner);
      const composition = manifest.bags;
      const allowed = Array.isArray(composition) ? composition : Object.keys(object(composition) ?? {});
      if (target !== owner && !allowed.includes(target) && !Object.hasOwn(object(manifest.requires) ?? {}, target)) {
        throw new Error(`${path}: ${owner} must compose or require constant provider ${target}`);
      }
      const constants = object(provider(target, owner).constants);
      if (!constants || !Object.hasOwn(constants, name)) throw new Error(`${path}: unknown constant ${target}:${name}`);
      const key = `${target}:${name}`;
      if (visiting.has(key)) throw new Error(`${path}: constant cycle at ${key}`);
      visiting.add(key);
      try { return walk(constants[name], target, `${path} -> ${key}`, depth + 1); }
      finally { visiting.delete(key); }
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, walk(item, owner, `${path}.${key}`, depth + 1)]));
  }
  return walk(raw, rootName, rootName);
}
