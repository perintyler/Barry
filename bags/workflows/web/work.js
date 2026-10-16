import { api } from "./api.js";
import {
  describeWorkState,
  describeWorkReason,
  describeWorkProgress,
  deriveSchemaFields,
  buildAndValidateStartInputs,
  classifyAdmissionFailure,
  classifyStopFailure,
} from "./waiting-reasons.js";

const $ = selector => document.querySelector(selector);
const labels = { queued: "Queued", running: "Running", waiting: "Waiting", "waiting-for-approval": "Waiting for approval", stopping: "Stopping", "needs-attention": "Needs attention", completed: "Completed", failed: "Failed", cancelled: "Cancelled" };
const views = { active: ["queued", "running", "waiting", "waiting-for-approval", "stopping"], attention: ["needs-attention"], scheduled: ["queued", "running", "waiting", "waiting-for-approval", "stopping", "needs-attention", "completed", "failed", "cancelled"], history: ["completed", "failed", "cancelled"] };
const viewTitles = { active: "Active", attention: "Needs attention", scheduled: "Scheduled", history: "History" };
const state = { meta: null, metaAt: 0, current: null, result: null, detailVersion: null, route: "", cursor: null, items: [], pages: 0, busy: false, generation: 0, observed: null, submitting: false, liveAnnouncement: "" };

function load(key) { try { return JSON.parse(sessionStorage.getItem(key) ?? "null"); } catch { return null; } }
function save(key, value) { try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* Server lookup remains available without browser storage. */ } }
let stopIntent = null, dialogDefinitions = [], reviewIntent = null, reviewGeneration = 0, sendingReconciliation = false;
let pending = load("barry-work-submission"), pendingStop = load("barry-work-stop"), pendingReconciliation = load("barry-work-reconciliation");
if (!pendingReconciliation?.workId || !pendingReconciliation.body?.request_id) pendingReconciliation = null;
if (!pending?.idempotency_key || !pending.definition) pending = null;
if (!pendingStop?.workId || !pendingStop.body?.request_id) pendingStop = null;

function node(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) { if (key.startsWith("on")) element.addEventListener(key.slice(2), value); else if (value !== undefined) element.setAttribute(key, String(value)); }
  element.append(...children.flat().filter(value => value !== null && value !== undefined)); return element;
}
const button = (text, action, key) => node("button", { type: "button", class: "secondary", onclick: action, ...(key ? { "data-focus": key } : {}) }, text);

function announcePolite(text) {
  const region = $("#work-live-status");
  if (!region || !text || state.liveAnnouncement === text) return;
  state.liveAnnouncement = text;
  region.textContent = text;
}

function notice(text) {
  const el = $("#work-notice");
  if (el.textContent !== text) el.textContent = text;
  el.hidden = !text;
}

function connection(online) {
  if (online && state.offline) { notice(""); state.offline = false; }
  if (!online) state.offline = true;
  const text = online ? "Connected" : "Offline · showing last confirmed state";
  if ($("#connection").textContent !== text) $("#connection").textContent = text;
  if (online) state.observed = new Date();
  if (state.observed) { $("#observed").textContent = `Last confirmed ${state.observed.toLocaleTimeString()}`; $("#observed").dateTime = state.observed.toISOString(); }
}

function route() {
  const hash = location.hash.slice(1);
  if (hash.startsWith("work/")) {
    try { return { id: decodeURIComponent(hash.slice(5)) }; } catch { return { view: "active" }; }
  }
  return { view: views[hash] ? hash : "active" };
}

function paintPending() {
  $("#submission-pending").hidden = !pending; $("#pending-key").textContent = pending?.idempotency_key ?? "";
  $("#reconcile-pending").hidden = !pendingReconciliation; $("#reconcile-request").textContent = pendingReconciliation?.body.request_id ?? "";
  $("#stop-pending").hidden = !pendingStop;
  if ($("#stop-request")) $("#stop-request").textContent = pendingStop?.body?.request_id ?? "";
  $("#start-task").disabled = !state.meta?.work?.enabled || Boolean(pending) || state.submitting;
}

function replaceContent(content) {
  const container = $("#work-content");
  const active = document.activeElement;
  const hadFocusInside = active && container.contains(active);
  const focused = active?.dataset?.focus;
  const opened = [...container.querySelectorAll("details[open]")].map(element => element.dataset.key);
  container.replaceChildren(content);
  for (const element of container.querySelectorAll("details")) if (opened.includes(element.dataset.key)) element.open = true;
  if (focused) {
    const target = [...container.querySelectorAll("[data-focus]")].find(element => element.dataset.focus === focused);
    if (target) {
      target.focus({ preventScroll: true });
      return;
    }
  }
  if (hadFocusInside && document.activeElement === document.body) {
    const fallback = $("#work-detail-title") ?? container;
    fallback.focus({ preventScroll: true });
  }
}

