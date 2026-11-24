import {addDays,button,categoryColor,dayIndex,duration,element,formatDay,instantMinutes,instantTime,zonedDay} from "./ui.js";
import {localRead,localWrite} from "./outbox.js";

const shortDate = day => formatDay(day,{weekday:"short",month:"short",day:"numeric"});
const fullDate = day => formatDay(day,{weekday:"long",month:"long",day:"numeric",year:"numeric"});
const validDay = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function moveLaterButton(task,view) {
  if (!task.canMoveLater || task.done) return null;
  const control = button("move-later","move-later","Move " + (task.title || task.text) + " to a later day","Move to…");
  control.dataset.id = task.id;
  control.dataset.focus = view + "-move-later-" + task.id;
  control.setAttribute("aria-haspopup","dialog");
  return control;
}

// History uses the source day's wall clock even if the planner's zone changes.
export function movesByDay(tasks,days,zone) {
  const result = new Map(days.map(day => [day,[]]));
  for (const task of tasks) for (const move of task.movedSlots || []) {
    if (!result.has(move.day) || !validDay(move.toDay) || !(Date.parse(move.end) > Date.parse(move.start))) continue;
    const originalZone = move.timeZone || zone;
    const start = instantMinutes(move.start,originalZone);
    const end = zonedDay(move.end,originalZone) === move.day ? instantMinutes(move.end,originalZone) : 1440;
    result.get(move.day).push({kind:"moved",start,end,parent:task,move,zone:originalZone});
  }
  return result;
}

export function movedMarker(entry,view,color) {
  const {parent,move,zone} = entry;
  const name = parent.title || parent.text;
  const time = instantTime(move.start,zone) + "–" + instantTime(move.end,zone);
  const length = duration(Math.round((Date.parse(move.end) - Date.parse(move.start))/60000));
  const destination = "Moved to " + shortDate(move.toDay);
  const label = name + ". Originally " + fullDate(move.day) + ", " + time + ", " + length +
    ". Moved to " + fullDate(move.toDay) + ". Open that day.";
  const link = button(view === "agenda" ? "agenda-block moved-marker" : "moved-marker","move-destination",label);
  link.style.setProperty("--task-color",categoryColor(color));
  link.dataset.id = parent.id;
  link.dataset.day = move.toDay;
  link.dataset.movedSlot = move.id;
  link.dataset.focus = view + "-moved-" + parent.id + "-" + move.id;
  link.title = label;
  const arrow = element("span","moved-arrow","↪");
  arrow.setAttribute("aria-hidden","true");
  const details = element("span","moved-detail");
  details.append(element("span","moved-time",time + " · " + length),element("span","moved-destination",destination));
  link.append(arrow,element("span","moved-name",name),details);
  return link;
}

export function moveDates(task,state) {
  const {timeZone,workDays,endTime} = state.settings;
  const instant = state.now || Date.now(), today = zonedDay(instant,timeZone);
  const afterSource = addDays(zonedDay(task.start,timeZone),1);
  const min = today > afterSource ? today : afterSource;
  const [h,m] = endTime.split(":").map(Number);
  let next = min === today && instantMinutes(instant,timeZone) >= h*60+m ? addDays(min,1) : min;
  for (let i=0; i<7; i++,next=addDays(next,1)) if (workDays.includes(dayIndex(next))) return {min,value:next};
  return {min,value:min};
}

// The days offered on a task without a time: the next working days, today
// first while it still has working time left.
export function placeDays(state,count = 4) {
  const {timeZone,workDays,endTime} = state.settings;
  const instant = state.now || Date.now(), today = zonedDay(instant,timeZone), tomorrow = addDays(today,1);
  const [h,m] = endTime.split(":").map(Number), days = [];
  for (let day = today, tried = 0; days.length < count && tried < 14; day = addDays(day,1), tried++) {
    if (!workDays.includes(dayIndex(day)) || (day === today && instantMinutes(instant,timeZone) >= h*60+m)) continue;
    days.push({day,label:day === today ? "Today" : day === tomorrow ? "Tomorrow" : shortDate(day)});
  }
  return days;
}

// One click puts a waiting task on a day. Dayline still picks the time, around meetings and other tasks.
export function placeControls(task,state) {
  if (task.done || task.start || task.pendingEstimate || task.syncStatus === "deleting") return null;
  const name = task.title || task.text, chosen = task.earliestDay && task.earliestDay === task.latestDay ? task.earliestDay : "";
  const row = element("div","place-row");
  row.setAttribute("role","group");
  row.setAttribute("aria-label","Schedule " + name);
  row.append(element("span","place-label","Schedule"));
  const add = (day,text,label) => {
    const control = button("place-day" + (day && day === chosen ? " is-chosen" : ""),"place-task",label,text);
    control.dataset.id = task.id;
    control.dataset.day = day;
    control.dataset.focus = "backlog-place-" + task.id + "-" + (day || "any");
    if (day) control.setAttribute("aria-pressed",String(day === chosen));
    control.title = label;
    row.append(control);
  };
  const offered = placeDays(state);
  for (const {day,label} of offered) add(day,label,"Schedule on " + fullDate(day));
  if (chosen && !offered.some(({day}) => day === chosen)) add(chosen,shortDate(chosen),"Scheduled for " + fullDate(chosen) + ", waiting for a free time");
  if (chosen) add("","Any day","Let Dayline pick the next free time");
  const other = element("label","place-other");
  const date = element("input");
  date.type = "date";
  date.min = zonedDay(state.now || Date.now(),state.settings.timeZone);
  date.dataset.placeFor = task.id;
  date.dataset.focus = "backlog-place-" + task.id + "-date";
  date.setAttribute("aria-label","Schedule " + name + " on another day");
  other.append(element("span","","Other day"),date);
  row.append(other);
  return row;
}

