import {
  formatIdentityWorkState,
  describeIdentityWorkSituation,
  validateIdentityStartInputs,
} from "./search.js";

const $ = selector => document.querySelector(selector);
const storeKey = "barry-identity-work-v1";
let storageNotice = "";
const short = value => typeof value === "string" && value.length > 0 && value.length <= 200;
const workId = value => typeof value === "string" && /^work_[a-f0-9]{32}$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const read = () => {
  try {
    const raw = sessionStorage.getItem(storeKey); if (!raw) return {};
    if (raw.length > 1_100_000) throw new Error("Oversize recovery cache");
    const value = JSON.parse(raw); if (!object(value)) throw new Error("Invalid recovery cache");
    const valid = {}, invalid = [];
    for (const name of ["pending", "pendingStop", "current", "confirmed"]) {
      const item = value[name]; if (!item) continue;
      let accepted = object(item) && short(item.session);
      if (name === "current") accepted &&= workId(item.workId);
      if (name === "confirmed") accepted &&= short(item.key);
      if (name === "pending") accepted &&= object(item.body) && uuid(item.body.request_id) && short(item.body.idempotency_key) && short(item.body.action) && /^[^:@]+:[^:@]+$/.test(item.body.action) && object(item.body.inputs);
      if (name === "pendingStop") accepted &&= workId(item.workId) && object(item.body) && uuid(item.body.request_id) && Number.isSafeInteger(item.body.expected_revision) && item.body.expected_revision >= 0 && typeof item.body.reason === "string" && item.body.reason.trim().length > 0 && item.body.reason.length <= 2000;
      if (accepted) valid[name] = name === "current" ? { workId: item.workId, session: item.session } : item; else invalid.push(name);
    }
    if (Array.isArray(value.recent)) {
      valid.recent = value.recent
        .filter(entry => object(entry) && workId(entry.workId) && short(entry.session))
        .slice(0, 12)
        .map(entry => ({ workId: entry.workId, session: entry.session, title: typeof entry.title === "string" ? entry.title.slice(0, 120) : entry.workId, key: typeof entry.key === "string" ? entry.key.slice(0, 200) : "" }));
    }
    if (invalid.length) storageNotice = "Some local recovery data was unreadable. Use the original session and submission key to find work on the server.";
    return valid;
  } catch { storageNotice = "Local recovery data is unavailable. Server lookup by the original session and key remains available."; return {}; }
};
const restored = read();
let pending = restored.pending || null, pendingStop = restored.pendingStop || null, current = restored.current || null, confirmed = restored.confirmed || null, recent = restored.recent || [];
if (pending) pending.ambiguous = true; // A previous page may have lost an accepted reply.
if (pendingStop) pendingStop.ambiguous = true;
let sessions = [], selected = "", selectedEnded = false, tasks = [], generation = 0, busy = false, stopBusy = false, polling = false, inspected = null, stopIntent = null;

function save() {
  try {
    sessionStorage.setItem(storeKey, JSON.stringify({ pending, pendingStop, current, confirmed, recent }));
  } catch { /* Server key lookup remains available when storage is unavailable. */ }
}

function recordRecent(workIdVal, sessionVal, titleVal, keyVal) {
  if (!workId(workIdVal) || !short(sessionVal)) return;
  const existing = recent.find(r => r.workId === workIdVal && r.session === sessionVal);
  const nextEntry = {
    workId: workIdVal,
    session: sessionVal,
    title: titleVal || existing?.title || workIdVal,
    key: keyVal || existing?.key || "",
  };
  recent = [nextEntry, ...recent.filter(r => !(r.workId === workIdVal && r.session === sessionVal))].slice(0, 12);
  save();
  paintRecent();
}