function listQueryForView(view, cursor) {
  const params = new URLSearchParams({ limit: "25", states: views[view].join(",") });
  if (view === "scheduled") params.set("trigger", "schedule");
  if (cursor) params.set("cursor", cursor);
  return params;
}

function renderList(view, total) {
  const cards = state.items.map(work => {
    const stateDesc = describeWorkState(work);
    const progress = describeWorkProgress(work);
    return node("article", { class: "work-card" }, node("div", {},
      node("h3", {}, node("a", { href: `#work/${encodeURIComponent(work.work_id)}`, "data-focus": work.work_id }, work.title)),
      node("p", {}, source(work)),
      work.reason ? node("p", {}, work.reason.detail) : null,
      node("p", { class: "subtext" }, progress.timingSummary),
      node("time", { datetime: new Date(work.accepted_at).toISOString() }, `Accepted ${new Date(work.accepted_at).toLocaleString()}`)),
      node("div", {},
        node("span", { class: `work-state ${work.state}` }, labels[work.state] ?? work.state),
        stateDesc.qualifier ? node("span", { class: "subtext", style: "display:block;text-align:right;margin-top:4px" }, stateDesc.qualifier) : null));
  });
  const scheduleBanner = view === "scheduled"
    ? node("p", { class: "work-meta-note" }, "Scheduled tasks show work started by a schedule trigger. Stopping an active run here stops only that run; pausing a schedule only prevents future triggers.")
    : null;
  replaceContent(node("div", {},
    node("div", { class: "work-list-heading" }, node("h2", { id: "view-title" }, viewTitles[view]), node("p", {}, `${total} ${total === 1 ? "task" : "tasks"}`)),
    scheduleBanner,
    cards.length ? node("div", { class: "work-cards" }, cards) : node("div", { class: "work-panel" }, node("h3", {}, "No work in this view"), node("p", {}, view === "active" ? "Start a named task to follow its progress here." : view === "scheduled" ? "Runs triggered by a schedule will appear here." : "Confirmed tasks will appear here when their state matches this view."))));
  $("#work-more").hidden = !state.cursor;
}

function source(work) {
  const who = work.namespace.principal_kind === "operator" ? "Started by you" : work.origin.trigger === "schedule" ? "Started by a schedule" : work.origin.trigger === "event" ? "Started by an event" : "Started by an identity";
  return `${who} · ${work.source.reference}`;
}

function explanation(work) {
  if (work.reason) return work.reason.detail;
  if (work.state === "waiting" && work.facts.wait === "timer") return "Waiting for the task’s timer. It does not hold an execution slot while it waits.";
  return ({ queued: "Accepted. Waiting for an executor that meets the task’s current requirements.", running: "Execution is in progress.", stopping: "Stop was requested. Physical cessation has not yet been confirmed.", "waiting-for-approval": "Waiting for an approval or caller decision before continuing.", "needs-attention": "The outcome or execution ownership needs review. Inspect the retained evidence before taking another action.", completed: "The task finished and its result is available.", failed: "The task failed. Its result may include retained partial output.", cancelled: "The task was cancelled and execution cessation is confirmed." })[work.state] ?? "Waiting for the next permitted action.";
}