// What to tell the person after they chose a day for a waiting task.
export function placedMessage(task,day,state) {
  const zone = state.settings.timeZone;
  if (task?.start) return "Scheduled for " + shortDate(zonedDay(task.start,zone)) + ", " + instantTime(task.start,zone) + ".";
  if (state.connection?.error) return (day ? "Saved for " + shortDate(day) : "Saved") + ". It gets a time once Google Calendar can be read.";
  if (day) return "No free time on " + shortDate(day) + ". Still in Unscheduled." + (task?.issue ? " " + task.issue : "");
  return "No free time found yet. Still in Unscheduled." + (task?.issue ? " " + task.issue : "");
}

export function nextMoveCheck(state) {
  const now = Date.parse(state.now);
  if (!Number.isFinite(now)) return null;
  let next = Infinity;
  for (const task of state.tasks) {
    if (task.done || task.pendingEstimate || task.canMoveLater || task.syncStatus === "deleting") continue;
    const end = Date.parse(task.end);
    if (end > now && end < next) next = end;
  }
  return Number.isFinite(next) ? Math.min(next-now+75,2147483647) : null;
}

export function createMovePicker({api,refresh,getState,notify,focusMarker}) {
  const byId = id => document.getElementById(id);
  const dialog = byId("move-dialog"), date = byId("move-day"), submit = byId("move-submit"), error = byId("move-error");
  let current;
  const key = id => "dayline.moveLater." + id;
  function warning(message = "") { error.hidden = !message; error.textContent = message; }
  function open(task) {
    if (!task.canMoveLater || task.done || dialog.open) return;
    const state = getState(), zone = state.settings.timeZone, {min,value} = moveDates(task,state);
    current = {id:task.id,sourceStart:task.start,sourceEnd:task.end,attempt:null};
    try {
      const pending = JSON.parse(localRead("sessionStorage",key(task.id)) || "null");
      if (pending?.sourceStart === task.start && pending.sourceEnd === task.end && validDay(pending.day) &&
          /^[a-f0-9]{32}$/.test(pending.requestId)) current.attempt = pending;
    } catch { /* The choice remains usable when browser storage is unavailable. */ }
    date.min = min;
    date.value = current.attempt?.day >= min ? current.attempt.day : value;
    date.disabled = submit.disabled = false;
    byId("move-task").textContent = task.title || task.text;
    byId("move-source").textContent = "Originally " + fullDate(zonedDay(task.start,zone)) + ", " + instantTime(task.start,zone) +
      "–" + instantTime(task.end,zone);
    warning();
    dialog.showModal();
    date.focus();
  }
  dialog.addEventListener("close",() => { if (!dialog.open) current = null; });
  byId("move-form").addEventListener("submit",async event => {
    event.preventDefault();
    const opened = current, day = date.value;
    if (!opened || submit.disabled || !date.reportValidity()) return;
    if (opened.attempt?.day !== day) opened.attempt = {day,sourceStart:opened.sourceStart,sourceEnd:opened.sourceEnd,
      requestId:crypto.randomUUID().replaceAll("-","")};
    const attempt = opened.attempt;
    localWrite("sessionStorage",key(opened.id),JSON.stringify(attempt));
    date.disabled = submit.disabled = true;
    warning();
    try {
      const result = await api("/api/tasks/" + encodeURIComponent(opened.id) + "/move-later","POST",attempt);
      localWrite("sessionStorage",key(opened.id),null);
      const active = current === opened && dialog.open;
      if (active) dialog.close();
      await refresh(true);
      if (active) focusMarker(result.movedSlot?.id);
      const live = getState()?.tasks.find(task => task.id === opened.id);
      notify("Moved to " + shortDate(day) + "." + (live && !live.done && !live.start ? " In Unscheduled until a slot is available." : ""));
    } catch (problem) {
      if (current === opened) {
        if (problem.status >= 400 && problem.status < 500 && ![401,408,429].includes(problem.status)) {
          opened.attempt = null;
          localWrite("sessionStorage",key(opened.id),null);
        }
        warning(problem.message);
      } else notify(problem.message);
    } finally {
      if (!current || current === opened) date.disabled = submit.disabled = false;
    }
  });
  return {open};
}
