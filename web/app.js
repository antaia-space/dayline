import {
  addDays, button, dayIndex, displayTime, element, formatDay,
  hhmmMinutes, icon, instantTime, isoWeek, navigationLabel, startOfWeek, weekdayNames, weekLabel, workdaysLabel, zonedDay
} from "./ui.js";
import { fittedDuration, releasedCompletionDay, renderAgenda, renderBacklog, renderKey, renderWeek } from "./views.js";
import { createAgentSettings, estimateSource } from "./agent.js";
import { createComposer } from "./composer.js";
import { createDurationControls } from "./duration.js";
import { createTaskOrder } from "./task-order.js";
import { createMovePicker, nextMoveCheck } from "./task-moves.js";
import { createSubtaskControls, overrunNote, restoreSubtaskCaret, subtaskCaret } from "./subtasks.js";
import { createMeetingDetails, createMeetingFeed } from "./meetings.js";
import { createCalendarUpdates } from "./calendar-updates.js";
import { localRead,localWrite } from "./outbox.js";

const byId = (id) => document.getElementById(id);
const pref = {
  get(key) { try { return localStorage.getItem("dayline." + key); } catch { return null; } },
  set(key,value) { try { localStorage.setItem("dayline." + key,String(value)); } catch { /* Session preferences remain available. */ } }
};
const route = /^\/action\/([a-z0-9-]+)\/?$/i.exec(location.pathname);
let routeOpened = false;
let state;
let selectedDay;
let monday;
let today;
let lastToday;
let view = pref.get("view") === "day" ? "day" : "week";
let weekends;
let syncRefreshTimer;
let moveEndTimer;
const compact = matchMedia("(max-width: 720px)");
let editingTask = null;
const retryingEstimates = new Set();
let settingTab = "work";
let settingsSignature = "";
let calendarModeDraft = null;
let savingCalendarMode = false;
let lastRequest = 0;
let calendarGeneration = 0;
let displayedGeneration = 0;
let stateRead = null;
let calendarPaint = null;
let lastPaint = "";
let lastConnection = "";
let noticeTimer;
let actionDone;
let loadingPairing = false;

const composer = createComposer({
  api, refresh, openTask: openEditor, showLocation: showTaskLocation,
  context:() => ({state,view,monday,selectedDay,compact:compact.matches})
});
const durationControls = createDurationControls({api,refresh,getState:() => state,notify:toast});
const taskOrder = createTaskOrder({root:byId("planner"),api,refresh,getState:() => state,notify:toast,repaint:render});
const subtaskControls = createSubtaskControls({api,refresh,getState:() => state,repaint:render,editor:byId("editor-checklist")});
const movePicker = createMovePicker({api,refresh,getState:() => state,notify:toast,focusMarker:slotId => {
  if (!slotId || document.querySelector("dialog[open]")) return;
  const marker = [...byId("planner").querySelectorAll("[data-moved-slot]")].find(node => node.dataset.movedSlot === slotId && node.getClientRects().length);
  marker?.focus({preventScroll:true});
}});
const meetings = createMeetingFeed({read:(url,signal) => api(url,"GET",undefined,signal),
  changed:() => {
    if (calendarPaint?.request === lastRequest && calendarPaint.generation === calendarGeneration) calendarPaint.changed = true;
    else render();
  },live:() => calendarUpdates.connected});
const calendarUpdates = createCalendarUpdates({
  open:typeof EventSource === "function" ? () => new EventSource("/api/updates") : null,
  visible:() => !document.hidden,canCheck:() => Boolean(state?.connection.connected),
  check:() => api("/api/calendar/check","POST",{},AbortSignal.timeout(6000)),
  invalidate:() => { calendarGeneration++; stateRead?.abort(); meetings.invalidate(); },refresh:() => refresh()
});
const meetingDetails = createMeetingDetails({root:byId("planner"),zone:() => state.settings.timeZone,
  authorized:() => Boolean(state?.connection.connected && state.connection.accounts?.some(account => account.meetingDetails)),
  find:id => meetings.current.events.find(event => event.id === id)});

for (const holder of document.querySelectorAll("[data-icon]")) holder.append(icon(holder.dataset.icon));
for (const [index,name] of weekdayNames.entries()) {
  const label = element("label");
  const input = element("input");
  input.type = "checkbox";
  input.value = String(index+1);
  input.setAttribute("aria-label",name);
  label.append(input,element("span","",name.slice(0,3)));
  byId("work-days").append(label);
}
const zoneList = new Set(["UTC",Intl.DateTimeFormat().resolvedOptions().timeZone,...(Intl.supportedValuesOf?.("timeZone") || [])]);
for (const name of zoneList) byId("time-zones").append(new Option(name,name));
byId("quick-text").setAttribute("aria-keyshortcuts","/");
byId("backlog-toggle").setAttribute("aria-expanded",String(pref.get("tray") !== "false"));
byId("backlog-content").hidden = pref.get("tray") === "false";

function errorAt(id,message = "") {
  const target = byId(id);
  target.textContent = message;
  target.hidden = !message;
}

function toast(message) {
  window.clearTimeout(noticeTimer);
  byId("notification").textContent = message;
  byId("notification").hidden = false;
  noticeTimer = window.setTimeout(() => { byId("notification").hidden = true; }, 4200);
}

const calendarMode = () => state?.settings.calendarMode === "sync" ? "sync" : "availability";
function refreshLabel(inProgress) {
  if (calendarMode() === "availability") return inProgress ? "Checking availability…" : "Refresh availability";
  return inProgress ? "Syncing…" : "Sync now";
}