function renderDetail(work) {
  const currentResult = state.result?.work_id === work.work_id ? state.result : null;
  const stateDesc = describeWorkState(work, currentResult);
  const reasonDesc = describeWorkReason(work);
  const progress = describeWorkProgress(work);
  const actions = [];
  if (work.allowed_actions.includes("result")) actions.push(button("View result", () => getResult(work.work_id), "result"));
  if (work.allowed_actions.includes("stop")) actions.push(button("Stop task", () => { stopIntent = { workId: work.work_id, revision: work.revision }; $("#stop-error").textContent = ""; if ($("#stop-reason")) $("#stop-reason").value = ""; $("#stop-dialog").showModal(); }, "stop"));
  if (work.allowed_actions.includes("reconcile") && work.can_review_reconciliation) actions.push(button("Review recovery evidence", () => void openReview(work), "reconcile"));
  if (work.allowed_actions.includes("run-again") && state.meta?.work?.enabled) {
    const matchIndex = (state.meta?.work?.definitions ?? []).findIndex(def => def.reference === work.source.reference && def.kind === work.source.kind);
    if (matchIndex >= 0) {
      actions.push(button("Run again", () => {
        $("#task-error").textContent = "";
        dialogDefinitions = structuredClone(state.meta?.work?.definitions ?? []);
        $("#task-definition").replaceChildren(...dialogDefinitions.map((task, index) => node("option", { value: index }, task.title)));
        $("#task-definition").value = String(matchIndex);
        renderFields();
        $("#task-dialog").showModal();
      }, "run-again"));
    }
  }
  const unsupportedNotices = [];
  if (work.allowed_actions.includes("continue")) unsupportedNotices.push("Continue is not directly available on this v2 view; use the execution inspector if manual resume is required.");
  if (work.allowed_actions.includes("retry-step")) unsupportedNotices.push("In-place step retry is not exposed on this v2 view; use Run again for a new invocation.");
  if (work.allowed_actions.includes("respond") || work.state === "waiting-for-approval") unsupportedNotices.push("Waiting for a decision response; typed v2 decision submission is not exposed on this route yet.");

  const detail = node("div", {}, node("a", { class: "work-back", href: "#active" }, "← All active work"),
    node("section", { class: "work-panel" },
      node("div", { class: "work-detail-heading" },
        node("h2", { id: "work-detail-title", tabindex: "-1" }, work.title),
        node("div", {},
          node("span", { class: `work-state ${work.state}`, role: "status" }, labels[work.state] ?? work.state),
          stateDesc.qualifier ? node("span", { id: "work-state-qualifier", class: "subtext", style: "margin-left:8px" }, `(${stateDesc.qualifier})`) : null)),
      node("p", {}, source(work)),
      node("p", {}, explanation(work)),
      work.reason && reasonDesc.guidance ? node("p", { class: "work-meta-note" }, `${reasonDesc.label}: ${reasonDesc.guidance}`) : null,
      node("p", {}, `Accepted ${new Date(work.accepted_at).toLocaleString()}`),
      node("p", {}, work.first_started_at === null ? "Execution has not started." : `Execution first started ${new Date(work.first_started_at).toLocaleString()}`),
      node("p", { class: "subtext" }, `${progress.stageLabel} · ${progress.timingSummary}`),
      node("div", { class: "actions" }, actions),
      ...unsupportedNotices.map(text => node("p", { class: "subtext" }, text)),
      node("details", { class: "work-details", "data-key": "execution" }, node("summary", { "data-focus": "execution" }, "Execution details"),
        node("dl", {},
          node("dt", {}, "Work ID"), node("dd", {}, work.work_id),
          node("dt", {}, "Revision"), node("dd", {}, String(work.revision)),
          node("dt", {}, "Logical coordinator"), node("dd", {}, work.facts.coordinator),
          node("dt", {}, "Physical state"), node("dd", {}, work.facts.physical),
          node("dt", {}, "Effect certainty"), node("dd", {}, work.facts.effect),
          node("dt", {}, "Stop requested"), node("dd", {}, work.facts.stop_requested ? "Yes (awaiting cessation unless Cancelled)" : "No"),
          work.origin?.caller_session_id ? [node("dt", {}, "Caller session"), node("dd", {}, work.origin.caller_session_id)] : []),
        node("a", { href: `/#runs/${encodeURIComponent(work.workflow_id)}` }, "Open execution inspector"),
        work.can_review_reconciliation && !work.allowed_actions.includes("reconcile") ? button("Review recovery evidence", () => void openReview(work), "reconcile") : null)),
    node("section", { id: "work-result", class: "work-panel", "aria-label": "Task result", hidden: "" }));
  replaceContent(detail); $("#work-more").hidden = true;
  announcePolite(`${work.title}: ${labels[work.state] ?? work.state}${stateDesc.qualifier ? ` (${stateDesc.qualifier})` : ""}`);
  if (state.result?.work_id === work.work_id) renderResult(state.result);
}