function paintRecent() {
  const container = $("#recent-session-work");
  const list = $("#recent-work-list");
  if (!container || !list) return;
  const activeSession = selected || $("#session-select")?.value || current?.session || "";
  const items = activeSession ? recent.filter(r => r.session === activeSession) : recent;
  if (!items.length) {
    container.hidden = true;
    list.replaceChildren();
    return;
  }
  container.hidden = false;
  list.replaceChildren(...items.map(item => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${item.title} (${item.workId})`;
    btn.addEventListener("click", () => {
      void openWork({ work_id: item.workId }, item.session);
    });
    li.append(btn);
    return li;
  }));
}

function text(id, value) {
  const el = $(id);
  const next = value ?? "";
  if (el && el.textContent !== next) el.textContent = next;
}

async function api(path, value) {
  let encoded;
  if (value !== undefined) {
    try { encoded = JSON.stringify(value); if (encoded.length > 1_000_000) throw new Error("Input exceeds the request limit."); }
    catch { throw Object.assign(new Error("The request could not be encoded within the input limit."), { disposition: "refused", stopDisposition: "refused" }); }
  }
  let response;
  try { response = await fetch(path, { method: value === undefined ? "GET" : "POST", signal: AbortSignal.timeout(15000), ...(value === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: encoded }) }); }
  catch { throw new Error("Request unconfirmed. Preserve the original session, key and input."); }
  if (response.status === 401) { location.assign("/sign-in"); throw new Error("Sign in again to continue."); }
  let result;
  try { result = await response.json(); } catch { throw new Error("Response unconfirmed. Preserve this request."); }
  if (!response.ok) throw Object.assign(new Error(result.message || (typeof result.error === "string" ? result.error : "Request failed.")), { status: response.status, disposition: result.admission_disposition, stopDisposition: result.stop_disposition });
  return result;
}
const sessionQuery = session => new URLSearchParams({ session_id: session }).toString();
function ack(value, key) {
  if (!value || typeof value.run_id !== "string" || !/^work_[a-f0-9]{32}$/.test(value.work_id) || typeof value.workflow_id !== "string" || value.idempotency_key !== key || typeof value.created !== "boolean") throw new Error("Submission acknowledgement is unconfirmed. Preserve the original request.");
  return value;
}
function paintPending(message) {
  $("#start-work").disabled = busy || Boolean(pending) || !selected || selectedEnded || !$("#task-select").value;
  $("#check-submission").disabled = !pending || busy;
  $("#retry-submission").disabled = !pending || busy;
  text("#submission-key", pending ? `Submission key: ${pending.body.idempotency_key} · Session: ${pending.session}` : confirmed ? `Confirmed key: ${confirmed.key} · Session: ${confirmed.session}` : "");
  if (message !== undefined) text("#submission-status", message);
}
function resetView() {
  generation++; inspected = null; current = null; stopIntent = null; $("#work-detail").hidden = true; $("#stop-dialog").close();
  text("#work-title", "Work");
  for (const id of ["#work-state", "#work-reason", "#work-progress", "#work-observed", "#work-error", "#work-output", "#work-partial", "#work-checks", "#result-observed", "#work-metadata", "#work-logs"]) text(id, "");
  save();
}
function fields() {
  const task = tasks.find(item => item.qualified_name === $("#task-select").value);
  text("#task-description", task?.description);
  if ($("#task-scope-summary")) {
    text("#task-scope-summary", task
      ? `Runs ${task.qualified_name} (bag ${task.bag}) in a detached process under session ${selected}. Only declared identity secrets and approved bounds are included; interactive session state and nested background launches are excluded.`
      : "");
  }
  if ($("#start-error")) { text("#start-error", ""); $("#start-error").hidden = true; }
  $("#task-fields").replaceChildren(); $("#inputs").value = "";
  const required = task?.input_schema?.required || [];
  for (const [name, spec] of Object.entries(task?.input_schema?.properties || {})) {
    const fieldId = `task-field-${name}`;
    const descId = `task-field-${name}-desc`;
    const errId = `task-field-${name}-error`;
    const wrapper = document.createElement("div");
    wrapper.className = "task-field";
    const label = document.createElement("label");
    label.setAttribute("for", fieldId);
    label.textContent = spec.title || name;
    const input = document.createElement(spec.enum || spec.type === "boolean" ? "select" : ["object", "array"].includes(spec.type) ? "textarea" : "input");
    input.id = fieldId;
    input.dataset.name = name;
    input.dataset.type = spec.type || "string";
    input.required = required.includes(name);
    input.dataset.required = String(input.required);
    const describedBy = [spec.description ? descId : null, errId].filter(Boolean).join(" ");
    if (describedBy) input.setAttribute("aria-describedby", describedBy);
    if (input.tagName === "SELECT") {
      const blank = document.createElement("option"); blank.value = ""; blank.textContent = "Choose…"; input.append(blank);
      for (const value of spec.enum || [true, false]) { const option = document.createElement("option"); option.value = JSON.stringify(value); option.textContent = String(value); input.append(option); }
      input.dataset.json = "true";
    } else if (input.tagName === "TEXTAREA") {
      input.dataset.json = "true";
    } else {
      input.type = ["integer", "number"].includes(spec.type) ? "number" : "text";
      if (input.type === "number") {
        input.step = spec.type === "integer" ? "1" : "any";
        if (typeof spec.minimum === "number") input.min = String(spec.minimum);
        if (typeof spec.maximum === "number") input.max = String(spec.maximum);
      }
    }
    if (spec.default !== undefined) input.placeholder = `Default: ${JSON.stringify(spec.default)}`;
    wrapper.append(label, input);
    if (spec.description) {
      const hint = document.createElement("p");
      hint.id = descId;
      hint.className = "field-hint";
      hint.textContent = spec.description;
      wrapper.append(hint);
    }
    const errEl = document.createElement("p");
    errEl.id = errId;
    errEl.className = "field-error";
    errEl.hidden = true;
    wrapper.append(errEl);
    $("#task-fields").append(wrapper);
  }
  paintPending();
}
async function loadSession() {
  const session = $("#session-select").value; selected = ""; selectedEnded = false; tasks = []; resetView(); const token = generation;
  $("#task-select").disabled = true; $("#task-select").replaceChildren(); paintPending(); paintRecent();
  if (!session) { text("#selection-status", "Choose an identity session."); return; }
  const sessionMeta = sessions.find(item => item.id === session);
  try {
    const catalog = await api(`/api/work/catalog?${sessionQuery(session)}`);
    if (token !== generation || $("#session-select").value !== session) return;
    selected = session;
    selectedEnded = Boolean(sessionMeta?.ended);
    tasks = (catalog.actions || []).filter(task => task.executable);
    for (const task of tasks) { const option = document.createElement("option"); option.value = task.qualified_name; option.textContent = `${task.name} · ${task.bag}`; $("#task-select").append(option); }
    $("#task-select").disabled = selectedEnded || !tasks.length;
    fields();
    paintRecent();
    if (selectedEnded) {
      text("#selection-status", `Selected ${catalog.scope?.identity || "identity"} · Session ${session} (ended · read recovery only). Ended sessions can recover and inspect prior work, but cannot start new work.`);
    } else {
      text("#selection-status", `Selected ${catalog.scope?.identity || "identity"} · Session ${session}. Current permissions are checked on every operation.`);
    }
  } catch (error) { if (token === generation) text("#selection-status", error.message); }
}
function captureInputs() {
  const task = tasks.find(item => item.qualified_name === $("#task-select").value);
  for (const input of $("#task-fields").querySelectorAll("[data-name]")) input.removeAttribute("aria-invalid");
  for (const errEl of $("#task-fields").querySelectorAll(".field-error")) { errEl.textContent = ""; errEl.hidden = true; }
  if ($("#start-error")) { text("#start-error", ""); $("#start-error").hidden = true; }
  const entries = [...$("#task-fields").querySelectorAll("[data-name]")].map(input => ({
    name: input.dataset.name,
    value: input.value,
    isJson: Boolean(input.dataset.json),
    type: input.dataset.type,
  }));
  const checked = validateIdentityStartInputs(task, entries, $("#inputs").value);
  if (!checked.ok) {
    for (const [fieldName, msg] of Object.entries(checked.fieldErrors)) {
      const inputEl = $(`#task-field-${fieldName}`);
      const errEl = $(`#task-field-${fieldName}-error`);
      if (inputEl) inputEl.setAttribute("aria-invalid", "true");
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
    }
    if ($("#start-error")) { text("#start-error", checked.message || "Invalid inputs."); $("#start-error").hidden = false; }
    throw new Error(checked.message || "Invalid inputs.");
  }
  return checked.inputs;
}
async function openWork(value, session) {
  resetView();
  current = { workId: value.work_id, session };
  recordRecent(value.work_id, session, inspected?.title, value.idempotency_key);
  save();
  await refresh();
}
async function sendSubmission() {
  if (!pending || busy) return; const intent = pending, token = generation; busy = true; paintPending("Checking admission…");
  try {
    const value = ack(await api("/api/work/start", { ...intent.body, session_id: intent.session }), intent.body.idempotency_key);
    if (pending !== intent) return; confirmed = { key: intent.body.idempotency_key, session: intent.session }; pending = null; save(); paintPending("Submission confirmed. Use its recorded session and key to find the work."); if (token === generation) await openWork(value, intent.session);
  } catch (error) {
    if (pending !== intent) return;
    if (error.disposition === "refused" && !intent.ambiguous) { pending = null; save(); paintPending(`Submission refused: ${error.message} Correct the input or permissions, then start again.`); }
    else { intent.ambiguous = true; save(); paintPending(`${error.message} Keep the original request. Check submission or retry exactly the same intent.`); }
  } finally { busy = false; paintPending(); }
}
async function lookup(key, session, intent = null) {
  if (!key || !session) return; const token = generation;
  try {
    const value = ack(await api(`/api/work/operations/${encodeURIComponent(key)}?${sessionQuery(session)}`), key);
    if (intent && pending !== intent) return;
    if (pending?.session === session && pending.body.idempotency_key === key) { confirmed = { key, session }; pending = null; save(); paintPending("Submission found. No new work was started."); }
    if (token !== generation) return;
    text("#lookup-status", "Work found."); await openWork(value, session);
  } catch (error) { if (token === generation) text("#lookup-status", `${error.message}${error.status === 404 ? " A missing lookup does not prove an in-flight submission cannot commit." : ""}`); }
}
async function refresh() {
  if (!current || polling) return; const view = current, token = generation; polling = true;
  try {
    const work = await api(`/api/work/items/${view.workId}?${sessionQuery(view.session)}`);
    if (token !== generation || current !== view) return;
    if (work.work_id !== view.workId || !Number.isSafeInteger(work.revision) || !Array.isArray(work.allowed_actions)) throw new Error("Work response does not match this selection.");
    const hadStopControl = !$("#request-stop").hidden;
    const stopFocused = document.activeElement === $("#request-stop");
    inspected = work; view.observed = true; $("#work-detail").hidden = false; text("#work-error", ""); text("#work-title", work.title);
    recordRecent(work.work_id, view.session, work.title, confirmed?.key);
    text("#work-state", formatIdentityWorkState(work, null));
    text("#work-reason", work.reason?.detail || work.reason?.code || "");
    text("#work-progress", describeIdentityWorkSituation(work));
    text("#work-observed", `Last confirmed ${new Date().toLocaleTimeString()} · Session ${view.session}`);
    const canStop = work.allowed_actions.includes("stop") && !pendingStop;
    $("#request-stop").hidden = !canStop;
    if (hadStopControl && !canStop && stopFocused) {
      $("#work-title")?.focus();
    }
    if (stopIntent && stopIntent.workId === work.work_id) {
      if (!work.allowed_actions.includes("stop")) { $("#stop-dialog").close(); stopIntent = null; }
      else stopIntent.revision = work.revision;
    }
    text("#work-metadata", JSON.stringify({ work_id: work.work_id, workflow_id: work.workflow_id, origin: work.origin, facts: work.facts, revision: work.revision }, null, 2));
    if (work.allowed_actions.includes("result")) {
      try {
        const result = await api(`/api/work/items/${view.workId}/result?${sessionQuery(view.session)}`);
        if (token !== generation || current !== view) return;
        if (result.work_id !== view.workId) throw new Error("Result does not match this work.");
        text("#work-output", JSON.stringify(result.outcome?.ok === true ? result.outcome.value : result.outcome ?? { status: result.status }, null, 2));
        const retained = result.retained_output;
        text("#work-partial", retained ? [
          `Output validation: ${retained.validation}.`,
          retained.invalid_reason,
          ...(retained.validation_failures || []),
          result.outcome?.ok === true ? null : `Retained output:\n${JSON.stringify(retained.value, null, 2)}`,
        ].filter(Boolean).join("\n") : "");
        text("#work-checks", Object.entries(result.action_checks || {}).map(([stage, check]) => `${stage}: ${check.unknown ? "unknown" : check.passed ? "passed" : "failed"}`).join(" · "));
        text("#result-observed", `Result last confirmed ${new Date().toLocaleTimeString()}`); text("#work-logs", JSON.stringify({ logs: result.logs, checks: result.action_checks, retained_output_reference: retained?.reference }, null, 2));
        text("#work-state", formatIdentityWorkState(work, result));
      } catch (error) {
        if (token === generation) {
          text("#work-error", `Result observation unavailable: ${error.message}`);
          if ([403, 404].includes(error.status)) { for (const id of ["#work-output", "#work-partial", "#work-checks", "#result-observed", "#work-logs"]) text(id, ""); }
        }
      }
    } else if (work.facts?.has_result) {
      text("#work-output", "Result access is not permitted by current policy.");
      for (const id of ["#work-partial", "#work-checks", "#result-observed", "#work-logs"]) text(id, "");
    } else {
      text("#work-output", "");
      text("#result-observed", "No result yet while work is in progress.");
      for (const id of ["#work-partial", "#work-checks", "#work-logs"]) text(id, "");
    }
  } catch (error) { if (token === generation) { inspected = null; $("#work-detail").hidden = false; $("#request-stop").hidden = true; if (!view.observed) text("#work-state", "Unavailable"); text("#work-error", `Observation unavailable: ${error.message} Check again for current state.`); } }
  finally { polling = false; }
}
function paintStop() { $("#retry-stop").hidden = !pendingStop; $("#retry-stop").disabled = stopBusy; if (pendingStop) text("#stop-status", `Stop unconfirmed · Work ${pendingStop.workId} · Request ${pendingStop.body.request_id} · Session ${pendingStop.session}. ${pendingStop.error || ""} Retry preserves the original revision and reason.`); }
async function sendStop() {
  if (!pendingStop || stopBusy) return; const intent = pendingStop; stopBusy = true; paintStop();
  try {
    const value = await api(`/api/work/items/${intent.workId}/stop?${sessionQuery(intent.session)}`, intent.body);
    if (value.version !== 2 || value.work_id !== intent.workId || value.request_id !== intent.body.request_id || value.stop_requested !== true || !Number.isSafeInteger(value.applied_revision) || value.applied_revision < intent.body.expected_revision || !Number.isSafeInteger(value.applied_at) || value.applied_at < 0) throw new Error("Stop acknowledgement is unconfirmed.");
    pendingStop = null; save(); text("#stop-status", `Stop requested for ${intent.workId}. Execution settlement is still being checked.`); $("#stop-dialog").close(); await refresh();
  } catch (error) {
    if (error.stopDisposition === "refused" && !intent.ambiguous) { pendingStop = null; save(); text("#stop-status", `Stop refused: ${error.message} Inspect the current work before making another request.`); $("#stop-dialog").close(); await refresh(); }
    else { intent.ambiguous = true; intent.error = error.message; save(); }
  }
  finally { stopBusy = false; paintStop(); }
}
$("#load-session").addEventListener("click", () => void loadSession());
$("#session-select").addEventListener("change", () => { selected = ""; selectedEnded = false; resetView(); paintPending(); paintRecent(); text("#selection-status", "Use this session to load its tasks."); });
$("#task-select").addEventListener("change", fields);
$("#inputs").addEventListener("input", () => { for (const input of $("#task-fields").querySelectorAll("[data-name]")) input.required = !$("#inputs").value.trim() && input.dataset.required === "true"; });
$("#start-form").addEventListener("submit", event => { event.preventDefault(); if (!selected || selectedEnded || pending || busy) return; try { pending = { session: selected, body: { action: $("#task-select").value, request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), inputs: captureInputs() }, ambiguous: false }; save(); void sendSubmission(); } catch (error) { text("#submission-status", error.message); } });
$("#retry-submission").addEventListener("click", () => void sendSubmission());
$("#check-submission").addEventListener("click", () => { if (pending) void lookup(pending.body.idempotency_key, pending.session, pending); });
$("#lookup-form").addEventListener("submit", event => { event.preventDefault(); void lookup($("#lookup-key").value.trim(), selected || $("#session-select").value); });
$("#work-id-form")?.addEventListener("submit", event => {
  event.preventDefault();
  const idVal = $("#inspect-work-id")?.value?.trim() || "";
  const sessionVal = selected || $("#session-select").value;
  if (!sessionVal) { text("#lookup-status", "Choose an identity session before inspecting a work ID."); return; }
  if (!workId(idVal)) { text("#lookup-status", "Enter a valid canonical work ID (work_...)."); return; }
  text("#lookup-status", `Opening ${idVal}…`);
  void openWork({ work_id: idVal }, sessionVal);
});
$("#request-stop").addEventListener("click", () => { if (!current || !inspected || pendingStop) return; stopIntent = { workId: current.workId, session: current.session, revision: inspected.revision }; $("#stop-dialog").showModal(); });
$("#dismiss-stop").addEventListener("click", () => $("#stop-dialog").close());
$("#stop-form").addEventListener("submit", event => { event.preventDefault(); if (!stopIntent || pendingStop) return; pendingStop = { workId: stopIntent.workId, session: stopIntent.session, body: { request_id: crypto.randomUUID(), expected_revision: stopIntent.revision, reason: $("#stop-reason").value.trim() }, ambiguous: false }; save(); void sendStop(); });
$("#retry-stop").addEventListener("click", () => void sendStop());
(async () => {
  paintPending(pending ? "A prior submission is unconfirmed. Check its original key or retry the same intent." : storageNotice || "No unconfirmed submission."); paintStop();
  try {
    const result = await api("/api/work/sessions");
    sessions = result.sessions || [];
    for (const session of sessions) { const option = document.createElement("option"); option.value = session.id; option.textContent = `${session.name || session.id} · Identity ${session.identity_id}${session.ended ? " · ended (read recovery)" : ""}`; $("#session-select").append(option); }
    const hashParams = new URLSearchParams(location.hash.slice(1));
    const hashWorkId = hashParams.get("work_id");
    const hashSessionId = hashParams.get("session_id");
    if (hashWorkId && workId(hashWorkId) && hashSessionId && short(hashSessionId) && !pending && !current) {
      current = { workId: hashWorkId, session: hashSessionId };
    }
    const original = pending?.session || current?.session;
    if (original) $("#session-select").value = original;
    paintRecent();
    if (current) await refresh();
  } catch (error) { text("#selection-status", error.message); }
})();
setInterval(() => { if (current) void refresh(); }, 1500);