async function api(path, method = "GET", body, cancellation) {
  if (loadingPairing) throw new Error("Reconnect this browser to Dayline on this Mac.");
  let response;
  try {
    const timeout = AbortSignal.timeout(115000);
    const signal = cancellation ? (AbortSignal.any ? AbortSignal.any([cancellation,timeout]) : cancellation) : timeout;
    response = await fetch(path,{
      method, credentials:"same-origin", cache:"no-store",
      ...(body !== undefined ? {headers:{"Content-Type":"application/json"},body:JSON.stringify(body)} : {}),
      signal
    });
  } catch (error) {
    if (cancellation?.aborted) throw error;
    if (error.name === "TimeoutError") throw new Error("Dayline took too long to respond. Refresh before trying again.");
    throw new Error("The local planner is unavailable. Open Dayline on this Mac, then try again.");
  }
  if (response.status === 401) {
    let recentlyTried = false;
    try {
      recentlyTried = Date.now() - Number(sessionStorage.getItem("dayline.pairingReload")) < 30000;
      sessionStorage.setItem("dayline.pairingReload",String(Date.now()));
    } catch {}
    if (!loadingPairing && !recentlyTried) { loadingPairing = true; location.reload(); }
    throw new Error("Reconnect this browser to Dayline on this Mac.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof data.error === "string" ? data.error : "Dayline could not finish this action.");
    error.status = response.status;
    throw error;
  }
  if (path === "/api/state") {
    try { sessionStorage.removeItem("dayline.pairingReload"); } catch {}
  }
  return data;
}

async function refresh(force = false, forceMeetings = false) {
  const request = ++lastRequest;
  if (forceMeetings) { calendarGeneration++; meetings.invalidate(); }
  const generation = calendarGeneration;
  const controller = new AbortController();
  stateRead?.abort(); stateRead = controller;
  try {
    const next = await api("/api/state","GET",undefined,controller.signal);
    if (request !== lastRequest || generation !== calendarGeneration) return;
    const zone = next.settings.timeZone;
    const day = zonedDay(next.now || Date.now(),zone);
    state = next;
    state.busy ||= [];
    state.calendars ||= [];
    state.categories ||= [];
    today = day;
    window.clearTimeout(moveEndTimer);
    const nextEnd = nextMoveCheck(next);
    if (nextEnd !== null) moveEndTimer = window.setTimeout(() => { if (!document.hidden) refresh(); },nextEnd);
    window.clearTimeout(syncRefreshTimer);
    if ((!calendarUpdates.connected && next.connection.syncing) || next.tasks.some(task => task.estimateState === "queued" || task.estimateState === "estimating")) {
      syncRefreshTimer = window.setTimeout(() => refresh(),1100);
    }
    if (!selectedDay || (lastToday && day !== lastToday && selectedDay === lastToday)) {
      selectedDay = day;
      monday = startOfWeek(day);
    }
    lastToday = day;
    if (weekends === undefined) {
      const saved = pref.get("weekends");
      weekends = saved === "true" || (saved === null && (dayIndex(day) > 5 || next.settings.workDays.some((d) => d > 5)));
    }
    if (!weekends && view === "week" && dayIndex(selectedDay) > 5) selectedDay = addDays(monday,4);
    meetings.update(state,monday);
    // Keep a visible week's old rows together until the refreshed meetings
    // and replanned reservations are both ready. Initial and newly authorized
    // views can display local tasks immediately.
    if (generation !== displayedGeneration && meetings.replacing && (!force || forceMeetings)) {
      const staged = {request,generation,changed:false};
      calendarPaint = staged;
      try { await meetings.replacing; }
      finally { if (calendarPaint === staged) calendarPaint = null; }
      if (request !== lastRequest || generation !== calendarGeneration) return;
      force ||= staged.changed;
    }
    displayedGeneration = generation;
    const currentMinute = view === "day" && selectedDay === day ? Math.ceil(new Date(state.now || Date.now()).getTime()/60000) : null;
    const connection = {...state.connection,lastSync:undefined};
    const paint = JSON.stringify([state.tasks,state.categories,state.settings,state.selectedAgent,state.busy,state.busyStart,state.busyEnd,connection,day,selectedDay,currentMinute]);
    if (force || lastPaint !== paint) {
      render();
      lastPaint = paint;
    }
    byId("planner").setAttribute("aria-busy","false");
    byId("service-error").hidden = true;
    byId("sync-now").title = state.connection.lastSync ? (calendarMode() === "availability" ? "Last checked " : "Last synced ") +
      new Date(state.connection.lastSync).toLocaleString() : refreshLabel(false);
    if (byId("settings").open && settingTab === "calendars") fillCalendarSettings();
    if (byId("settings").open && settingTab === "agent") agentSettings.update(next);
    if (byId("action-dialog").open) renderCalendarAction();
    if (byId("task-dialog").open && editingTask && !retryingEstimates.has(editingTask.id)) {
      const latest = state.tasks.find(task => task.id === editingTask.id);
      const changed = latest && (latest.title !== editingTask.title || latest.text !== editingTask.text || latest.category !== editingTask.category ||
        latest.earliestDay !== editingTask.earliestDay || latest.latestDay !== editingTask.latestDay ||
        latest.estimateState !== editingTask.estimateState || latest.minutes !== editingTask.minutes ||
        latest.done !== editingTask.done || latest.start !== editingTask.start || latest.end !== editingTask.end || latest.completedDay !== editingTask.completedDay ||
        latest.calendarProgressMinutes !== editingTask.calendarProgressMinutes || latest.overrunMinutes !== editingTask.overrunMinutes ||
        latest.calendarFit?.originalMinutes !== editingTask.calendarFit?.originalMinutes);
      if (changed && !Object.keys(taskChanges()).length) openEditor(latest);
      else if (latest) subtaskControls.showEditor(latest);
    }
    if (route && !routeOpened) {
      routeOpened = true;
      openCalendarAction();
    }
  } catch (error) {
    if (request !== lastRequest || generation !== calendarGeneration || controller.signal.aborted) return;
    byId("service-error-text").textContent = error.message;
    byId("service-error").hidden = false;
    byId("planner").setAttribute("aria-busy","false");
  } finally { if (stateRead === controller) stateRead = null; }
}

function render() {
  if (!state || taskOrder.deferRender() || subtaskControls.deferRender()) return;
  const active = document.activeElement;
  const bookmark = active?.dataset.focus;
  const caret = subtaskCaret(active);
  const weekView = view === "week";
  const context = {monday,selected:selectedDay,today,weekends,events:meetings.update(state,monday).events};
  byId("view-week").setAttribute("aria-pressed",String(weekView));
  byId("view-day").setAttribute("aria-pressed",String(!weekView));
  byId("week-section").hidden = !weekView;
  byId("day-section").hidden = weekView;
  byId("show-weekends").checked = weekends;
  byId("period-context").textContent = weekView
    ? "Week " + String(isoWeek(monday)).padStart(2,"0") + " · " + formatDay(addDays(monday,3),{year:"numeric"})
    : formatDay(selectedDay,{weekday:"long"}) + " · " + formatDay(selectedDay,{year:"numeric"});
  byId("period-title").textContent = weekView ? weekLabel(monday) : formatDay(selectedDay,{month:"long",day:"numeric"});
  const current = byId("today");
  const label = navigationLabel(selectedDay, today, view);
  current.textContent = label;
  current.title = weekView ? "Go to this week" : "Go to today";
  current.setAttribute("aria-label", label + ". " + current.title);
  const unit = weekView ? "week" : "day";
  for (const [id,prefix] of [["previous","Previous"],["next","Next"]]) {
    byId(id).setAttribute("aria-label",prefix + " " + unit);
    byId(id).title = prefix + " " + unit;
  }
  if (weekView) {
    byId("agenda").replaceChildren();
    renderWeek(state,context);
  } else {
    byId("week-board").replaceChildren();
    renderAgenda(state,context);
  }
  renderBacklog(state);
  taskOrder.paint();
  durationControls.paint();
  composer.update();
  renderKey(state.categories);
  const account = state.connection;
  const readOnly = calendarMode() === "availability";
  const status = !account.connected ? "Local planner" : account.error ? "Calendar needs attention" : account.syncing ? (readOnly ? "Checking availability" : "Syncing calendars") : (readOnly ? (account.accounts?.some(a => a.meetingDetails) ? "Read-only calendars" : "Availability only") : "Calendar sync on");
  byId("connection-text").textContent = status;
  byId("connection-status").setAttribute("aria-label",status + ". Open calendar settings");
  byId("connection-status").title = status + (account.connected && account.email ? " · " + account.email : "");
  byId("connection-status").dataset.alert = String(Boolean(account.error));
  const accountIcon = account.connected ? "cloud" : "device";
  if (lastConnection !== accountIcon) {
    byId("connection-status").firstElementChild.replaceChildren(icon(accountIcon));
    lastConnection = accountIcon;
  }
  byId("sync-now").hidden = !account.connected;
  byId("sync-now").disabled = Boolean(account.syncing);
  byId("sync-label").textContent = refreshLabel(account.syncing);
  const hours = state.settings;
  byId("hours-summary").textContent = workdaysLabel(hours.workDays) + " · " + displayTime(hhmmMinutes(hours.startTime)) + "–" + displayTime(hhmmMinutes(hours.endTime)) + " · " + hours.timeZone.replaceAll("_"," ");
  byId("hours-open").title = "Edit working hours and time zone";
  renderPlanningNote();
  meetingDetails.sync();
  if (bookmark && !active.isConnected) {
    const matches = document.querySelectorAll('[data-focus="' + CSS.escape(bookmark) + '"]');
    let visible = [...matches].find(node => !node.disabled && node.getClientRects().length);
    const parentId = active.closest("details[data-checklist]")?.dataset.checklist;
    if (!visible && parentId) {
      const editors = document.querySelectorAll('[data-action="edit-task"][data-id="' + CSS.escape(parentId) + '"]');
      visible = [...editors].find(node => node.getClientRects().length);
    }
    visible?.focus({preventScroll:true});
    restoreSubtaskCaret(visible,caret);
  }
}

function renderPlanningNote() {
  const note = byId("planning-note");
  const lines = [];
  const add = (...pieces) => {
    const line = element("span");
    line.append(...pieces);
    lines.push(line);
  };
  const settingsLink = label => button("","calendar-settings",label,label);
  if (state.connection.error) {
    add(state.connection.error," ",settingsLink("Calendar settings"));
  } else if (!state.connection.connected) {
    add(settingsLink("Connect Google Calendar"),calendarMode() === "availability" ? " to see meetings and plan around busy times." : " to place scheduled tasks on your calendar.");
  } else if (view === "day" && state.busyStart && state.busyEnd && (selectedDay < zonedDay(state.busyStart,state.settings.timeZone) || selectedDay >= zonedDay(state.busyEnd,state.settings.timeZone))) {
    add("Calendar availability has not been checked for this date.");
  }
  for (const warning of meetings.current.warnings) add(warning);
  if (state.connection.accounts?.some(account => !account.meetingDetails)) {
    add(settingsLink("Show meeting details")," to see titles, guests and join links for accounts sharing only busy times.");
  }
  note.hidden = !lines.length;
  if (lines.length) {
    const text = element("div","planning-lines");
    text.append(...lines); note.replaceChildren(icon("info"),text);
  }
}

function switchView(next) {
  if (!state) return;
  const changed = view !== next;
  view = next;
  pref.set("view",view);
  if (view === "week" && dayIndex(selectedDay) > 5 && !weekends) {
    weekends = true;
    pref.set("weekends",true);
  }
  render();
  if (changed) calendarUpdates.wake();
}

function navigateTo(day) {
  if (!state) return;
  const previousWeek = monday;
  if (day !== selectedDay) meetingDetails.close();
  selectedDay = day;
  monday = startOfWeek(day);
  if (view === "week" && dayIndex(day) > 5 && !weekends) {
    weekends = true;
    pref.set("weekends",true);
  }
  render();
  if (monday !== previousWeek) calendarUpdates.wake({reloadMeetings:false});
}

function showTaskLocation(task) {
  const zone = state.settings.timeZone;
  const day = releasedCompletionDay(task,zone) || (task.start && !task.pendingEstimate && zonedDay(task.start,zone));
  if (day) {
    navigateTo(day);
  } else {
    byId("backlog-content").hidden = false;
    byId("backlog-toggle").setAttribute("aria-expanded","true");
  }
}
compact.addEventListener("change",() => composer.update());

byId("view-week").addEventListener("click",() => switchView("week"));
byId("view-day").addEventListener("click",() => switchView("day"));
byId("entry-agent").addEventListener("click",() => openSettings("agent"));
byId("agenda-add").addEventListener("click",() => composer.choose(selectedDay));
byId("previous").addEventListener("click",() => { if (state) navigateTo(addDays(selectedDay,view === "week" ? -7 : -1)); });
byId("next").addEventListener("click",() => { if (state) navigateTo(addDays(selectedDay,view === "week" ? 7 : 1)); });
byId("today").addEventListener("click",() => { if (state) navigateTo(today); });
byId("retry-load").addEventListener("click",() => refresh(true));
byId("show-weekends").addEventListener("change",() => {
  if (!state) return;
  weekends = byId("show-weekends").checked;
  pref.set("weekends",weekends);
  if (!weekends && dayIndex(selectedDay) > 5) selectedDay = addDays(monday,4);
  render();
});
byId("backlog-toggle").addEventListener("click",() => {
  const open = byId("backlog-content").hidden;
  byId("backlog-content").hidden = !open;
  byId("backlog-toggle").setAttribute("aria-expanded",String(open));
  pref.set("tray",open);
});


byId("planner").addEventListener("click",async (event) => {
  const target = event.target.closest("button[data-action]");
  if (!target || !state) return;
  const action = target.dataset.action;
  if (action === "add-day") return composer.choose(target.dataset.day);
  if (action === "open-day") {
    switchView("day");
    return navigateTo(target.dataset.day);
  }
  if (action === "pick-day") return navigateTo(target.dataset.day);
  if (action === "show-weekends") {
    weekends = true;
    pref.set("weekends",true);
    return render();
  }
  if (action === "calendar-settings") return openSettings("calendars");
  const task = state.tasks.find(({id}) => id === target.dataset.id);
  if (!task) return;
  if (action === "move-later") return movePicker.open(task);
  if (action === "move-destination") {
    switchView("day");
    navigateTo(target.dataset.day);
    const controls = [...byId("agenda").querySelectorAll("button[data-id]")].filter(node => node.dataset.id === task.id);
    let next = controls.find(node => node.dataset.action === "edit-task") || controls.find(node => node.dataset.action === "move-destination");
    if (!next && !task.start && !task.done) {
      byId("backlog-content").hidden = false;
      byId("backlog-toggle").setAttribute("aria-expanded","true");
      next = [...byId("backlog-content").querySelectorAll("[data-action='edit-task']")].find(node => node.dataset.id === task.id);
    }
    if (!next) { next = byId("period-title"); next.tabIndex = -1; }
    next.focus();
    return;
  }
  if (action === "adjust-duration") return durationControls.adjust(task,Number(target.dataset.delta));
  if (action === "edit-task") return openEditor(task);
  if (action === "toggle-task") {
    target.disabled = true;
    try {
      await api("/api/tasks/" + encodeURIComponent(task.id),"PATCH",{done:!task.done});
      await refresh(true);
      toast(task.done ? "Task reopened." : "Task completed.");
    } catch (error) { toast(error.message); }
    finally { target.disabled = false; }
  }
});

document.addEventListener("keydown",(event) => {
  if (event.key === "/" && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && !document.querySelector("dialog[open]") && !event.target.closest("input,textarea,select,[contenteditable='true']")) {
    event.preventDefault();
    byId("quick-text").focus();
  }
  if (event.key === "Escape" && event.target === byId("quick-text")) composer.choose(null);
});

for (const closer of document.querySelectorAll(".close-dialog")) closer.addEventListener("click",() => closer.closest("dialog").close());
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click",(event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}

function openSettings(tab) {
  if (!state) return;
  errorAt("settings-error");
  const cfg = state.settings;
  byId("work-start").value = cfg.startTime;
  byId("work-end").value = cfg.endTime;
  byId("work-zone").value = cfg.timeZone;
  for (const input of byId("work-days").querySelectorAll("input")) input.checked = cfg.workDays.includes(Number(input.value));
  settingsSignature = "";
  calendarModeDraft = null;
  settingsTab(tab);
  if (!byId("settings").open) byId("settings").showModal();
}

function settingsTab(tab) {
  settingTab = tab;
  byId("tab-work").setAttribute("aria-pressed",String(tab === "work"));
  byId("tab-calendars").setAttribute("aria-pressed",String(tab === "calendars"));
  byId("tab-agent").setAttribute("aria-pressed",String(tab === "agent"));
  byId("work-form").hidden = tab !== "work";
  byId("calendar-settings").hidden = tab !== "calendars";
  byId("agent-settings").hidden = tab !== "agent";
  errorAt("settings-error");
  if (tab === "calendars") fillCalendarSettings();
  if (tab === "agent") agentSettings.open(state);
}

const agentSettings = createAgentSettings({api,toast,errorAt,onSaved:selected => {
  if (state) state.selectedAgent = selected;
  composer.update();
  void refresh(true);
}});
byId("settings-open").addEventListener("click",() => openSettings("work"));
byId("hours-open").addEventListener("click",() => openSettings("work"));
byId("connection-status").addEventListener("click",() => openSettings("calendars"));
byId("tab-work").addEventListener("click",() => settingsTab("work"));
byId("tab-calendars").addEventListener("click",() => settingsTab("calendars"));
byId("tab-agent").addEventListener("click",() => settingsTab("agent"));

async function saveSettings(changes,form) {
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  errorAt("settings-error");
  try {
    await api("/api/settings","PATCH",changes);
    await refresh(true);
    byId("settings").close();
    toast("Settings saved.");
  } catch (error) { errorAt("settings-error",error.message); }
  finally { submit.disabled = false; }
}

byId("work-form").addEventListener("submit",async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const workDays = [...byId("work-days").querySelectorAll("input:checked")].map((i) => Number(i.value));
  if (!workDays.length) return errorAt("settings-error","Choose at least one working day.");
  const startTime = byId("work-start").value;
  const endTime = byId("work-end").value;
  if (startTime >= endTime) return errorAt("settings-error","End time must come after start time.");
  const timeZone = byId("work-zone").value.trim();
  try { new Intl.DateTimeFormat(undefined,{timeZone}); }
  catch { return errorAt("settings-error","Choose a valid IANA time zone, such as Europe/Zurich."); }
  await saveSettings({workDays,startTime,endTime,timeZone},form);
});