function renderResult(result) {
  const target = $("#work-result"); if (!target) return; target.hidden = false;
  const content = [node("h3", {}, "Result")];
  if (result.revision < (state.current?.revision ?? 0)) content.push(node("p", {}, "Earlier confirmed output. Use View result to check for a newer outcome."));
  if (result.status === "pending") content.push(node("p", {}, "No result has been confirmed yet."));
  if (result.outcome?.ok) content.push(node("pre", {}, JSON.stringify(result.outcome.value, null, 2)));
  else if (result.outcome) content.push(node("p", { class: "work-result-note" }, result.outcome.error.message));
  for (const [stage, check] of Object.entries(result.action_checks ?? {})) {
    content.push(node("h4", {}, stage === "preflight" ? "Preflight check" : "Postconditions"), node("p", {}, check.passed ? "Passed" : check.unknown ? "Unknown" : "Not passed"));
    if (check.detail) content.push(node("p", {}, check.detail));
    for (const failure of check.failures ?? []) content.push(node("p", {}, failure));
  }
  if (result.retained_output && (!result.outcome?.ok || result.retained_output.validation === "failed" || result.retained_output.invalid_reason)) {
    content.push(
      node("h4", {}, "Retained partial output"),
      node("p", {}, result.retained_output.invalid_reason ?? (result.retained_output.validation === "failed" ? "Output did not pass validation." : "This output is separate from the final workflow outcome.")),
      ...(result.retained_output.validation_failures ?? []).map(failure => node("p", {}, failure)),
      node("pre", {}, JSON.stringify(result.retained_output.value, null, 2)),
    );
  }
  for (const log of result.logs ?? []) {
    const detail = node("details", {}, node("summary", {}, `${log.stage} logs`));
    if (log.invalid_reason) detail.append(node("p", {}, log.invalid_reason));
    if (log.value?.stdout) detail.append(node("h4", {}, "Standard output"), node("pre", {}, log.value.stdout));
    if (log.value?.stderr) detail.append(node("h4", {}, "Standard error"), node("pre", {}, log.value.stderr));
    if (log.value?.stdout_truncated || log.value?.stderr_truncated) detail.append(node("p", {}, "Only a bounded portion of these logs was retained."));
    content.push(detail);
  }
  target.replaceChildren(...content);
}

async function getResult(id) {
  try {
    const result = await api(`/api/v2/work/${encodeURIComponent(id)}/result`);
    if (state.current?.work_id !== id || (state.result && state.result.revision > result.revision)) return;
    state.result = result;
    renderResult(result);
  } catch (error) { notice(error.message); }
}

async function refresh(force = false) {
  if ((state.busy || state.loadingMore) && !force) return;
  const generation = ++state.generation, selected = route(), key = selected.id ?? selected.view; state.busy = true;
  const navigated = state.route !== key;
  if (navigated) { state.current = null; state.result = null; state.detailVersion = null; state.cursor = null; state.items = []; state.pages = 0; state.route = key; }
  for (const link of document.querySelectorAll("[data-view]")) { if (link.dataset.view === selected.view) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current"); }
  try {
    if (force || !state.meta || Date.now() - state.metaAt > 10000) {
      try {
        const meta = await api("/api/metadata"); if (generation !== state.generation) return;
        state.meta = meta; state.metaAt = Date.now();
        $("#admission-status").textContent = meta.recovery?.active === false ? "New work is paused after restore. Review the recovery gap and activate admission before starting new invocations. Existing work, results and recovery remain available." : meta.recovery?.active && meta.work?.enabled ? "New work is enabled after recovery. Starting a task creates a new invocation; unconfirmed earlier invocations still need investigation." : meta.work?.enabled ? "" : "Starting a task from this page is not configured. Existing work and results remain available.";
        paintPending();
      } catch (error) { notice(error.message); }
    }
    if (selected.id) {
      const work = await api(`/api/v2/work/${encodeURIComponent(selected.id)}`); if (generation !== state.generation) return;
      state.current = work;
      if (!work.can_review_reconciliation && reviewIntent?.workId === work.work_id) $("#reconcile-dialog").close();
      if (stopIntent?.workId === work.work_id) {
        if (!work.allowed_actions.includes("stop")) { if ($("#stop-dialog").open) $("#stop-dialog").close(); stopIntent = null; }
        else stopIntent.revision = work.revision;
      }
      const detailVersion = JSON.stringify([work.revision, work.state, work.allowed_actions, work.can_review_reconciliation, work.reason]);
      if (state.detailVersion !== detailVersion) { state.detailVersion = detailVersion; renderDetail(work); }
    } else if (force || state.pages <= 1) {
      const value = await api(`/api/v2/work?${listQueryForView(selected.view)}`); if (generation !== state.generation) return;
      state.items = value.items; state.cursor = value.next_cursor; state.pages = 1; renderList(selected.view, value.total);
    }
    if (navigated) $("#work-content").focus();
    connection(true);
  } catch (error) { if (generation === state.generation) { connection(false); notice(error.status === undefined ? "Connection lost. Your last confirmed task state remains visible. Use Refresh to reconnect." : error.message); } }
  finally { if (generation === state.generation) state.busy = false; }
}

async function lookup(key) {
  const found = await api(`/api/v2/work/operations?${new URLSearchParams({ key })}`);
  if (pending?.idempotency_key === key) { pending = null; save("barry-work-submission", null); paintPending(); }
  location.hash = `work/${encodeURIComponent(found.work_id)}`;
  return found;
}

async function checkSubmission() {
  if (!pending) return;
  try { await lookup(pending.idempotency_key); pending = null; save("barry-work-submission", null); paintPending(); notice(""); }
  catch (error) { notice(error.status === 404 ? "No acceptance is confirmed for this key yet. Retry the same submission to resolve it; do not replace its key or input." : error.message); }
}

async function submit(body) {
  if (state.submitting) return; const initialHash = location.hash; state.submitting = true; paintPending(); $("#submit-task").disabled = true;
  try {
    const accepted = await api("/api/v2/work/start", { ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== "uncertain")), request_id: crypto.randomUUID() });
    pending = null; save("barry-work-submission", null); paintPending(); $("#task-dialog").close(); notice("");
    if (location.hash === initialHash) location.hash = `work/${encodeURIComponent(accepted.work.work_id)}`;
    else notice("Task accepted. It is available in Active or History.");
    await refresh(true);
  } catch (error) {
    $("#task-error").textContent = error.message;
    const classified = classifyAdmissionFailure(error, Boolean(body.uncertain));
    if (classified.outcome === "refused") {
      pending = null; save("barry-work-submission", null);
      notice(`Task was not accepted. Correct the input and submit again. ${error.message}`);
    } else {
      pending = { ...body, uncertain: true }; save("barry-work-submission", pending);
      notice(`Submission reply not confirmed. ${error.message}`);
    }
  }
  finally { state.submitting = false; $("#submit-task").disabled = false; paintPending(); }
}

