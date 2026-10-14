// Session-scoped, owner-scoped retry journal. Never persist arbitrary payloads.
const key = owner => `workflow:operations:${owner}`;
export function pendingOperations(owner) {
  const raw = sessionStorage.getItem(key(owner));
  if (!raw) return [];
  if (raw.length > 65536) throw new Error("Invalid operation journal; preserve its IDs before clearing session storage.");
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length > 32 || entries.some(entry => !entry || !["start", "signal", "cancel", "resume", "reauthorize"].includes(entry.operation) || typeof entry.id !== "string" || typeof entry.runId !== "string" || typeof entry.hash !== "string")) throw new Error("Invalid operation journal; preserve its IDs before clearing session storage.");
  return entries;
}
async function requestHash(body) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(body)))))].map(value => value.toString(16).padStart(2, "0")).join("");
}
export async function rememberOperation(owner, operation, runId, id, body) {
  const entries = pendingOperations(owner), previous = entries.find(entry => entry.operation === operation && entry.runId === runId && entry.id === id), hash = await requestHash(body);
  if (previous && previous.hash !== hash) throw new Error("This request already has an uncertain outcome. Re-enter the original input; its identity cannot be reused with changed data.");
  if (previous) return previous;
  if (entries.length >= 32) throw new Error("Resolve an unconfirmed operation before submitting another (32 maximum).");
  const entry = { operation, runId, id, hash, at: Date.now(), ...(operation === "start" ? { type: body.type, version: body.version } : {}), ...(["start", "reauthorize"].includes(operation) && body.job ? { job: body.job } : {}), ...(operation === "signal" ? { name: body.name } : {}), ...(["cancel", "resume", "reauthorize"].includes(operation) ? { expectedRevision: body.expectedRevision } : {}) };
  const encoded = JSON.stringify([...entries, entry]);
  if (encoded.length > 65536) throw new Error("Resolve existing operation metadata before submitting another request.");
  sessionStorage.setItem(key(owner), encoded);
  return entry;
}
export function forgetOperation(owner, entry) {
  sessionStorage.setItem(key(owner), JSON.stringify(pendingOperations(owner).filter(item => item.operation !== entry.operation || item.runId !== entry.runId || item.id !== entry.id)));
}