function updateModeControls() {
  const saved = calendarMode();
  const selected = calendarModeDraft || saved;
  const dirty = selected !== saved;
  const chooser = byId("calendar-mode");
  chooser.value = selected;
  chooser.disabled = savingCalendarMode;
  byId("mode-description").textContent = selected === "availability"
    ? "Dayline can show meetings and plan around busy times on your selected calendars. Task blocks and completion stay on this Mac."
    : "Dayline can write upcoming, unfinished tasks to Google Calendar as colored events and sync completion in both directions.";
  byId("mode-actions").hidden = !dirty;
  byId("apply-mode").textContent = selected === "sync" ? "Enable event syncing" : "Use availability only";
  byId("apply-mode").disabled = savingCalendarMode;
  byId("cancel-mode").disabled = savingCalendarMode;
  byId("google-login").hidden = !state.connection.configured || dirty || savingCalendarMode;
  byId("calendar-form").hidden = !state.connection.connected || dirty || savingCalendarMode;
  for (const control of byId("calendar-accounts").querySelectorAll('[data-action="meeting-access"]')) control.disabled = dirty || savingCalendarMode;
}

byId("calendar-mode").addEventListener("change",() => {
  calendarModeDraft = byId("calendar-mode").value;
  byId("continue-google").hidden = true;
  byId("continue-google").removeAttribute("href");
  errorAt("settings-error");
  updateModeControls();
});
byId("cancel-mode").addEventListener("click",() => {
  calendarModeDraft = null;
  errorAt("settings-error");
  updateModeControls();
});
byId("calendar-mode-form").addEventListener("submit",async (event) => {
  event.preventDefault();
  if (savingCalendarMode || !calendarModeDraft || calendarModeDraft === calendarMode()) return;
  const requested = calendarModeDraft;
  savingCalendarMode = true;
  updateModeControls();
  errorAt("settings-error");
  try {
    await api("/api/settings","PATCH",{calendarMode:requested});
    await refresh(true);
    if (calendarMode() !== requested) throw new Error("The mode could not be confirmed. Refresh the planner and check your calendar settings.");
    calendarModeDraft = null;
    toast(requested === "availability" ? "Availability-only planning enabled." : "Calendar event syncing enabled.");
  } catch (error) { errorAt("settings-error",error.message); }
  finally { savingCalendarMode = false; fillCalendarSettings(); }
});

