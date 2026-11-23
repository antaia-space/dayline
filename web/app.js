import {
  addDays, button, dayIndex, displayTime, duration, element, formatDay,
  hhmmMinutes, icon, instantTime, isoWeek, startOfWeek, weekdayNames, weekLabel, workdaysLabel, zonedDay
} from "./ui.js";
import { renderAgenda, renderBacklog, renderKey, renderWeek } from "./views.js";

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
let quickDay = null;
let pendingCreate = null;
let pendingPlacement = null;
let syncRefreshTimer;
const compact = matchMedia("(max-width: 720px)");
let editingTask = null;
let settingTab = "work";
let settingsSignature = "";
let lastRequest = 0;
let lastPaint = "";
let lastConnection = "";
let noticeTimer;
let actionDone;

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

async function api(path, method = "GET", body) {
  let response;
  try {
    response = await fetch(path,{
      method, credentials:"same-origin", cache:"no-store",
      ...(body !== undefined ? {headers:{"Content-Type":"application/json"},body:JSON.stringify(body)} : {}),
      signal:AbortSignal.timeout(115000)
    });
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error("Dayline took too long to respond. Refresh before trying again.");
    throw new Error("The local planner is unavailable. Open Dayline on this Mac, then try again.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Dayline could not finish this action.");
  return data;
}

async function refresh(force = false) {
  const request = ++lastRequest;
  try {
    const next = await api("/api/state");
    if (request !== lastRequest) return;
    const zone = next.settings.timeZone;
    const day = zonedDay(next.now || Date.now(),zone);
    state = next;
    state.busy ||= [];
    state.calendars ||= [];
    state.categories ||= [];
    today = day;
    window.clearTimeout(syncRefreshTimer);
    if (next.connection.syncing) syncRefreshTimer = window.setTimeout(() => refresh(),1500);
    if (pendingPlacement) {
      const placed = next.tasks.find((task) => task.id === pendingPlacement);
      if (placed?.start) {
        pendingPlacement = null;
        const date = zonedDay(placed.start,zone);
        if (!document.querySelector("dialog[open]") && !byId("quick-text").value.trim()) {
          selectedDay = date;
          monday = startOfWeek(date);
          if (dayIndex(date) > 5) weekends = true;
        }
        toast("Scheduled " + formatDay(date,{weekday:"short",month:"short",day:"numeric"}) + " at " + instantTime(placed.start,zone) + ".");
      } else if (placed && placed.syncStatus === "attention" && !next.connection.syncing) {
        pendingPlacement = null;
        toast("Task is in Unscheduled. " + (placed.issue || "Try a different day or duration."));
      }
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
    const paint = JSON.stringify([state.tasks,state.categories,state.settings,state.busy,state.busyStart,state.busyEnd,state.connection,day,selectedDay]);
    if (force || lastPaint !== paint) {
      render();
      lastPaint = paint;
    }
    byId("planner").setAttribute("aria-busy","false");
    byId("service-error").hidden = true;
    if (byId("settings").open && settingTab === "calendars") fillCalendarSettings();
    if (byId("action-dialog").open) renderCalendarAction();
    if (route && !routeOpened) {
      routeOpened = true;
      openCalendarAction();
    }
  } catch (error) {
    if (request !== lastRequest) return;
    byId("service-error-text").textContent = error.message;
    byId("service-error").hidden = false;
    byId("planner").setAttribute("aria-busy","false");
  }
}

function render() {
  if (!state) return;
  const active = document.activeElement;
  const bookmark = active?.dataset.focus;
  const weekView = view === "week";
  const context = {monday,selected:selectedDay,today,weekends};
  byId("view-week").setAttribute("aria-pressed",String(weekView));
  byId("view-day").setAttribute("aria-pressed",String(!weekView));
  byId("week-section").hidden = !weekView;
  byId("day-section").hidden = weekView;
  byId("show-weekends").checked = weekends;
  byId("period-context").textContent = weekView
    ? "Week " + String(isoWeek(monday)).padStart(2,"0") + " · " + formatDay(addDays(monday,3),{year:"numeric"})
    : formatDay(selectedDay,{weekday:"long"}) + " · " + formatDay(selectedDay,{year:"numeric"});
  byId("period-title").textContent = weekView ? weekLabel(monday) : formatDay(selectedDay,{month:"long",day:"numeric"});
  const unit = weekView ? "week" : "day";
  for (const [id,prefix] of [["previous","Previous"],["next","Next"]]) {
    byId(id).setAttribute("aria-label",prefix + " " + unit);
    byId(id).title = prefix + " " + unit;
  }
  if (weekView) renderWeek(state,context);
  else renderAgenda(state,context);
  renderBacklog(state);
  renderKey(state.categories);
  const account = state.connection;
  const status = !account.connected ? "Local planner" : account.error ? "Sync needs attention" : account.syncing ? "Syncing calendars" : "Calendars connected";
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
  byId("sync-label").textContent = account.syncing ? "Syncing…" : "Sync now";
  byId("sync-now").title = account.lastSync ? "Last synced " + new Date(account.lastSync).toLocaleString() : "Refresh calendar availability and task changes";
  const hours = state.settings;
  byId("hours-summary").textContent = workdaysLabel(hours.workDays) + " · " + displayTime(hhmmMinutes(hours.startTime)) + "–" + displayTime(hhmmMinutes(hours.endTime)) + " · " + hours.timeZone.replaceAll("_"," ");
  byId("hours-open").title = "Edit working hours and time zone";
  renderPlanningNote();
  if (bookmark && !active.isConnected) document.querySelector('[data-focus="' + CSS.escape(bookmark) + '"]')?.focus({preventScroll:true});
}

function renderPlanningNote() {
  const note = byId("planning-note");
  let label;
  let explanation;
  if (state.connection.error) {
    label = "Calendar settings";
    explanation = state.connection.error;
  } else if (!state.connection.connected) {
    label = "Connect Google Calendar";
    explanation = "to check your availability and sync scheduled tasks.";
  } else if (view === "day" && state.busyStart && state.busyEnd && (selectedDay < zonedDay(state.busyStart,state.settings.timeZone) || selectedDay >= zonedDay(state.busyEnd,state.settings.timeZone))) {
    explanation = "Calendar availability has not been checked for this date.";
  }
  note.hidden = !explanation;
  if (explanation) {
    const text = element("span");
    if (label && !state.connection.error) { text.append(button("","calendar-settings",label,label),document.createTextNode(" " + explanation)); }
    else {
      text.append(document.createTextNode(explanation));
      if (label) text.append(document.createTextNode(" "),button("","calendar-settings",label,label));
    }
    note.replaceChildren(icon("info"),text);
  }
}

function switchView(next) {
  if (!state) return;
  pendingPlacement = null;
  view = next;
  pref.set("view",view);
  if (view === "week" && dayIndex(selectedDay) > 5 && !weekends) {
    weekends = true;
    pref.set("weekends",true);
  }
  setQuickDay(null);
  render();
}

function navigateTo(day) {
  if (!state) return;
  pendingPlacement = null;
  selectedDay = day;
  monday = startOfWeek(day);
  if (view === "week" && dayIndex(day) > 5 && !weekends) {
    weekends = true;
    pref.set("weekends",true);
  }
  setQuickDay(null);
  render();
}

function setQuickDay(day) {
  quickDay = day;
  byId("quick-day").firstElementChild.textContent = day ? formatDay(day,{month:"short",day:"numeric"}) : "";
  byId("quick-day").hidden = !day;
  byId("quick-text").placeholder = day ? "What do you need to do?" : compact.matches ? "e.g. Review deck, 45m" : "Add a task, e.g. review the deck for 45 minutes tomorrow";
}
compact.addEventListener("change",() => setQuickDay(quickDay));
setQuickDay(null);

function selectComposerDay(day) {
  setQuickDay(day);
  byId("quick-text").focus();
}

byId("view-week").addEventListener("click",() => switchView("week"));
byId("view-day").addEventListener("click",() => switchView("day"));
byId("quick-day").addEventListener("click",() => { setQuickDay(null); byId("quick-text").focus(); });
byId("agenda-add").addEventListener("click",() => selectComposerDay(selectedDay));
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

byId("quick-add").addEventListener("submit",async (event) => {
  event.preventDefault();
  const input = byId("quick-text");
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  if (!state || byId("add-button").disabled) return;
  errorAt("quick-error");
  byId("add-button").disabled = true;
  const day = quickDay;
  try {
    const previousIds = new Set(state.tasks.map((task) => task.id));
    const draft = JSON.stringify([text,day]);
    if (pendingCreate?.draft !== draft) pendingCreate = {draft,requestId:crypto.randomUUID().replaceAll("-","")};
    const result = await api("/api/tasks","POST",{text,requestId:pendingCreate.requestId,...(day ? {day} : {})});
    pendingCreate = null;
    if (input.value.trim() === text) input.value = "";
    if (quickDay === day) setQuickDay(null);
    await refresh(true);
    const added = state.tasks.find((task) => task.id === (result.task?.id || result.id)) || state.tasks.find((task) => !previousIds.has(task.id) && task.text === text);
    if (added?.start) {
      const date = zonedDay(added.start,state.settings.timeZone);
      navigateTo(date);
      toast("Scheduled " + formatDay(date,{weekday:"short",month:"short",day:"numeric"}) + " at " + instantTime(added.start,state.settings.timeZone) + " · " + duration(added.minutes));
    } else if (added) {
      byId("backlog-content").hidden = false;
      byId("backlog-toggle").setAttribute("aria-expanded","true");
      if (state.connection.connected && added.syncStatus === "pending") {
        pendingPlacement = added.id;
        window.clearTimeout(syncRefreshTimer);
        syncRefreshTimer = window.setTimeout(() => refresh(),1000);
        toast("Finding a slot across your calendars…");
      } else toast("Added to Unscheduled.");
    } else toast("Task added.");
    input.focus();
  } catch (error) { errorAt("quick-error",error.message); }
  finally { byId("add-button").disabled = false; }
});

byId("planner").addEventListener("click",async (event) => {
  const target = event.target.closest("button[data-action]");
  if (!target || !state) return;
  const action = target.dataset.action;
  if (action === "add-day") return selectComposerDay(target.dataset.day);
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
  if (event.key === "Escape" && event.target === byId("quick-text") && quickDay) setQuickDay(null);
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
  settingsTab(tab);
  if (!byId("settings").open) byId("settings").showModal();
}

function settingsTab(tab) {
  settingTab = tab;
  byId("tab-work").setAttribute("aria-pressed",String(tab === "work"));
  byId("tab-calendars").setAttribute("aria-pressed",String(tab === "calendars"));
  byId("work-form").hidden = tab !== "work";
  byId("calendar-settings").hidden = tab !== "calendars";
  errorAt("settings-error");
  if (tab === "calendars") fillCalendarSettings();
}

byId("settings-open").addEventListener("click",() => openSettings("work"));
byId("hours-open").addEventListener("click",() => openSettings("work"));
byId("connection-status").addEventListener("click",() => openSettings("calendars"));
byId("tab-work").addEventListener("click",() => settingsTab("work"));
byId("tab-calendars").addEventListener("click",() => settingsTab("calendars"));

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

function fillCalendarSettings() {
  const connection = state.connection;
  const health = connection.error || (connection.lastSync && connection.connected ? "Last synced " + new Date(connection.lastSync).toLocaleString() + "." : "");
  byId("calendar-health").textContent = health || "";
  byId("calendar-health").hidden = !health;
  const accounts = connection.accounts || (connection.connected && connection.email ? [{sub:"",email:connection.email}] : []);
  const signature = JSON.stringify([accounts,state.calendars,state.settings.targetCalendarId,state.settings.excludedCalendarIds,connection.configured]);
  if (settingsSignature === signature) return;
  settingsSignature = signature;
  byId("calendar-accounts").replaceChildren(...accounts.map((account) => {
    const row = element("div","account-row");
    const remove = button("text-button","disconnect","Disconnect " + account.email,"Disconnect");
    remove.dataset.sub = account.sub;
    remove.addEventListener("click",() => disconnect(account,remove));
    row.append(element("strong","",account.email),remove);
    return row;
  }));
  byId("setup-box").hidden = Boolean(connection.configured);
  byId("change-client").hidden = !connection.configured || connection.connected;
  if (accounts.length) byId("continue-google").hidden = true;
  byId("google-login").hidden = !connection.configured;
  byId("connect-account").lastElementChild.textContent = accounts.length ? "Connect another Google account" : "Connect Google account";
  byId("calendar-form").hidden = !connection.connected;
  if (!connection.connected) return;
  const target = byId("target-calendar");
  target.replaceChildren(new Option("Primary calendar","primary"));
  const multiAccount = accounts.length > 1;
  for (const calendar of state.calendars.filter((c) => c.writable)) {
    const name = calendar.name + (multiAccount && calendar.accountEmail ? " · " + calendar.accountEmail : "");
    target.append(new Option(name,calendar.id));
  }
  target.value = state.settings.targetCalendarId || "primary";
  if (target.selectedIndex < 0) {
    const missing = new Option("Previously selected calendar (unavailable)",state.settings.targetCalendarId);
    target.append(missing);
    target.value = state.settings.targetCalendarId;
  }
  const checkboxes = state.calendars.map((cal) => {
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
  if (!checkboxes.length) byId("calendar-list").append(element("p","hint","Calendar list unavailable. Sync to load your calendars."));
}

function markDestination() {
  const selected = byId("target-calendar").value;
  const target = selected === "primary"
    ? state.calendars.find((cal) => cal.primary && (!cal.accountEmail || cal.accountEmail === state.connection.email))?.id
    : selected;
  for (const input of byId("calendar-list").querySelectorAll("input")) {
    input.disabled = input.value === target;
    if (input.disabled) input.checked = true;
    input.parentElement.title = input.disabled ? "Always checked for the calendar where new tasks are placed." : "";
  }
}
byId("target-calendar").addEventListener("change",markDestination);

byId("calendar-form").addEventListener("submit",async (event) => {
  event.preventDefault();
  const excludedCalendarIds = [...byId("calendar-list").querySelectorAll("input:not(:checked)")].map((i) => i.value);
  await saveSettings({excludedCalendarIds,targetCalendarId:byId("target-calendar").value},event.currentTarget);
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

byId("connect-account").addEventListener("click",async () => {
  const start = byId("connect-account");
  const link = byId("continue-google");
  errorAt("settings-error");
  start.disabled = true;
  try {
    const {url} = await api("/api/connection/start","POST",{});
    const destination = new URL(url);
    if (destination.protocol !== "https:" || destination.hostname !== "accounts.google.com") throw new Error("The sign-in address was unavailable. Try connecting again.");
    link.href = destination.href;
    link.hidden = false;
    link.click();
  } catch (error) { errorAt("settings-error",error.message); }
  finally { start.disabled = false; }
});

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
  byId("sync-label").textContent = "Syncing…";
  try {
    await api("/api/sync","POST",{});
    await refresh(true);
    if (state.connection.error) toast(state.connection.error);
    else if (state.connection.syncing) toast("Sync in progress.");
    else toast("Calendars refreshed.");
  } catch (error) { toast(error.message); }
  finally { syncButton.disabled = Boolean(state?.connection.syncing); byId("sync-label").textContent = state?.connection.syncing ? "Syncing…" : "Sync now"; }
});

const syncDescriptions = {
  local:"Planned on this Mac.",
  pending:"Waiting to sync with Google Calendar.",
  synced:"Synced with Google Calendar.",
  attention:"Calendar sync needs attention.",
  deleting:"Removal is queued for Google Calendar."
};

function openEditor(task) {
  editingTask = task;
  byId("task-text").value = task.text;
  byId("task-minutes").value = task.minutes;
  byId("task-category").replaceChildren(...state.categories.map((cat) => new Option(cat.name,cat.id)));
  byId("task-category").value = task.category;
  byId("task-day").value = task.earliestDay && task.earliestDay === task.latestDay ? task.earliestDay : "";
  byId("task-day").dataset.initial = byId("task-day").value;
  byId("estimate-reason").textContent = task.reason || "";
  byId("estimate-reason").hidden = !task.reason;
  const info = [];
  if (task.start) {
    const date = zonedDay(task.start,state.settings.timeZone);
    info.push(element("span","",formatDay(date,{weekday:"long",month:"short",day:"numeric"}) + " · " + instantTime(task.start,state.settings.timeZone) + "–" + instantTime(task.end,state.settings.timeZone)));
  } else info.push(element("span","","Unscheduled"));
  if (syncDescriptions[task.syncStatus]) info.push(element("span","",syncDescriptions[task.syncStatus]));
  if (task.issue) info.push(element("span","task-issue",task.issue));
  byId("task-status").replaceChildren(...info);
  byId("delete-task").hidden = false;
  const deleting = task.syncStatus === "deleting";
  for (const field of byId("task-form").querySelectorAll("textarea,input,select,button[type='submit'],#delete-task")) field.disabled = deleting;
  errorAt("task-error");
  byId("task-dialog").showModal();
}

byId("task-form").addEventListener("submit",async (event) => {
  event.preventDefault();
  if (!editingTask) return;
  const submit = event.currentTarget.querySelector('[type="submit"]');
  if (submit.disabled) return;
  const text = byId("task-text").value.trim();
  if (!text) return errorAt("task-error","Enter the task you want to schedule.");
  const changes = {};
  if (text !== editingTask.text) changes.text = text;
  const minutes = Number(byId("task-minutes").value);
  if (minutes !== editingTask.minutes) changes.minutes = minutes;
  const category = byId("task-category").value;
  if (category !== editingTask.category) changes.category = category;
  const day = byId("task-day").value;
  if (day !== byId("task-day").dataset.initial || (day && !editingTask.start && editingTask.syncStatus === "attention")) changes.day = day || null;
  if (!Object.keys(changes).length) return byId("task-dialog").close();
  submit.disabled = true;
  errorAt("task-error");
  try {
    await api("/api/tasks/" + encodeURIComponent(editingTask.id),"PATCH",changes);
    await refresh(true);
    byId("task-dialog").close();
    toast("Task updated.");
  } catch (error) { errorAt("task-error",error.message); }
  finally { submit.disabled = false; }
});

byId("delete-task").addEventListener("click",async () => {
  if (!editingTask || !window.confirm("Delete this task and remove its Dayline calendar event?")) return;
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
  byId("action-task").textContent = task?.text || "This task could not be found in this Mac’s planner.";
  byId("action-description").textContent = !task ? "Open the link on the Mac where the task was scheduled." : finished ? "This task is already in the requested state." : "Confirm to update this task in Dayline and its Google Calendar event.";
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

window.addEventListener("focus",() => refresh());
document.addEventListener("visibilitychange",() => { if (!document.hidden) refresh(); });
window.setInterval(() => { if (!document.hidden) refresh(); },20000);
refresh(true);