function definition() { return dialogDefinitions[Number($("#task-definition").value)]; }

function renderFields() {
  const task = definition(); if (!task) return;
  $("#task-description").textContent = task.description ?? "";
  if ($("#task-placement")) {
    const kindLabel = task.kind === "action" ? `Installed action (${task.catalog_namespace ?? "bag"})` : task.kind === "job" ? "Registered node job" : `Workflow definition (v${task.version ?? "1"})`;
    $("#task-placement").textContent = `Started by you · ${kindLabel}. Barry selects an eligible executor within the task’s accepted permissions.`;
  }
  const derived = deriveSchemaFields(task);
  const fields = derived.map(field => {
    const describedBy = [field.description ? field.descId : null, field.errorId].filter(Boolean).join(" ");
    let input;
    if (field.control === "select" && field.enumValues) {
      input = node("select", { id: field.id, "data-property": field.name, "data-type": field.type, "aria-describedby": describedBy, ...(field.required ? { required: "" } : {}) },
        ...(!field.required ? [node("option", { value: "" }, "Select an option")] : []),
        ...field.enumValues.map(opt => node("option", { value: opt }, opt)));
      if (field.defaultValue !== undefined) input.value = String(field.defaultValue);
    } else if (field.control === "checkbox") {
      input = node("input", { id: field.id, type: "checkbox", "data-property": field.name, "data-type": "boolean", "aria-describedby": describedBy });
      input.checked = Boolean(field.defaultValue);
      return node("div", {},
        node("label", { for: field.id, class: "work-checkbox" }, input, field.label),
        field.description ? node("p", { id: field.descId, class: "field-description" }, field.description) : null,
        node("p", { id: field.errorId, class: "field-error", hidden: "" }));
    } else if (field.control === "textarea" || field.control === "json") {
      input = node("textarea", { id: field.id, "data-property": field.name, "data-type": field.type, "aria-describedby": describedBy, ...(field.required ? { required: "" } : {}) });
      input.value = field.defaultValue !== undefined ? (typeof field.defaultValue === "string" ? field.defaultValue : JSON.stringify(field.defaultValue)) : "";
    } else {
      input = node("input", { id: field.id, "data-property": field.name, "data-type": field.type, "aria-describedby": describedBy, ...(field.required ? { required: "" } : {}) });
      if (field.control === "number") {
        input.type = "number";
        input.step = String(field.step ?? "1");
        if (field.minimum !== undefined) input.min = String(field.minimum);
        if (field.maximum !== undefined) input.max = String(field.maximum);
        input.value = field.defaultValue !== undefined ? String(field.defaultValue) : "0";
      } else {
        input.value = field.defaultValue !== undefined ? String(field.defaultValue) : "";
      }
    }
    return node("div", {},
      node("label", { for: field.id }, field.label),
      field.description ? node("p", { id: field.descId, class: "field-description" }, field.description) : null,
      input,
      node("p", { id: field.errorId, class: "field-error", hidden: "" }));
  });
  $("#task-fields").replaceChildren(...fields);
}