function hasEventPermission(calendar) {
  return calendar.accountMode === "sync" || (!calendar.accountMode && state.connection.accounts?.some((a) => a.email === calendar.accountEmail && a.mode === "sync"));
}

function fillCalendarSettings() {
  const connection = state.connection;
  const events = calendarMode() === "sync";
  const health = connection.error || (connection.lastSync && connection.connected ? (events ? "Last synced " : "Availability checked ") + new Date(connection.lastSync).toLocaleString() + "." : "");
  const push = state.calendarPush;
  let delivery = "";
  if (connection.connected) {
    delivery = push?.connected && push.covered
      ? "Google push is live for " + push.covered + " of " + push.selected + (push.selected === 1 ? " calendar." : " calendars.")
      : "Dayline is checking Google for changes automatically.";
  }
  byId("calendar-health").textContent = [delivery,health].filter(Boolean).join(" ");
  byId("calendar-health").hidden = !delivery && !health;
  byId("calendar-health").title = push?.lastNotificationAt
    ? "Last Google notification received " + new Date(push.lastNotificationAt).toLocaleString() : "";
  const accounts = connection.accounts || (connection.connected && connection.email ? [{sub:"",email:connection.email}] : []);
  updateModeControls();
  const signature = JSON.stringify([events,accounts,state.calendars,state.settings.targetCalendarId,state.settings.excludedCalendarIds,connection.configured]);
  if (settingsSignature === signature) return;
  settingsSignature = signature;
  byId("calendar-accounts").replaceChildren(...accounts.map((account) => {
    const row = element("div","account-row");
    const remove = button("text-button","disconnect","Disconnect " + account.email,"Disconnect");
    remove.dataset.sub = account.sub;
    remove.addEventListener("click",() => disconnect(account,remove));
    const identity = element("div","account-identity");
    const grant = account.meetingDetails ? (events && account.mode === "sync" ? "Meeting details and task event syncing" : "Read-only meeting details and busy times") : "Busy times only";
    identity.append(element("strong","",account.email),element("small","",grant));
    if (!account.meetingDetails && connection.configured) {
      const access = button("account-access","meeting-access","Show meeting details for " + account.email,"Show meeting details");
      access.disabled = savingCalendarMode || Boolean(calendarModeDraft && calendarModeDraft !== calendarMode());
      access.addEventListener("click",() => startConnection(access,{mode:"details",accountSub:account.sub}));
      identity.append(access);
    }
    row.append(identity,remove);
    return row;
  }));
  byId("setup-box").hidden = Boolean(connection.configured);
  byId("change-client").hidden = !connection.configured || connection.connected;
  byId("continue-google").hidden = true;
  byId("continue-google").removeAttribute("href");
  const syncAccount = accounts.find((account) => account.mode === "sync");
  const upgrade = events && accounts.length > 0 && !syncAccount;
  byId("permission-hint").hidden = !upgrade;
  byId("permission-hint").textContent = upgrade ? "Reconnect your destination account and allow Google Calendar event changes to start syncing tasks." : "";
  byId("connect-account").lastElementChild.textContent = upgrade ? "Reconnect Google account" : accounts.length ? (events ? "Connect or update Google account" : "Connect another Google account") : "Connect Google account";
  if (!connection.connected) return;
  const target = byId("target-calendar");
  const available = state.calendars.filter((calendar) => calendar.canCheckAvailability !== false);
  const writable = available.filter((c) => c.writable && hasEventPermission(c));
  byId("target-field").hidden = !events || !writable.length;
  target.replaceChildren();
  const multiAccount = accounts.length > 1;
  if (events && writable.some((c) => c.primary && c.accountEmail === syncAccount?.email)) {
    target.append(new Option("Primary calendar" + (multiAccount ? " · " + syncAccount.email : ""),"primary"));
  }
  for (const calendar of writable) {
    const name = calendar.name + (multiAccount && calendar.accountEmail ? " · " + calendar.accountEmail : "");
    target.append(new Option(name,calendar.id));
  }
  target.value = state.settings.targetCalendarId || "primary";
  if (events && writable.length && target.selectedIndex < 0) {
    const missing = new Option("Choose a writable calendar","");
    missing.disabled = true;
    target.append(missing);
    target.value = "";
  }
  const checkboxes = available.map((cal) => {
    const label = element("label","calendar-option");
    const input = element("input");
    input.type = "checkbox";
    input.value = cal.id;
    input.checked = !state.settings.excludedCalendarIds.includes(cal.id);
    const text = element("span","",cal.name);
    if (multiAccount && cal.accountEmail) text.append(element("small","",cal.accountEmail));
    label.append(input,text);
    return label;
  });
  byId("calendar-list").replaceChildren(...checkboxes);
  markDestination();
  if (!checkboxes.length) {
    const help = state.calendars.length ? "Connect an account with a calendar that shares busy times." : "Refresh your calendar connection to load the list.";
    byId("calendar-list").append(element("p","hint",help));
  }
}

