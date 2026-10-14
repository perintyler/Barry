/** Strict, bounded JSON for durable effect receipts; reject lossy serialization. */
export function encodeEffectJson(value: unknown): string {
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (depth > 64) throw new Error("effect JSON exceeds nesting limit");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object") throw new Error("effect JSON contains unsupported value");
    if (ancestors.has(item)) throw new Error("effect JSON contains a cycle");
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) visit(item[index], depth + 1);
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("effect JSON must contain plain objects");
      for (const child of Object.values(item)) visit(child, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 262_144) throw new Error("effect JSON exceeds payload limit");
  return encoded;
}