$("#start-task").addEventListener("click", () => {
  $("#task-error").textContent = "";
  dialogDefinitions = structuredClone(state.meta?.work?.definitions ?? []);
  $("#task-definition").replaceChildren(...dialogDefinitions.map((task, index) => node("option", { value: index }, task.title)));
  renderFields();
  $("#task-dialog").showModal();
});
$("#task-definition").addEventListener("change", renderFields);
$("#task-form").addEventListener("submit", event => {
  event.preventDefault(); if (pending) return;
  try {
    const task = definition();
    if (!task) return;
    for (const input of $("#task-fields").querySelectorAll("[data-property]")) input.removeAttribute("aria-invalid");
    for (const errEl of $("#task-fields").querySelectorAll(".field-error")) { errEl.textContent = ""; errEl.hidden = true; }
    let inputs;
    if ($("#use-json").checked) {
      const checked = buildAndValidateStartInputs(task, {}, $("#task-json").value, true);
      if (!checked.ok) { $("#task-error").textContent = checked.extraError || "Invalid JSON input."; return; }
      inputs = checked.inputs;
    } else {
      const rawValues = {};
      for (const input of $("#task-fields").querySelectorAll("[data-property]")) {
        rawValues[input.dataset.property] = input.type === "checkbox" ? input.checked : input.value;
      }
      const checked = buildAndValidateStartInputs(task, rawValues, "");
      if (!checked.ok) {
        const derived = deriveSchemaFields(task);
        for (const field of derived) {
          const msg = checked.fieldErrors[field.name];
          if (msg) {
            const inputEl = $(`#${field.id}`);
            const errEl = $(`#${field.errorId}`);
            if (inputEl) inputEl.setAttribute("aria-invalid", "true");
            if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
          }
        }
        $("#task-error").textContent = Object.values(checked.fieldErrors)[0] || checked.extraError || "Check the highlighted fields before starting.";
        return;
      }
      inputs = checked.inputs;
    }
    pending = {
      version: 2,
      request_id: crypto.randomUUID(),
      idempotency_key: state.meta?.recovery?.active ? `${state.meta.recovery.epoch}:${crypto.randomUUID()}` : crypto.randomUUID(),
      ...(state.meta?.recovery?.active ? { recovery_epoch: state.meta.recovery.epoch } : {}),
      definition: { kind: task.kind, reference: task.reference, ...(task.kind === "workflow" ? { version: task.version } : task.kind === "action" ? { catalog_namespace: task.catalog_namespace } : {}) },
      inputs,
    };
    save("barry-work-submission", pending); paintPending(); void submit(pending);
  } catch (error) { $("#task-error").textContent = error.message; }
});