function markDestination() {
  const selected = byId("target-calendar").value;
  const targetAccount = state.connection.accounts?.find((account) => account.mode === "sync");
  const target = selected === "primary" ? state.calendars.find((cal) => cal.primary && cal.canCheckAvailability !== false && cal.accountEmail === targetAccount?.email)?.id : selected;
  for (const input of byId("calendar-list").querySelectorAll("input")) {
    input.disabled = calendarMode() === "sync" && input.value === target;
    if (input.disabled) input.checked = true;
    input.parentElement.title = input.disabled ? "Always checked for the calendar where new tasks are placed." : "";
  }
}
byId("target-calendar").addEventListener("change",markDestination);

byId("calendar-form").addEventListener("submit",async (event) => {
  event.preventDefault();
  if (calendarModeDraft && calendarModeDraft !== calendarMode()) return;
  const choices = [...byId("calendar-list").querySelectorAll("input")];
  if (!choices.length) return errorAt("settings-error","Load the calendar list before saving availability preferences.");
  if (!choices.some((input) => input.checked)) return errorAt("settings-error","Choose at least one calendar to check for busy times.");
  const shownIds = new Set(choices.map((input) => input.value));
  const excluded = state.settings.excludedCalendarIds.filter((id) => !shownIds.has(id));
  const changes = {excludedCalendarIds:excluded.concat(choices.filter((input) => !input.checked).map((input) => input.value))};
  if (calendarMode() === "sync" && !byId("target-field").hidden) {
    if (!byId("target-calendar").value) return errorAt("settings-error","Choose a writable calendar for new events.");
    changes.targetCalendarId = byId("target-calendar").value;
  }
  await saveSettings(changes,event.currentTarget);
});

