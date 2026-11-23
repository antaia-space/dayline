import {addDays,button,dayIndex,element,formatDay,instantMinutes,instantTime,zonedDay} from "./ui.js";
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

// A move is a point on the source day's timeline. Its former duration
// is descriptive only and is never included in the planner's occupied time.
export function movesByDay(tasks,days,zone) {
  const result = new Map(days.map(day => [day,[]]));
  for (const task of tasks) for (const move of task.movedSlots || []) {
    if (!result.has(move.day) || !validDay(move.toDay) || !(Date.parse(move.end) > Date.parse(move.start))) continue;
    const originalZone = move.timeZone || zone;
    const minute = instantMinutes(move.start,originalZone);
    result.get(move.day).push({kind:"moved",start:minute,end:minute,parent:task,move,zone:originalZone});
  }
  return result;
}

export function movedMarker(entry,view) {
  const {parent,move,zone} = entry;
  const name = parent.title || parent.text;
  const time = instantTime(move.start,zone);
  const destination = "Moved to " + shortDate(move.toDay);
  const label = name + ". Originally " + fullDate(move.day) + ", " + time + "–" + instantTime(move.end,zone) +
    ". Moved to " + fullDate(move.toDay) + ". Open that day.";
  const link = button("moved-marker","move-destination",label);
  link.dataset.id = parent.id;
  link.dataset.day = move.toDay;
  link.dataset.movedSlot = move.id;
  link.dataset.focus = view + "-moved-" + parent.id + "-" + move.id;
  link.title = label;
  const arrow = element("span","moved-arrow","↪");
  arrow.setAttribute("aria-hidden","true");
  link.append(arrow,element("span","moved-name",name),
    element("span","moved-detail",(view === "board" ? time + " · " : "") + destination));
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