function applicable(receipt) { return receipt.outcome !== "uncertain" && receipt.effect_certainty === "known" && ["ceased", "not-started"].includes(receipt.physical_state); }
async function openReview(work) {
  const generation = ++reviewGeneration; reviewIntent = null;
  $("#reconcile-task").textContent = work.title; $("#reconcile-error").textContent = ""; $("#reconcile-evidence").textContent = "Loading verified evidence…";
  $("#reconcile-receipt").replaceChildren(); $("#reconcile-receipt").disabled = true; $("#submit-reconcile").disabled = true;
  $("#reconcile-reason").value = ""; $("#reconcile-risk").value = ""; $("#reconcile-dialog").showModal();
  try {
    const evidence = await api(`/api/v2/work/${encodeURIComponent(work.work_id)}/reconciliation`);
    if (generation !== reviewGeneration || route().id !== work.work_id || !$("#reconcile-dialog").open) return;
    if (evidence.work_id !== work.work_id) throw new Error("Recovery evidence belongs to another task. Refresh before reviewing.");
    reviewIntent = { workId: work.work_id, revision: evidence.revision, receipts: evidence.receipts };
    $("#reconcile-task").textContent = `${work.title} · reviewed revision ${evidence.revision}`;
    $("#reconcile-evidence").replaceChildren(node("div", {},
      ...(evidence.receipts.length ? evidence.receipts.map(receipt => node("article", {}, node("h3", {}, `Retained ${receipt.outcome} outcome`), node("p", {}, receipt.summary),
        node("p", {}, `Physical state: ${receipt.physical_state}. Effect certainty: ${receipt.effect_certainty}. Validation: ${receipt.validation}.`),
        receipt.invalid_output ? node("p", {}, receipt.invalid_output) : null,
        ...(receipt.validation_failures ?? []).map(failure => node("p", {}, failure)),
        !applicable(receipt) ? node("p", {}, "This evidence cannot be applied. Cessation and the original outcome must be proven first.") : null)) : [node("p", {}, "No retained executor receipt is available. A new launch cannot repair unknown effects.")]),
      evidence.truncated ? node("p", {}, "Showing the latest 100 receipts. Inspect the full execution history before deciding.") : null,
      node("h3", {}, "Recorded decisions"), ...(evidence.audit.length ? evidence.audit.map(entry => node("details", {}, node("summary", {}, `Decision ${entry.request_id}`),
        node("p", {}, `By ${entry.evidence.actor}: ${entry.evidence.reason}`), node("p", {}, `Accepted risk: ${entry.evidence.residualRisk}`))) : [node("p", {}, "No reconciliation decision has been recorded.")])));
    $("#reconcile-receipt").replaceChildren(node("option", { value: "" }, "Choose a reviewed outcome"), ...evidence.receipts.map((receipt, index) => node("option", { value: index, ...(!applicable(receipt) ? { disabled: "" } : {}) }, `${receipt.outcome}: ${receipt.summary.slice(0, 100)}`)));
    $("#reconcile-receipt").disabled = !work.allowed_actions.includes("reconcile") || Boolean(pendingReconciliation) || evidence.truncated || !evidence.receipts.some(applicable);
  } catch (error) { if (generation === reviewGeneration) $("#reconcile-error").textContent = error.message; }
}
function clearReconciliation() { pendingReconciliation = null; save("barry-work-reconciliation", null); paintPending(); }
async function sendReconciliation() {
  if (!pendingReconciliation || sendingReconciliation) return;
  const intent = structuredClone(pendingReconciliation); sendingReconciliation = true; $("#submit-reconcile").disabled = true;
  try {
    const ack = await api(`/api/v2/work/${encodeURIComponent(intent.workId)}/reconciliation`, intent.body);
    if (ack.request_id !== intent.body.request_id || ack.work_id !== intent.workId || ack.receipt_digest !== intent.body.receipt_digest) throw new Error("Recovery acknowledgement did not match this decision. Check its recorded audit.");
    clearReconciliation(); if (reviewIntent?.workId === intent.workId) $("#reconcile-dialog").close(); notice("Recovery decision recorded. The original activity was not launched again."); await refresh(true);
  } catch (error) {
    if (pendingReconciliation?.body.request_id === intent.body.request_id && ["WorkRevisionConflict", "WorkReconciliationConflict", "WorkReconciliationUnproven"].includes(error.code)) {
      pendingReconciliation.refused = true; save("barry-work-reconciliation", pendingReconciliation);
    }
    if (reviewIntent?.workId === intent.workId) $("#reconcile-error").textContent = error.message; notice(`Check recovery request ${intent.body.request_id} before making another decision. ${error.message}`);
  }
  finally { sendingReconciliation = false; paintPending(); }
}
$("#reconcile-receipt").addEventListener("change", () => { $("#submit-reconcile").disabled = $("#reconcile-receipt").disabled || $("#reconcile-receipt").value === "" || Boolean(pendingReconciliation) || sendingReconciliation; });
$("#reconcile-dialog").addEventListener("close", () => { reviewGeneration++; reviewIntent = null; });
$("#reconcile-form").addEventListener("submit", event => {
  event.preventDefault(); if (!reviewIntent || pendingReconciliation || sendingReconciliation || $("#reconcile-receipt").disabled || $("#reconcile-receipt").value === "" || route().id !== reviewIntent.workId) return;
  const receipt = reviewIntent.receipts[Number($("#reconcile-receipt").value)]; if (!receipt || !applicable(receipt)) return;
  const reason = $("#reconcile-reason").value.trim(), risk = $("#reconcile-risk").value.trim(); if (!reason || !risk) { $("#reconcile-error").textContent = "Describe the evidence and remaining risk before applying it."; return; }
  pendingReconciliation = { workId: reviewIntent.workId, body: { request_id: crypto.randomUUID(), expected_revision: reviewIntent.revision, attempt_id: receipt.attempt_id, receipt_digest: receipt.receipt_digest, reason, residual_risk: risk } };
  save("barry-work-reconciliation", pendingReconciliation); paintPending(); void sendReconciliation();
});
$("#retry-reconcile").addEventListener("click", () => void sendReconciliation());
$("#check-reconcile").addEventListener("click", async () => {
  if (!pendingReconciliation || sendingReconciliation) return; const intent = structuredClone(pendingReconciliation);
  try {
    const evidence = await api(`/api/v2/work/${encodeURIComponent(intent.workId)}/reconciliation`);
    if (pendingReconciliation?.body.request_id !== intent.body.request_id) return;
    const recorded = evidence.audit.find(entry => entry.request_id === intent.body.request_id && entry.acknowledgement.receipt_digest === intent.body.receipt_digest);
    if (recorded) { clearReconciliation(); notice("Recovery decision confirmed in the recorded audit."); await refresh(true); }
    else notice("This decision is not recorded yet. Retry the same request, or review current evidence before making a new decision.");
  } catch (error) { notice(error.message); }
});
$("#review-reconcile").addEventListener("click", async () => {
  if (!pendingReconciliation || sendingReconciliation) return; const intent = structuredClone(pendingReconciliation), id = intent.workId;
  try {
    const evidence = await api(`/api/v2/work/${encodeURIComponent(id)}/reconciliation`);
    if (pendingReconciliation?.body.request_id !== intent.body.request_id) return;
    const recorded = evidence.audit.some(entry => entry.request_id === intent.body.request_id && entry.acknowledgement.receipt_digest === intent.body.receipt_digest);
    if (!recorded && !intent.refused) { notice("This decision is still unconfirmed. Retry the same decision before replacing its request."); return; }
    const work = await api(`/api/v2/work/${encodeURIComponent(id)}`);
    if (pendingReconciliation?.body.request_id !== intent.body.request_id) return;
    clearReconciliation(); if (route().id !== id) { location.hash = `work/${encodeURIComponent(id)}`; notice("Review this task’s recovery evidence before making another decision."); } else await openReview(work);
  }
  catch (error) { notice(error.message); }
});