byId("change-client").addEventListener("click",() => {
  byId("setup-box").hidden = false;
  byId("change-client").hidden = true;
  byId("oauth-file").focus();
});

byId("oauth-file").addEventListener("change",async (event) => {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file) return;
  errorAt("settings-error");
  input.disabled = true;
  try {
    if (file.size > 65536) throw new Error("Choose the small JSON client file downloaded from Google Cloud.");
    let config;
    try { config = JSON.parse(await file.text()).installed; }
    catch { throw new Error("Choose a valid Google Desktop client JSON file."); }
    if (!config || typeof config.client_id !== "string" || !config.client_id) throw new Error("This file must contain a Desktop app OAuth client. Download the Desktop client JSON from Google Cloud.");
    await api("/api/connection/config","POST",{clientId:config.client_id,clientSecret:config.client_secret || ""});
    await refresh(true);
    fillCalendarSettings();
    toast("Google client configured on this Mac.");
  } catch (error) { errorAt("settings-error",error.message); }
  finally { input.disabled = false; input.value = ""; }
});

async function startConnection(start,options) {
  const link = byId("continue-google");
  const savedMode = calendarMode();
  if (savingCalendarMode || (calendarModeDraft && calendarModeDraft !== savedMode)) return;
  errorAt("settings-error");
  start.disabled = true;
  try {
    const {url} = await api("/api/connection/start","POST",{expectedMode:savedMode,...options});
    if (calendarMode() !== savedMode || (calendarModeDraft && calendarModeDraft !== savedMode)) return;
    const destination = new URL(url);
    if (destination.protocol !== "https:" || destination.hostname !== "accounts.google.com") throw new Error("The sign-in address was unavailable. Try connecting again.");
    link.href = destination.href;
    link.hidden = false;
    link.click();
  } catch (error) { errorAt("settings-error",error.message); }
  finally { start.disabled = false; }
}
byId("connect-account").addEventListener("click",event =>
  startConnection(event.currentTarget,calendarMode() === "availability" ? {mode:"details"} : {}));

async function disconnect(account,control) {
  if (!window.confirm("Disconnect " + account.email + " from Dayline on this Mac?")) return;
  control.disabled = true;
  errorAt("settings-error");
  try {
    await api("/api/connection/disconnect","POST",account.sub ? {sub:account.sub} : {});
    await refresh(true);
    fillCalendarSettings();
    toast("Account disconnected.");
  } catch (error) { errorAt("settings-error",error.message); }
  finally { control.disabled = false; }
}

byId("sync-now").addEventListener("click",async () => {
  const syncButton = byId("sync-now");
  syncButton.disabled = true;
  byId("sync-label").textContent = refreshLabel(true);
  try {
    await api("/api/sync","POST",{});
    await refresh(true,true);
    if (state.connection.error) toast(state.connection.error);
    else if (state.connection.syncing) toast(refreshLabel(true));
    else toast(calendarMode() === "availability" ? "Calendar availability refreshed." : "Calendars synced.");
  } catch (error) { toast(error.message); }
  finally { syncButton.disabled = Boolean(state?.connection.syncing); byId("sync-label").textContent = refreshLabel(state?.connection.syncing); }
});

