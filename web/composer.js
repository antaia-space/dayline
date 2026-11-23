import { addDays, duration, formatDay, instantTime, zonedDay } from "./ui.js";

const byId = (id) => document.getElementById(id);
const key = "dayline.taskDraft";
const clients = { local:"the local agent", codex:"Codex", gemini:"Google Gemini", claude:"Claude Code" };

function stored(area) {
  try { return window[area].getItem(key); } catch { return null; }
}
function write(area,value) {
  try {
    if (value === null) window[area].removeItem(key);
    else window[area].setItem(key,value);
  } catch { /* The form still works if browser storage is unavailable. */ }
}
function restoreDraft() {
  try {
    const draft = JSON.parse(stored("sessionStorage") ?? stored("localStorage"));
    if (typeof draft?.text !== "string" || !draft.text.trim() || draft.text.length > 1000 ||
      !/^[a-f0-9]{32}$/.test(draft.id) || (draft.day !== null &&
      !(/^\d{4}-\d{2}-\d{2}$/.test(draft.day) && Number.isFinite(Date.parse(draft.day + "T12:00Z"))))) return null;
    return draft;
  } catch { return null; }
}

export function createComposer({api,refresh,context,showLocation,openTask}) {
  const form = byId("quick-add"), input = byId("quick-text"), picker = byId("quick-day");
  let draft = restoreDraft();
  let selected = draft?.day || null;
  let implicit = Boolean(selected && draft?.implicit);
  let sending = false, lastContext = "", choicesKey = "", follow = "", resultId = null;
  let recoveryTimer;
  input.value = draft?.text || "";

  function storeDraft(next) {
    const previous = draft ? JSON.stringify(draft) : null;
    draft = next;
    const value = next ? JSON.stringify(next) : "";
    write("sessionStorage",value);
    if (next) write("localStorage",value);
    else if (stored("localStorage") === previous) write("localStorage",null);
  }
  function capture() {
    if (!input.value.trim()) { if (draft) storeDraft(null); return; }
    if (draft?.text === input.value && draft.day === selected && Boolean(draft.implicit) === implicit) return;
    storeDraft({id:crypto.randomUUID().replaceAll("-",""),text:input.value,day:selected,implicit,sent:false});
  }
  function feedback(message,task) {
    byId("entry-feedback").hidden = !message;
    const status = byId("entry-status");
    if (status.textContent !== message) status.textContent = message;
    const action = byId("view-added");
    action.hidden = !task;
    if (task) action.setAttribute("aria-label","View task — " + task.text);
  }
  function error(message = "") {
    byId("quick-error").textContent = message;
    byId("quick-error").hidden = !message;
  }
  function controls() {
    form.setAttribute("aria-busy",String(sending));
    input.readOnly = sending;
    picker.disabled = sending;
    byId("add-button").disabled = sending || !context().state;
    byId("add-label").textContent = sending ? "Estimating…" : draft?.sent ? "Retry add" : "Add task";
    for (const item of document.querySelectorAll('#agenda-add,[data-action="add-day"]')) item.disabled = sending;
  }
  function scope({view,selectedDay,monday,compact}) { return [view,selectedDay,monday,compact].join("|"); }
  function dayOptions(ctx) {
    const contextKey = scope(ctx);
    const viewed = ctx.view === "day" || ctx.compact ? ctx.selectedDay : null;
    if (contextKey !== lastContext) {
      if (!draft && !sending) { selected = viewed; implicit = Boolean(viewed); }
      lastContext = contextKey;
    }
    const preferred = implicit ? selected : viewed;
    const signature = [ctx.monday,selected,preferred].join("|");
    if (signature !== choicesKey) {
      choicesKey = signature;
      const days = Array.from({length:7},(_,n) => addDays(ctx.monday,n));
      if (selected && !days.includes(selected)) days.push(selected);
      const name = day => formatDay(day,{weekday:"short",month:"short",day:"numeric"});
      const preferredOption = preferred ? [new Option("Prefer " + name(preferred),"view:" + preferred)] : [];
      picker.replaceChildren(new Option("Auto-schedule",""),...preferredOption,...days.map(day =>
        new Option("On " + name(day),day)));
    }
    picker.value = implicit && selected ? "view:" + selected : selected || "";
    picker.title = implicit ? "Use this day unless your task names a date." : "Choose a date, or let Dayline find the next opening.";
    input.placeholder = selected ? "What needs doing that day?" : ctx.compact ? "e.g. Review deck, 45m" : "Add a task, e.g. review the deck for 45 minutes tomorrow";
  }
  function accepted(task) {
    resultId = task.id;
    storeDraft(null);
    input.value = "";
    lastContext = "";
    error();
  }
  function update() {
    const ctx = context();
    if (!ctx.state || !ctx.monday) return;
    const agent = ctx.state.selectedAgent;
    const link = byId("entry-agent");
    link.hidden = !agent;
    if (agent) {
      const name = agent.provider === "local" ? "Local on this Mac" : clients[agent.provider] || agent.provider;
      link.textContent = ["Task agent",name,agent.model].filter(Boolean).join(" · ");
      link.title = "Change task agent" + (agent.effort ? " · " + agent.effort + " reasoning effort" : "");
    }
    if (!sending && draft?.sent) {
      const saved = ctx.state.tasks.find(task => task.id === draft.id);
      if (saved) accepted(saved);
    }
    dayOptions(ctx);
    controls();
    if (sending) return;
    const task = resultId && ctx.state.tasks.find(item => item.id === resultId);
    if (!task) {
      const recent = draft?.sent && Date.now() - Number(draft.sentAt) < 115000;
      feedback(recent ? "Checking for your submitted task. Your draft is saved." : draft?.sent ? "Your draft is saved. Retry add to finish the same request." : "");
      if (recent && !recoveryTimer && !document.hidden) recoveryTimer = window.setTimeout(() => {
        recoveryTimer = null;
        if (draft?.sent && !sending) void refresh(true);
      },2000);
      return;
    }
    const checking = !task.start && !task.pendingEstimate && task.syncStatus === "pending" && ctx.state.connection.connected;
    if (task.pendingEstimate) feedback("Saved in Unscheduled. Awaiting an estimate from your task agent.",task);
    else if (task.start) {
      const zone = ctx.state.settings.timeZone;
      const day = formatDay(zonedDay(task.start,zone),{weekday:"short",month:"short",day:"numeric"});
      const when = task.allDay ? day + " · All day" : day + " at " + instantTime(task.start,zone) + " · " + duration(task.minutes);
      feedback("Scheduled " + when + ".",task);
    } else if (checking) feedback("Saved. Checking calendar availability…",task);
    else feedback("Saved in Unscheduled." + (task.issue ? " " + task.issue : ""),task);
    if (follow && !checking) {
      const canFollow = follow === scope(ctx) && !document.querySelector("dialog[open]") && !input.value;
      follow = "";
      if (canFollow) queueMicrotask(() => { if (resultId === task.id) showLocation(task); });
    }
  }
  function choose(day,focus = true,fromView = false) {
    if (sending) return;
    selected = day || null;
    implicit = Boolean(selected && fromView);
    capture();
    if (context().state) dayOptions(context());
    controls();
    if (focus) input.focus();
  }
  input.addEventListener("input",() => {
    if (sending) return;
    capture();
    resultId = null; follow = "";
    error(); feedback(""); controls();
  });
  picker.addEventListener("change",() => {
    const fromView = picker.value.startsWith("view:");
    choose(fromView ? picker.value.slice(5) : picker.value,false,fromView);
  });
  byId("view-added").addEventListener("click",() => {
    const task = context().state?.tasks.find(item => item.id === resultId);
    if (task) { showLocation(task); openTask(task); }
  });
  form.addEventListener("submit",async (event) => {
    event.preventDefault();
    const ctx = context();
    if (sending || !ctx.state || !input.value.trim()) return;
    capture();
    const request = {requestId:draft.id,text:draft.text.trim()};
    if (selected) request[implicit ? "viewDay" : "day"] = selected;
    storeDraft({...draft,sent:true,sentAt:Date.now()});
    sending = true;
    follow = scope(ctx); resultId = null;
    error(); controls();
    const agent = ctx.state.selectedAgent || {};
    const name = clients[agent.provider] || "your task agent";
    feedback("Estimating with " + name + (agent.model ? " (" + agent.model + ")" : "") + "…");
    let problem = "";
    try { await api("/api/tasks","POST",request); }
    catch (cause) { problem = cause.message; }
    sending = false;
    await refresh(true);
    update();
    if (draft?.id === request.requestId && problem) error(problem);
  });
  controls();
  return {update,choose};
}
