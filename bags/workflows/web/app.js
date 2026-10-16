import { state } from "./state.js";
import { api } from "./api.js";
import { route } from "./routing.js";
import { pendingOperations, rememberOperation, forgetOperation } from "./operations.js";
import { explainBlockedRun } from "./waiting-reasons.js";
const $ = selector => document.querySelector(selector);
const date = value => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const label = value => value.replaceAll("_", " ");
const path = id => `/api/runs/${encodeURIComponent(id)}`;
const detailLink = (id, query) => `#runs/${encodeURIComponent(id)}?${new URLSearchParams(query)}`;
function node(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name.startsWith("on")) element.addEventListener(name.slice(2), value);
    else if (value !== undefined && (value !== false || name.startsWith("aria-"))) element.setAttribute(name, name.startsWith("aria-") ? String(value) : value === true ? "" : String(value));
  }
  element.append(...children.flat().filter(child => child !== null && child !== undefined));
  return element;
}
const button = (text, action, attributes = {}) => node("button", { type: "button", class: "secondary", onclick: action, ...attributes }, text);
const badge = value => node("span", { class: `badge ${value}` }, label(value));
const payload = (title, value, key = title) => node("details", { "data-key": key }, node("summary", {}, title), node("pre", {}, JSON.stringify(value, null, 2)));
function lazyPayload(title, url, key, render) {
  let loaded = false, loading = false;
  const content = node(render ? "div" : "pre", {}, "Expand to load authorized details.");
  const element = node("details", { "data-key": key, ontoggle: async () => {
    if (!element.open || loaded || loading) return;
    loading = true;
    try { const value = await api(url); if (element.isConnected) { if (render) content.replaceChildren(render(value)); else content.textContent = JSON.stringify(value, null, 2); loaded = true; } }
    catch (error) { content.textContent = error.message; }
    finally { loading = false; }
  } }, node("summary", {}, title), content);
  return element;
}
function renderPermissions(value) {
  const grant = value.grant;
  if (!grant) return node("p", {}, "Legacy run: no approved privileged execution scope.");
  const effective = new Set(value.effective?.allowedToolIds ?? []);
  const tools = Object.entries(grant.scope.tools);
  const approvedBags = grant.scope.bags ?? grant.scope.traits ?? [];
  return node("div", {},
    node("dl", { class: "metadata" }, [["Authorizer", grant.authorizer], ["Identity", grant.scope.identity ?? "None"], ["Approved bags", approvedBags.join(", ") || "None"], ["Grant revision", grant.revision]].map(([key, text]) => node("div", {}, node("dt", {}, key), node("dd", {}, String(text))))),
    node("p", { class: value.currentPolicyAvailable ? "subtext" : "error-box" }, value.currentPolicyAvailable ? "Current policy observed. Each effect still requires destination and live-attempt checks." : "Current policy unavailable. This view is not evidence of permission to execute."),
    tools.length ? table(["Qualified tool", "Approved access", "Current policy"], tools.map(([id, access]) => node("tr", {}, node("td", { class: "code" }, id), node("td", {}, access), node("td", {}, !value.currentPolicyAvailable ? "Unknown" : effective.has(id) ? "Within ceiling" : "Restricted")))) : node("p", {}, "No approved tool capabilities."),
    payload("Grant evidence and bounds", value, "permission-evidence"));
}
function renderResources(value) {
  return node("div", {},
    node("p", {}, `Logical leases: ${value.logicalLeases ?? 0}. Physical running: ${value.physicalRunning ?? 0}. Physical state unknown: ${value.physicalUnknown ?? 0}.`),
    value.bindings?.length ? table(["Session", "Step", "Turn", "State"], value.bindings.map(binding => node("tr", {}, node("td", { class: "code" }, binding.sessionId), node("td", { class: "code" }, binding.stepId), node("td", { class: "code" }, binding.turnId), node("td", {}, binding.state)))) : node("p", {}, "No session dependencies recorded."),
    payload("Resource evidence", value, "resource-evidence"));
}
function empty(title, message) { return node("div", { class: "empty" }, node("h2", {}, title), node("p", {}, message)); }
function notice(message) { $("#notice").textContent = message; $("#notice").hidden = !message; }
function table(headers, rows) {
  return node("div", { class: "table-scroll" }, node("table", {}, node("thead", {}, node("tr", {}, headers.map(title => node("th", { scope: "col" }, title)))), node("tbody", {}, rows)));
}
function renderCounts() {
  const counts = state.overview.counts;
  $("#counts").replaceChildren(...[
    ["All runs", Object.values(counts).reduce((sum, count) => sum + count, 0), ""],
    ["Running", counts.running ?? 0, "running"], ["Completed", counts.completed ?? 0, "completed"],
    ["Blocked", counts.blocked ?? 0, "blocked"],
  ].map(([title, count, status]) => {
    const tile = button("", () => { $("#status").value = status; updateFilters(); }, { class: `count ${status}` });
    tile.append(node("div", {}, node("span", {}, title), node("strong", {}, String(count))), node("span", { class: "marker" }));
    return tile;
  }));
}
function renderRuns(runs) {
  if (!runs.length) return node("div", {}, empty("No runs here yet", $("#search").value || $("#status").value ? "Try a different search or status filter." : "Start a run to see its steps, workers, and history here."), state.offset ? button("← Previous page", () => { state.offset = Math.max(0, state.offset - 50); void refresh(); }) : null);
  return node("div", { class: "panel" }, table(["Run", "Status", "Workflow", "Identity", "Started", "Deadline"], runs.map(run => node("tr", {},
    node("td", {}, node("a", { href: `#runs/${encodeURIComponent(run.id)}`, class: "run-link" }, run.id), node("div", { class: "subtext" }, run.owner.slice(0, 12))),
    node("td", {}, badge(run.status)), node("td", {}, run.type, node("div", { class: "subtext" }, `Version ${run.version}`)),
    node("td", {}, run.job?.identity ?? "No session identity", node("div", { class: "subtext" }, (run.job?.bags ?? run.job?.traits)?.join(", ") ?? "Legacy scope")), node("td", {}, date(run.startedAt)), node("td", {}, date(run.deadline)),
  ))), node("div", { class: "pager" }, `Showing ${state.offset + 1}–${state.offset + runs.length}`, node("div", { class: "actions" },
    button("← Previous", () => { state.offset = Math.max(0, state.offset - 50); void refresh(); }, { disabled: state.offset === 0 }),
    button("Next →", () => { if (state.busy || !state.nextCursor) return; state.cursors[state.offset / 50 + 1] = state.nextCursor; state.offset += 50; void refresh(); }, { disabled: !state.nextCursor }),
  )));
}
function renderWorkers() {
  const workers = state.overview.workers;
  if (!workers.length) return empty("No workers advertising", "Runs stay queued until an eligible worker is available.");
  return node("div", { class: "panel" }, table(["Worker", "Activities", "Capacity", "Capabilities", "Advertisement expires"], workers.map(worker => node("tr", {},
    node("td", { class: "code" }, worker.id, node("div", { class: "subtext" }, worker.id === state.overview.owner ? "This machine" : "Enrolled peer")),
    node("td", {}, worker.types.join(", "), node("div", { class: "subtext" }, "Up to 20 types shown")), node("td", {}, `${worker.active} / ${worker.capacity} active`, node("div", { class: "subtext" }, `Load ${Math.round(worker.load * 100)}%`)),
    node("td", {}, lazyPayload("All types, labels & artifact digests", `/api/workers/${encodeURIComponent(worker.id)}`, worker.id)), node("td", {}, date(worker.expiresAt)),
  ))));
}
function waiting(command) {
  if (command.state === "done" || command.state === "cancelled") return command.outcome?.ok === false ? command.outcome.error.message : "";
  if (state.run.run.status === "blocked") return explainBlockedRun(state.run.run.error).title;
  if (command.state === "leased") return `Heartbeat lease until ${date(command.leaseUntil)}`;
  if (command.definition.kind === "timer") return `Sleeping until ${date(command.deadline)}`;
  if (command.definition.kind === "signal") return `Waiting for “${command.definition.name}”`;
  if (command.readyAt > Date.now()) return `Retry eligible ${date(command.readyAt)}`;
  const reason = state.eligibility.find(item => item.commandId === command.id)?.reason;
  return ({ REQUIRED_CONTAINMENT_UNAVAILABLE: "No worker can enforce this run’s required execution profile.", NO_COMPATIBLE_ARTIFACT: "Install this step’s pinned activity artifact on a worker.", NO_MATCHING_CAPABILITY: "No worker matches the required activity, node and labels.", NODE_BOUND_EXCLUDED: "The run’s bound keeps every connected worker out; allow one in its nodes bound.", WORKER_OFFLINE: "No online worker is advertising.", CAPACITY_FULL: "Compatible workers are busy; waiting for capacity.", READY: "Eligible for dispatch." })[reason] ?? "Queued for an eligible worker";
}
function workerEligibility(command) {
  const workers = state.eligibility.find(item => item.commandId === command.id)?.workers;
  if (!workers?.length) return null;
  const explain = { ELIGIBLE: "Eligible", WORKER_OFFLINE: "Offline", REQUIRED_CONTAINMENT_UNAVAILABLE: "Profile unsupported", NO_MATCHING_CAPABILITY: "Capability mismatch", NO_COMPATIBLE_ARTIFACT: "Artifact mismatch", NODE_BOUND_EXCLUDED: "Excluded by bound", CAPACITY_FULL: "At capacity" };
  return node("details", { class: "worker-eligibility" }, node("summary", {}, `Worker checks (${workers.length})`), table(["Worker", "Eligibility", "Occupancy", "Advertisement"], workers.map(worker => node("tr", {},
    node("td", { class: "code" }, worker.worker), node("td", {}, explain[worker.reason] ?? worker.reason),
    node("td", {}, `${worker.active} / ${worker.capacity}`), node("td", {}, date(worker.expiresAt)),
  ))));
}
function renderSteps() {
  const commands = state.run.commands;
  if (!commands.length) return empty("No steps recorded", "This workflow has not scheduled any work.");
  return node("div", { class: "panel" }, table(["Step", "State", "Attempts", "Details"], commands.map(command => node("tr", {},
    node("td", {}, node("a", { href: detailLink(state.run.run.id, { tab: "steps", step: command.position * 100 + command.slot }) }, `${command.position + 1}.${command.slot + 1}`), node("div", { class: "subtext" }, command.definition.type ?? command.definition.kind)),
    node("td", {}, badge(command.outcome?.ok === false ? "failed" : command.state), node("div", { class: "subtext" }, waiting(command)), workerEligibility(command)),
    node("td", {}, String(command.attemptCount ?? command.attempts.length)),
    node("td", {}, commandInspector(state.run.run.id, command.id)),
  ))), node("div", { class: "pager" }, "Steps are loaded in bounded pages.", state.stepAfter ? button("First steps", () => { state.stepAfter = ""; void refresh(); }) : null,
    state.run.nextCursor ? button("Next steps", () => { state.stepAfter = state.run.nextCursor; void refresh(); }) : null));
}
function commandInspector(runId, commandId) {
  const content = node("div"), detail = node("details", { "data-key": `command-${commandId}` }, node("summary", {}, "Command, result & attempts"), content);
  let loaded = false, loading = false;
  async function load(after = 0) {
    if (loading) return;
    loading = true;
    try {
      const page = await api(`${path(runId)}/command?${new URLSearchParams({ id: commandId, after })}`);
      if (!detail.isConnected) return;
      loaded = true;
      content.replaceChildren(payload("Command input & policy", page.definition), payload("Accepted result", page.outcome),
        table(["Attempt", "Worker", "State", "Started", "Settled", "Failure"], page.attempts.map(attempt => node("tr", {},
          node("td", {}, String(attempt.attempt)), node("td", { class: "code" }, attempt.worker), node("td", {}, badge(attempt.state)),
          node("td", {}, attempt.startedAt ? date(attempt.startedAt) : "Legacy"), node("td", {}, attempt.settledAt ? date(attempt.settledAt) : "—"), node("td", {}, attempt.errorCode ?? "—")))),
        node("div", { class: "pager" }, after ? button("First attempts", () => void load()) : null, page.nextCursor ? button("Next attempts", () => void load(page.nextCursor)) : null));
    } catch (error) { content.textContent = error.message; }
    finally { loading = false; }
  }
  detail.addEventListener("toggle", () => { if (detail.open && !loaded) void load(); });
  return detail;
}
function renderHistory() {
  const view = route();
  const input = node("input", { id: "event-type", value: view.eventType, maxlength: 200, placeholder: "Exact event type" });
  return node("div", { class: "panel" }, node("form", { class: "filters history-filter", onsubmit: event => { event.preventDefault(); location.hash = detailLink(view.id, { tab: "history", eventType: input.value }); } }, node("label", { for: "event-type" }, "Event type", input), node("button", { type: "submit", class: "secondary" }, "Filter events")),
    node("ol", { class: "timeline" }, state.events.map(event => node("li", { id: `event-${event.sequence}`, class: event.sequence === view.event ? "selected-event" : "" },
    node("div", { class: "event-top" }, node("strong", {}, event.type), node("time", { datetime: new Date(event.at).toISOString() }, date(event.at)), relatedStepLink(view.id, event), node("a", { class: "subtext", href: detailLink(view.id, { tab: "history", event: event.sequence, eventType: view.eventType }) }, `#${event.sequence}`)),
    payload("Event details", event.details, `event-${event.sequence}`),
  ))), node("div", { class: "pager" }, state.events.length ? `${state.events.length} events loaded · #${state.events[0].sequence}–#${state.events.at(-1).sequence}` : "No matching events.", view.event ? node("a", { href: detailLink(view.id, { tab: "history", eventType: view.eventType }) }, "From the beginning") : null, state.historyMore ? button("Load more events", loadHistory) : null));
}
function relatedStepLink(runId, event) {
  if (!event.details || typeof event.details !== "object" || Array.isArray(event.details)) return null;
  const details = event.details;
  const commandId = details.activityId ?? details.command ?? details.stepId;
  if (typeof commandId !== "string") return null;
  const command = state.run.commands.find(item => item.id === commandId);
  if (!command) return null;
  const position = command.position * 100 + command.slot;
  const attempt = Number.isSafeInteger(details.attempt) ? ` · attempt ${details.attempt}` : "";
  const worker = typeof details.worker === "string" ? ` · ${details.worker}` : "";
  return node("a", { class: "subtext", href: detailLink(runId, { tab: "steps", step: position }) }, `Step ${command.position + 1}.${command.slot + 1}${attempt}${worker}`);
}
function renderDetail() {
  const { run } = state.run;
  const blocked = run.status === "blocked" ? explainBlockedRun(run.error) : null;
  const live = run.status === "running" || run.status === "blocked";
  const jobBags = run.job?.bags ?? run.job?.traits ?? [];
  const fields = [["Status", badge(run.status)], ["Workflow", `${run.type} · version ${run.version}`], ["Owner", run.owner], ["Started", date(run.startedAt)], ["Deadline", date(run.deadline)], ["Run ID", run.id], ["Initiator", run.principal], ["Identity", run.job?.identity ?? "No session identity"], ["Bags", jobBags.join(", ") || "No approved tool capabilities"], ["Execution profile", run.job?.profile ?? "Portable (legacy)"], ["Grant revision", String(run.job?.grantRevision ?? "Legacy")], ["Pinned artifact", run.artifact ?? "Legacy definition"], ["Revision", String(run.revision)]];
  const metadata = node("div", { class: "panel" }, node("div", { class: "panel-head" }, node("h2", {}, "Execution"), node("div", { class: "actions" },
    live ? button("Send signal", () => { $("#signal-id").value = crypto.randomUUID(); $("#signal-id").readOnly = false; $("#signal-name").readOnly = false; $("#signal-dialog").dataset.runId = run.id; $("#signal-dialog").showModal(); }) : null,
    run.status === "blocked" ? button("Resume", () => void resume(run).catch(() => {}), { id: "resume-run" }) : null,
    live ? button("Cancel run", () => { const dialog = $("#cancel-dialog"); dialog.dataset.runId = run.id; dialog.dataset.requestId = crypto.randomUUID(); dialog.dataset.revision = run.revision; dialog.showModal(); }) : null,
    live && run.job ? button("Reauthorize", () => openReauthorize(run), { id: "reauthorize-run" }) : null,
  )), node("dl", { class: "metadata" }, fields.map(([key, value]) => node("div", {}, node("dt", {}, key), node("dd", {}, value)))));
  const content = state.tab === "steps" ? renderSteps() : state.tab === "history" ? renderHistory() : state.tab === "permissions" ? node("div", { class: "panel" }, node("h2", {}, "Approved execution scope"), node("p", {}, "Current policy can further restrict this scope. Credentials are identity managed and never shown here."), lazyPayload("Inspect approved grant and current permission state", `${path(run.id)}/permissions`, `scope-${run.id}`, renderPermissions)) : state.tab === "resources" ? node("div", { class: "panel" }, node("h2", {}, "Execution resources and session turns"), node("p", {}, "The portable profile does not enforce a hard total-memory cap. Logical leases do not prove that a process has exited."), lazyPayload("Inspect queue timing, payload metadata and session bindings", `${path(run.id)}/resources`, `resources-${run.id}`, renderResources)) : node("div", { class: "panel" }, lazyPayload("Load input & outcome", `${path(run.id)}/payloads`, `payload-${run.id}`));
  content.setAttribute("role", "tabpanel"); content.id = `panel-${state.tab}`; content.setAttribute("aria-labelledby", `tab-${state.tab}`);
  return node("div", {}, node("a", { href: "#runs", class: "back" }, "← All runs"), blocked ? node("div", { class: "error-box", role: "status" }, node("strong", {}, blocked.title), node("p", {}, blocked.detail)) : run.error ? node("div", { class: "error-box" }, run.error) : null,
    run.outcome?.ok === false ? node("div", { class: "error-box" }, `${run.outcome.error.code}: ${run.outcome.error.message}`) : null,
    metadata, node("div", { class: "tabs", role: "tablist", "aria-label": "Execution details" }, [["steps", "Steps & attempts"], ["history", "Event history"], ["permissions", "Permissions"], ["resources", "Resources"], ["payloads", "Input & output"]].map(([tab, title]) => button(title, () => selectTab(tab), {
      role: "tab", id: `tab-${tab}`, tabindex: state.tab === tab ? 0 : -1, "aria-controls": `panel-${tab}`, "aria-selected": state.tab === tab, class: state.tab === tab ? "selected" : "",
      onkeydown: event => { const tabs = ["steps", "history", "permissions", "resources", "payloads"], index = tabs.indexOf(tab); const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key]; if (next !== undefined) { event.preventDefault(); selectTab(tabs[next]); } },
    }))), content);
}
function selectTab(tab) { state.tab = tab; history.replaceState(null, "", detailLink(state.run.run.id, { tab, eventType: route().eventType })); renderCurrentDetail(); $(`#tab-${tab}`).focus(); }
function replaceContent(content) {
  const focused = $("#content").contains(document.activeElement) ? document.activeElement?.id : null;
  const opened = new Set([...$("#content").querySelectorAll("details[open]")].map(element => element.dataset.key));
  $("#content").replaceChildren(content);
  $("#content").querySelectorAll("details").forEach(element => { element.open = opened.has(element.dataset.key); });
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
}
function renderCurrentDetail() { if (state.run) replaceContent(renderDetail()); }
async function loadHistory() {
  if (!state.run || state.historyRequest) return;
  const id = state.run.run.id, generation = state.generation;
  const request = { id, generation };
  state.historyRequest = request;
  try {
    const page = await api(historyUrl(id)), events = page.items;
    if (state.generation !== generation || route().id !== id || state.run?.run.id !== id) return;
    state.events = [...new Map([...state.events, ...events].map(event => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence).slice(-500);
    state.historyAfter = page.nextCursor ?? state.events.at(-1)?.sequence ?? state.historyAfter;
    state.historyMore = page.nextCursor !== null; renderCurrentDetail();
  } catch (error) { if (state.generation === generation) notice(error.message); }
  finally { if (state.historyRequest === request) state.historyRequest = null; }
}
function historyUrl(id) { return `${path(id)}/history?${new URLSearchParams({ page: 1, after: state.historyAfter, type: route().eventType ?? "" })}`; }
async function refresh() {
  const generation = ++state.generation;
  if (state.busy) { state.refreshAgain = true; return; }
  state.busy = true;
  const view = route();
  const routeKey = location.hash;
  try {
    const overview = await api("/api/overview");
    if (state.generation !== generation || location.hash !== routeKey) return;
    state.overview = overview;
    renderPending();
    $("#owner").textContent = state.overview.owner;
    $("#footer-owner").textContent = state.overview.owner;
    $("#runs-link").classList.toggle("active", view.page !== "workers");
    $("#workers-link").classList.toggle("active", view.page === "workers");
    $("#counts").hidden = view.page !== "runs"; $("#filters").hidden = view.page !== "runs";
    $("#breadcrumb").textContent = view.page === "workers" ? "Workers" : view.page === "detail" ? "Execution" : "Runs";
    $("#title").textContent = view.page === "detail" ? view.id : view.page === "workers" ? "Workers" : "Runs";
    $("#subtitle").textContent = view.page === "detail" ? "The complete record of this execution." : view.page === "workers" ? "Available capacity across your activity executors." : "Every run, from first step to final result.";
    if (view.page === "runs") {
      const query = new URLSearchParams({ prefix: $("#search").value });
      if (state.cursors[state.offset / 50]) query.set("cursor", state.cursors[state.offset / 50]);
      if ($("#status").value) query.set("status", $("#status").value);
      if ($("#workflow-type").value) query.set("type", $("#workflow-type").value);
      for (const [field, param] of [["filter-worker", "worker"], ["filter-blocking-reason", "blockingReason"]]) if ($(`#${field}`).value) query.set(param, $(`#${field}`).value);
      for (const field of ["identity", "creator", "profile"]) if ($(`#filter-${field}`).value) query.set(field, $(`#filter-${field}`).value);
      for (const [field, param] of [["started-after", "startedAfter"], ["started-before", "startedBefore"]]) if ($(`#${field}`).value) query.set(param, new Date($(`#${field}`).value).getTime());
      const page = await api(`/api/v2/runs?${query}`);
      if (state.generation !== generation || location.hash !== routeKey) return;
      state.nextCursor = page.nextCursor; renderCounts(); replaceContent(renderRuns(page.items));
    } else if (view.page === "workers") replaceContent(renderWorkers());
    else {
      if (state.run?.run.id !== view.id) { state.run = null; state.events = []; state.historyMore = false; state.tab = "steps"; state.stepAfter = ""; replaceContent(empty("Loading run", view.id)); }
      state.tab = view.tab;
      if (state.stepLink !== `${view.id}:${view.step}`) { state.stepLink = `${view.id}:${view.step}`; state.stepAfter = view.step > 0 ? String(view.step - 1) : ""; }
      const historyKey = JSON.stringify([view.id, view.eventType, view.event]);
      if (state.historyKey !== historyKey) { state.historyKey = historyKey; state.events = []; state.historyMore = false; state.historyAfter = Math.max(0, view.event - 1); }
      const detail = await api(`${path(view.id)}?summary=1&after=${encodeURIComponent(state.stepAfter)}`);
      if (state.generation !== generation || location.hash !== routeKey) return;
      state.run = detail;
      const eligibility = await api(`${path(view.id)}/eligibility?after=${state.stepAfter || -1}`);
      if (state.generation !== generation || location.hash !== routeKey) return;
      state.eligibility = eligibility.items;
      if (!state.historyMore) {
        const page = await api(historyUrl(view.id)), events = page.items;
        if (state.generation !== generation || location.hash !== routeKey) return;
        state.events = [...new Map([...state.events, ...events].map(event => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence).slice(-500);
        state.historyAfter = page.nextCursor ?? state.events.at(-1)?.sequence ?? state.historyAfter;
        state.historyMore = page.nextCursor !== null;
      }
      if (state.generation !== generation || location.hash !== routeKey) return;
      renderCurrentDetail();
    }
    state.failures = 0; notice(""); $("#freshness").textContent = `Live · refreshed ${new Date().toLocaleTimeString()}`;
  } catch (error) { if (state.generation === generation) { state.failures = Math.min(4, (state.failures ?? 0) + 1); notice(error.message); $("#freshness").textContent = "Disconnected · showing last known state"; } }
  finally { state.busy = false; if (state.refreshAgain) { state.refreshAgain = false; void refresh(); } }
}
async function mutate(operation, body, id = state.run.run.id) {
  try { await api(`${path(id)}/${operation}`, body); await refresh(); }
  catch (error) { notice(error.message); throw error; }
}
async function resume(run) {
  const previous = pendingOperations(state.overview.owner).find(entry => entry.operation === "resume" && entry.runId === run.id);
  try { await control("resume", run.id, previous?.id ?? crypto.randomUUID(), previous?.expectedRevision ?? run.revision); }
  catch (error) { notice(error.message); throw error; }
}
async function control(operation, runId, requestId, expectedRevision) {
  const owner = state.overview.owner, body = { requestId, expectedRevision };
  const entry = await rememberOperation(owner, operation, runId, requestId, body); renderPending();
  try {
    const receipt = await api(`${path(runId)}/receipt?id=${encodeURIComponent(requestId)}`);
    if (!receipt) await mutate(operation, body, runId);
    forgetOperation(owner, entry); renderPending(); await refresh();
  } catch (error) {
    if (error.status === 409) { forgetOperation(owner, entry); renderPending(); throw new Error("The run changed. Inspect its current state and confirm a new request."); }
    throw error;
  }
}
function openStart(entry) {
  const definitions = state.overview.definitions;
  $("#definition").replaceChildren(...definitions.map(definition => node("option", { value: JSON.stringify(definition) }, `${definition.type} · v${definition.version}`)));
  if (entry && !definitions.some(item => item.type === entry.type && item.version === entry.version)) $("#definition").append(node("option", { value: JSON.stringify({ type: entry.type, version: entry.version }) }, `${entry.type} · v${entry.version} (original request)`));
  if (entry) { $("#definition").value = JSON.stringify({ type: entry.type, version: entry.version }); $("#run-input").value = ""; }
  $("#run-id").value = entry?.runId ?? crypto.randomUUID(); $("#run-id").readOnly = !!entry; $("#definition").disabled = !!entry;
  $("#run-bags").value = (entry?.job?.bags ?? entry?.job?.traits)?.join(", ") ?? "";
  $("#run-bounds").value = entry?.job?.bounds?.join(", ") ?? "";
  $("#run-identity").value = entry?.job?.identity ?? "";
  $("#run-harness").value = entry?.job?.harness ?? "";
  $("#start-form .form-error").textContent = entry ? "Re-enter the original input. Its fingerprint must match; no input was saved in your browser." : "";
  $("#start-dialog").showModal();
}
function openReauthorize(run, entry) {
  const dialog = $("#reauthorize-dialog");
  const currentBags = run.job.bags ?? run.job.traits ?? [];
  const currentBounds = run.job.bounds ?? [];
  dialog.dataset.runId = run.id; dialog.dataset.requestId = entry?.id ?? crypto.randomUUID(); dialog.dataset.revision = entry?.expectedRevision ?? run.revision;
  dialog.dataset.job = JSON.stringify(entry?.job ?? { bags: currentBags, ...(currentBounds.length ? { bounds: currentBounds } : {}), ...(run.job.identity ? { identity: run.job.identity } : {}), ...(run.job.harness ? { harness: run.job.harness } : {}), profile: run.job.profile ?? "portable", ...(run.job.action ? { action: run.job.action } : {}) });
  const parsedJob = JSON.parse(dialog.dataset.job);
  $("#reauthorize-bags").value = (parsedJob.bags ?? parsedJob.traits ?? []).join(", ");
  $("#reauthorize-bounds").value = (parsedJob.bounds ?? []).join(", ");
  $("#reauthorize-reason").value = "";
  $("#reauthorize-form .form-error").textContent = entry ? "Re-enter the original reason and selected bags to retry this request." : `Approved bags: ${currentBags.join(", ") || "none"}. Identity and profile remain fixed.`;
  dialog.showModal();
}
function renderPending() {
  const entries = pendingOperations(state.overview.owner);
  $("#pending").hidden = !entries.length;
  $("#pending").replaceChildren(node("strong", {}, "Unconfirmed operations"), node("p", {}, "A request may already have committed. Check or retry its original identity; do not start a replacement blindly."), ...entries.map(entry => node("div", { class: "actions" },
    node("span", {}, `${entry.operation} · ${entry.runId}`), node("a", { href: detailLink(entry.runId, {}) }, "Inspect run"),
    button("Check / retry", () => {
      if (entry.operation === "start") openStart(entry);
      else if (entry.operation === "reauthorize") {
        const owner = state.overview.owner;
        void api(`${path(entry.runId)}/receipt?id=${encodeURIComponent(entry.id)}`).then(receipt => {
          if (state.overview.owner !== owner) return;
          if (receipt) { forgetOperation(owner, entry); renderPending(); void refresh(); }
          else if (state.run?.run.id === entry.runId && state.run.run.job) openReauthorize(state.run.run, entry);
          else notice("Open this run, then check or retry the reauthorization.");
        }).catch(error => notice(error.message));
      }
      else if (entry.operation === "signal") {
        $("#signal-dialog").dataset.runId = entry.runId; $("#signal-id").value = entry.id; $("#signal-id").readOnly = true; $("#signal-name").value = entry.name; $("#signal-name").readOnly = true; $("#signal-payload").value = "";
        $("#signal-form .form-error").textContent = "Re-enter the original payload to retry the same delivery. No payload was saved in your browser."; $("#signal-dialog").showModal();
      } else void control(entry.operation, entry.runId, entry.id, entry.expectedRevision).catch(error => notice(error.message));
    }), button("Forget locally", () => { if (confirm("This only forgets browser retry metadata. It does not cancel the request or undo effects. Have you inspected the run and recorded its operation ID?")) { forgetOperation(state.overview.owner, entry); renderPending(); } }), node("code", {}, entry.id),
  )));
}
function formSubmit(form, action) {
  form.addEventListener("submit", async event => {
    event.preventDefault(); const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    form.querySelector(".form-error").textContent = "";
    try { await action(); form.closest("dialog").close(); }
    catch (error) { form.querySelector(".form-error").textContent = error.message; }
    finally { submit.disabled = false; }
  });
}
$("#new-run").addEventListener("click", () => {
  if (!state.overview) return;
  openStart();
});
formSubmit($("#start-form"), async () => {
  const definition = JSON.parse($("#definition").value);
  const bags = $("#run-bags").value.split(",").map(value => value.trim()).filter(Boolean), bounds = $("#run-bounds").value.split(",").map(value => value.trim()).filter(Boolean), identity = $("#run-identity").value.trim(), harness = $("#run-harness").value.trim();
  const body = { ...definition, id: $("#run-id").value, input: JSON.parse($("#run-input").value), job: { bags, ...(bounds.length ? { bounds } : {}), ...(identity ? { identity } : {}), ...(harness ? { harness } : {}) } }, owner = state.overview.owner;
  const entry = await rememberOperation(owner, "start", body.id, body.id, body); renderPending();
  $("#run-id").readOnly = true; $("#definition").disabled = true;
  const run = await api("/api/runs", body);
  forgetOperation(owner, entry); renderPending();
  location.hash = `runs/${encodeURIComponent(run.id)}`;
});
formSubmit($("#signal-form"), async () => {
  const body = { signalId: $("#signal-id").value, name: $("#signal-name").value, payload: JSON.parse($("#signal-payload").value) }, runId = $("#signal-dialog").dataset.runId, owner = state.overview.owner;
  const entry = await rememberOperation(owner, "signal", runId, body.signalId, body); renderPending();
  $("#signal-id").readOnly = true; $("#signal-name").readOnly = true;
  await mutate("signal", body, runId); forgetOperation(owner, entry); renderPending();
});
formSubmit($("#cancel-form"), () => { const dialog = $("#cancel-dialog"); return control("cancel", dialog.dataset.runId, dialog.dataset.requestId, Number(dialog.dataset.revision)); });
formSubmit($("#reauthorize-form"), async () => {
  const dialog = $("#reauthorize-dialog"), owner = state.overview.owner;
  const bags = $("#reauthorize-bags").value.split(",").map(value => value.trim()).filter(Boolean), bounds = $("#reauthorize-bounds").value.split(",").map(value => value.trim()).filter(Boolean);
  const baseJob = JSON.parse(dialog.dataset.job);
  delete baseJob.traits;
  delete baseJob.bounds;
  const body = { requestId: dialog.dataset.requestId, expectedRevision: Number(dialog.dataset.revision), job: { ...baseJob, bags, ...(bounds.length ? { bounds } : {}) }, reason: $("#reauthorize-reason").value };
  const entry = await rememberOperation(owner, "reauthorize", dialog.dataset.runId, body.requestId, body); renderPending();
  const receipt = await api(`${path(dialog.dataset.runId)}/receipt?id=${encodeURIComponent(body.requestId)}`);
  if (!receipt) await mutate("reauthorize", body, dialog.dataset.runId);
  forgetOperation(owner, entry); renderPending(); await refresh();
});
document.querySelectorAll("dialog").forEach(dialog => { dialog.setAttribute("aria-label", dialog.querySelector("h2").textContent); });
document.querySelectorAll(".close").forEach(element => element.addEventListener("click", () => element.closest("dialog").close()));
$("#refresh").addEventListener("click", refresh);
function updateFilters() {
  state.offset = 0; state.cursors = [""]; state.nextCursor = null;
  const query = new URLSearchParams({ prefix: $("#search").value, status: $("#status").value });
  for (const [field, param] of [["workflow-type", "type"], ["started-after", "startedAfter"], ["started-before", "startedBefore"]]) if ($(`#${field}`).value) query.set(param, $(`#${field}`).value);
  for (const [field, param] of [["filter-worker", "worker"], ["filter-blocking-reason", "blockingReason"]]) if ($(`#${field}`).value) query.set(param, $(`#${field}`).value);
  for (const field of ["identity", "creator", "profile"]) if ($(`#filter-${field}`).value) query.set(field, $(`#filter-${field}`).value);
  location.hash = `runs?${query}`; void refresh();
}
function readFilters() {
  if (route().page !== "runs") return;
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  $("#search").value = query.get("prefix") ?? ""; $("#status").value = query.get("status") ?? "";
  for (const [field, param] of [["workflow-type", "type"], ["started-after", "startedAfter"], ["started-before", "startedBefore"]]) $(`#${field}`).value = query.get(param) ?? "";
  for (const [field, param] of [["filter-worker", "worker"], ["filter-blocking-reason", "blockingReason"]]) $(`#${field}`).value = query.get(param) ?? "";
  for (const field of ["identity", "creator", "profile"]) $(`#filter-${field}`).value = query.get(field) ?? "";
}
$("#filters").addEventListener("submit", event => { event.preventDefault(); updateFilters(); });
$("#status").addEventListener("change", updateFilters);
let searchTimer;
$("#search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(updateFilters, 250); });
window.addEventListener("hashchange", () => { state.offset = 0; state.cursors = [""]; readFilters(); void refresh(); });
async function poll() {
  if (!document.hidden) {
    if (document.querySelector("dialog[open]") || $("#content").contains(document.activeElement)) $("#freshness").textContent = "Auto-refresh paused while inspecting";
    else await refresh();
  }
  setTimeout(poll, Math.min(30_000, 3000 * 2 ** (state.failures ?? 0)) + Math.random() * 500);
}
setTimeout(poll, 3000);
readFilters(); void refresh();