const syncDescriptions = {
  local:"Planned on this Mac.",
  pending:"Waiting to sync with Google Calendar.",
  synced:"Synced with Google Calendar.",
  attention:"Calendar sync needs attention.",
  deleting:"Removal is queued for Google Calendar."
};

function taskStatus(task) {
  if (task.estimateState === "queued") return "Queued for an estimate.";
  if (task.estimateState === "estimating") return "Your task agent is estimating this task.";
  if (task.estimateState === "failed") return "Estimate unavailable.";
  if (task.pendingEstimate) return "Awaiting estimate";
  if (calendarMode() === "sync") return syncDescriptions[task.syncStatus];
  if (task.syncStatus === "pending") return "Waiting to check calendar availability.";
  if (task.syncStatus === "attention") return "This task needs scheduling attention.";
  return task.start ? "Scheduled on this Mac." : "Saved on this Mac.";
}

function openEditor(task) {
  editingTask = task;
  const title = byId("task-title-input");
  title.value = task.title || "";
  title.dataset.initial = title.value;
  byId("task-text").value = task.text;
  subtaskControls.showEditor(task);
  byId("task-estimate-fields").hidden = Boolean(task.pendingEstimate);
  byId("task-minutes").value = task.pendingEstimate ? "" : task.minutes;
  byId("duration-learning").hidden = Boolean(task.pendingEstimate);
  const originalEstimate = task.estimatedMinutes > 0 && task.estimatedMinutes !== task.minutes ? "Originally estimated at " + task.estimatedMinutes + " min. " : "";
  byId("duration-learning").textContent = originalEstimate + "Changing the duration helps Dayline estimate similar tasks on this Mac.";
  byId("task-category").replaceChildren(...state.categories.map((cat) => new Option(cat.name,cat.id)));
  byId("task-category").value = task.pendingEstimate ? "" : task.category;
  byId("task-day").value = task.earliestDay && task.earliestDay === task.latestDay ? task.earliestDay : "";
  byId("task-day").dataset.initial = byId("task-day").value;
  const reason = !task.pendingEstimate && task.reason;
  const fit = fittedDuration(task);
  const overrun = overrunNote(task);
  const reserved = task.calendarProgressMinutes;
  const progress = Number.isSafeInteger(reserved) && reserved > 0
    ? reserved + (reserved === 1 ? " minute was" : " minutes were") + " scheduled before the calendar interruption. This block shows the remaining time."
    : "";
  byId("estimate-reason").textContent = [reason,fit && (fit.label + ". " + fit.explanation),progress,overrun?.explanation].filter(Boolean).join(" ");
  byId("estimate-reason").hidden = !reason && !fit && !progress && !overrun;
  const info = [];
  if (task.start && !task.pendingEstimate) {
    const date = zonedDay(task.start,state.settings.timeZone);
    const time = task.allDay ? "All day" : instantTime(task.start,state.settings.timeZone) + "–" + instantTime(task.end,state.settings.timeZone);
    info.push(element("span","",formatDay(date,{weekday:"long",month:"short",day:"numeric"}) + " · " + time));
  } else {
    const completedDay = releasedCompletionDay(task,state.settings.timeZone);
    const former = task.completedPlannedSlot;
    const time = former ? " · " + instantTime(former.start,state.settings.timeZone) + "–" + instantTime(former.end,state.settings.timeZone) : "";
    info.push(element("span","",completedDay ? "Completed · Planned for " + formatDay(completedDay,{weekday:"long",month:"short",day:"numeric"}) + time : "Unscheduled"));
  }
  const status = taskStatus(task);
  const estimating = task.estimateState === "queued" || task.estimateState === "estimating";
  const source = estimateSource(estimating ? task.estimateAgent : task.agent);
  if (status && (task.estimateState || !(task.pendingEstimate && source))) info.push(element("span","",status));
  if (source) info.push(element("span","",task.pendingEstimate ? source : "Estimate · " + source));
  const notes = new Set([task.agent?.notice,task.issue].filter((note) => note && !(reason && reason.includes(note))));
  for (const note of notes) info.push(element("span","task-issue",note));
  byId("task-status").replaceChildren(...info);
  byId("delete-task").hidden = false;
  updateEditorControls(task);
  errorAt("task-error");
  if (!byId("task-dialog").open) byId("task-dialog").showModal();
}

function updateEditorControls(task) {
  const deleting = task.syncStatus === "deleting";
  const retrying = retryingEstimates.has(task.id);
  for (const field of byId("task-form").querySelectorAll("textarea,input,select,button[type='submit'],#delete-task")) {
    if (!field.closest("#editor-checklist")) field.disabled = deleting || retrying;
  }
  byId("editor-checklist").inert = deleting || retrying;
  if (task.pendingEstimate) {
    byId("task-minutes").disabled = true;
    byId("task-category").disabled = true;
  }
  const retry = byId("retry-estimate");
  const historicalFallback = task.agent?.outcome === "fallback" && task.agent.provider !== "local";
  const activeEstimate = task.estimateState === "queued" || task.estimateState === "estimating";
  retry.hidden = Boolean(task.done || deleting || activeEstimate || (!task.pendingEstimate && !historicalFallback));
  retry.disabled = retrying;
  retry.textContent = retrying ? "Requesting estimate…" : "Retry estimate";
}

function taskChanges() {
  const text = byId("task-text").value.trim();
  const changes = {};
  const title = byId("task-title-input");
  if (title.value.trim() !== title.dataset.initial) changes.title = title.value.trim();
  if (text !== editingTask.text) changes.text = text;
  if (!editingTask.pendingEstimate) {
    const minutes = Number(byId("task-minutes").value);
    if (minutes !== editingTask.minutes) changes.minutes = minutes;
    const category = byId("task-category").value;
    if (category !== editingTask.category) changes.category = category;
  }
  const day = byId("task-day").value;
  if (day !== byId("task-day").dataset.initial) changes.day = day || null;
  return changes;
}