async function sendStop() {
  if (!pendingStop) return; $("#submit-stop").disabled = true;
  try {
    await api(`/api/v2/work/${encodeURIComponent(pendingStop.workId)}/stop`, pendingStop.body);
    pendingStop = null; save("barry-work-stop", null); $("#stop-dialog").close(); notice(""); await refresh(true);
  } catch (error) {
    $("#stop-error").textContent = error.message;
    const classified = classifyStopFailure(error, Boolean(pendingStop?.uncertain));
    notice(error.message);
    if (classified.outcome === "refused") {
      pendingStop = null; save("barry-work-stop", null);
      if ($("#stop-dialog").open) $("#stop-dialog").close();
      await refresh(true);
    } else {
      pendingStop = { ...pendingStop, uncertain: true };
      save("barry-work-stop", pendingStop);
    }
  } finally { $("#submit-stop").disabled = false; paintPending(); }
}

$("#stop-form").addEventListener("submit", event => {
  event.preventDefault(); if (!stopIntent || pendingStop) return;
  const reason = $("#stop-reason")?.value?.trim();
  pendingStop = { workId: stopIntent.workId, body: { request_id: crypto.randomUUID(), expected_revision: stopIntent.revision, ...(reason ? { reason } : {}) } };
  save("barry-work-stop", pendingStop); paintPending(); void sendStop();
});
for (const element of document.querySelectorAll("[data-close]")) element.addEventListener("click", () => element.closest("dialog").close());
$("#check-submission").addEventListener("click", () => void checkSubmission());
$("#retry-submission").addEventListener("click", () => { if (pending) void submit(pending); });
$("#check-stop").addEventListener("click", () => void sendStop());
$("#inspect-stop-status")?.addEventListener("click", async () => {
  if (!pendingStop) return;
  const targetId = pendingStop.workId;
  try {
    const work = await api(`/api/v2/work/${encodeURIComponent(targetId)}`);
    if (work.facts?.stop_requested || ["stopping", "cancelled", "completed", "failed"].includes(work.state)) {
      pendingStop = null; save("barry-work-stop", null); paintPending();
      if ($("#stop-dialog").open) $("#stop-dialog").close();
      notice(work.facts?.stop_requested || work.state === "cancelled" ? "Stop request was already recorded on this task." : `Task is already ${labels[work.state] ?? work.state}.`);
      await refresh(true);
    } else {
      notice("Stop has not been recorded yet. Use Check stop request to resend the same stop request.");
    }
  } catch (error) { notice(error.message); }
});
$("#lookup-form").addEventListener("submit", event => { event.preventDefault(); void lookup($("#lookup-key").value).catch(error => notice(error.message)); });
$(".skip").addEventListener("click", event => { event.preventDefault(); $("#work-content").focus(); });
$("#work-refresh").addEventListener("click", () => { state.pages = 0; void refresh(true); });
$("#work-more").addEventListener("click", async () => {
  const selected = route(); if (!state.cursor || !selected.view) return;
  const hash = location.hash, generation = state.generation; state.loadingMore = true; $("#work-more").disabled = true;
  try {
    const value = await api(`/api/v2/work?${listQueryForView(selected.view, state.cursor)}`);
    if (location.hash !== hash || state.generation !== generation) return;
    const known = new Set(state.items.map(work => work.work_id));
    state.items.push(...value.items.filter(work => !known.has(work.work_id)));
    state.cursor = value.next_cursor; state.pages++; renderList(selected.view, value.total);
  } catch (error) { notice(error.message); }
  finally { state.loadingMore = false; $("#work-more").disabled = false; }
});
window.addEventListener("hashchange", () => { reviewGeneration++; reviewIntent = null; if ($("#reconcile-dialog").open) $("#reconcile-dialog").close(); if ($("#stop-dialog").open) $("#stop-dialog").close(); stopIntent = null; state.pages = 0; void refresh(true); });
paintPending(); void refresh(true); setInterval(() => { if (!document.hidden) void refresh(); }, 2000);

