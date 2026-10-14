export function route() {
  const [hash, search] = location.hash.slice(1).split("?");
  const query = new URLSearchParams(search), event = Number(query.get("event") ?? 0), step = Number(query.get("step") ?? -1);
  // `#jobs/…` is the old spelling, kept so links shared before the rename still open.
  try { return /^(runs|jobs)\//.test(hash) ? { page: "detail", id: decodeURIComponent(hash.slice(5)), tab: ["steps", "history", "permissions", "resources", "payloads"].includes(query.get("tab")) ? query.get("tab") : "steps", event: Number.isSafeInteger(event) && event > 0 ? event : 0, step: Number.isSafeInteger(step) && step >= 0 ? step : -1, eventType: query.get("eventType") ?? "" } : { page: hash === "workers" ? "workers" : "runs" }; }
  catch { return { page: "runs" }; }
}