byId("retry-estimate").addEventListener("click",async () => {
  const task = editingTask;
  const control = byId("retry-estimate");
  if (!task || control.hidden || control.disabled || retryingEstimates.has(task.id)) return;
  if (Object.keys(taskChanges()).length) return errorAt("task-error","Save your changes before retrying the estimate.");
  retryingEstimates.add(task.id);
  updateEditorControls(task);
  errorAt("task-error");
  let problem = "";
  const key = "dayline.estimateRetry." + task.id;
  const prior = localRead("sessionStorage",key);
  const requestId = /^[a-f0-9]{32}$/.test(prior || "") ? prior : crypto.randomUUID().replaceAll("-","");
  localWrite("sessionStorage",key,requestId);
  try {
    await api("/api/tasks/" + encodeURIComponent(task.id) + "/estimate","POST",{requestId});
    localWrite("sessionStorage",key,null);
  } catch (error) {
    if (error.status >= 400 && error.status < 500 && ![401,408,429].includes(error.status)) localWrite("sessionStorage",key,null);
    problem = error.message;
  }
  await refresh(true);
  retryingEstimates.delete(task.id);
  if (!byId("task-dialog").open || editingTask?.id !== task.id) return;
  const updated = state.tasks.find((item) => item.id === task.id);
  if (!updated) { byId("task-dialog").close(); return; }
  openEditor(updated);
  if (problem) errorAt("task-error",problem);
  else if (!byId("service-error").hidden) errorAt("task-error","The retry was sent. Refresh the planner to check the result.");
  else toast(updated.estimateState === "queued" ? "Estimate queued." : updated.estimateState === "estimating" ? "Your agent is estimating the task." : updated.pendingEstimate ? "Still awaiting an estimate." : "Estimate updated.");
});

byId("task-form").addEventListener("submit",async (event) => {
  event.preventDefault();
  if (!editingTask) return;
  const submit = event.currentTarget.querySelector('[type="submit"]');
  if (submit.disabled) return;
  const changes = taskChanges();
  if (changes.title === "") return errorAt("task-error","Enter a title of 1–120 characters.");
  if (changes.text === "") return errorAt("task-error","Enter the task you want to schedule.");
  const day = byId("task-day").value;
  if (day && !editingTask.start && !editingTask.pendingEstimate && editingTask.syncStatus === "attention") changes.day = day;
  const taskId = editingTask.id;
  submit.disabled = true;
  errorAt("task-error");
  try {
    if (!await subtaskControls.saveEditorDrafts(taskId)) return errorAt("task-error","Review the checklist change above before saving.");
    if (Object.keys(changes).length) {
      await api("/api/tasks/" + encodeURIComponent(taskId),"PATCH",changes);
      await refresh(true);
    }
    if (editingTask?.id === taskId && byId("task-dialog").open) byId("task-dialog").close();
    if (Object.keys(changes).length) toast("Task updated.");
  } catch (error) { errorAt("task-error",error.message); }
  finally { submit.disabled = false; }
});

byId("delete-task").addEventListener("click",async () => {
  if (!editingTask) return;
  const prompt = calendarMode() === "sync" ? "Delete this task and remove its linked calendar event, if any?" : "Delete this task from Dayline on this Mac?";
  if (!window.confirm(prompt)) return;
  const control = byId("delete-task");
  control.disabled = true;
  errorAt("task-error");
  try {
    const taskId = editingTask.id;
    await api("/api/tasks/" + encodeURIComponent(taskId),"DELETE",{});
    await refresh(true);
    byId("task-dialog").close();
    toast(state.tasks.some((task) => task.id === taskId) ? "Task removal queued." : "Task deleted.");
  } catch (error) { errorAt("task-error",error.message); }
  finally { control.disabled = false; }
});

function openCalendarAction() {
  const task = state.tasks.find(({id}) => id === route[1]);
  const requested = new URLSearchParams(location.search).get("done");
  actionDone = requested === "1" ? true : requested === "0" ? false : !task?.done;
  renderCalendarAction();
  byId("action-dialog").showModal();
}
function renderCalendarAction() {
  const task = state.tasks.find(({id}) => id === route?.[1]);
  const finished = task && Boolean(task.done) === actionDone;
  const label = actionDone ? "Mark complete" : "Reopen task";
  byId("action-heading").textContent = !task ? "Task unavailable" : finished ? (actionDone ? "Task complete" : "Task open") : label;
  byId("action-task").textContent = task?.title || task?.text || "This task could not be found in this Mac’s planner.";
  const change = calendarMode() === "sync" ? "Confirm to update this task in Dayline and its linked Google Calendar event." : "Availability-only planning is on. Confirm to update completion in Dayline on this Mac.";
  byId("action-description").textContent = !task ? "Open the link on the Mac where the task was scheduled." : finished ? "This task is already in the requested state." : change;
  byId("confirm-action").textContent = label;
  byId("confirm-action").hidden = !task || finished || task.syncStatus === "deleting";
}
byId("confirm-action").addEventListener("click",async () => {
  const control = byId("confirm-action");
  control.disabled = true;
  errorAt("action-error");
  try {
    await api("/api/tasks/" + encodeURIComponent(route[1]),"PATCH",{done:actionDone});
    await refresh(true);
    renderCalendarAction();
  } catch (error) { errorAt("action-error",error.message); }
  finally { control.disabled = false; }
});
byId("action-dialog").addEventListener("close",() => { if (route) history.replaceState(null,"","/"); });

window.addEventListener("focus",calendarUpdates.wake);
window.addEventListener("online",calendarUpdates.wake);
document.addEventListener("visibilitychange",() => { if (document.hidden) calendarUpdates.sleep(); else calendarUpdates.wake(); });
window.addEventListener("pagehide",calendarUpdates.sleep);
window.addEventListener("pageshow",event => { if (event.persisted) calendarUpdates.wake(); });
window.setInterval(calendarUpdates.poll,20000);
calendarUpdates.connect();
refresh(true);
