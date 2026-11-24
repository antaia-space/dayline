import {
  addDays, button, categoryColor, dayIndex, displayTime, duration, element, formatDay,
  hhmmMinutes, icon, instantMinutes, instantTime, weekdayNames, zonedDay
} from "./ui.js";
import { meetingCard, nonblockingMeeting, rangeOnDay } from "./meetings.js";
import { groupOverlappingMeetings, meetingColumns } from "./meeting-columns.js";
import { addOrderHandle } from "./task-order.js";
import { timelineBlock } from "./current-time.js";
import { overrunNote, taskChecklist } from "./subtasks.js";
import { moveLaterButton, movedMarker, movesByDay, placeControls } from "./task-moves.js";

const id = (key) => document.getElementById(key);

function categoryOf(state, task) {
  return state.categories.find(({id}) => id === task.category) || {name:"Task",color:"#76816f"};
}

function categoryDot(category) {
  const dot = element("span","category-dot");
  dot.style.setProperty("--task-color",categoryColor(category.color));
  dot.setAttribute("aria-hidden","true");
  return dot;
}

export function renderKey(categories) {
  id("category-key").replaceChildren(...categories.map((category) => {
    const item = element("span","key-item");
    item.append(categoryDot(category),document.createTextNode(category.name));
    return item;
  }));
}

export function summary(container, tasks, meetings = 0) {
  const booked = tasks.filter(task => task.start && task.end);
  const timed = booked.filter(task => !task.allDay);
  const total = timed.reduce((n,t) => n + Math.max(0,Date.parse(t.end)-Date.parse(t.start))/60000,0);
  const allDay = booked.length - timed.length;
  const completed = tasks.filter((t) => t.done).length;
  const text = tasks.length + (tasks.length === 1 ? " task" : " tasks");
  const items = [element("strong","",text)];
  if (timed.length) items.push(element("span","middle-dot","·"),element("span","",duration(total) + " planned"));
  if (allDay) items.push(element("span","middle-dot","·"),element("span","",allDay + " all-day"));
  if (completed) items.push(element("span","middle-dot","·"),element("span","",completed + " complete"));
  if (meetings) items.push(element("span","middle-dot","·"),element("span","",meetings + (meetings === 1 ? " meeting" : " meetings")));
  container.replaceChildren(...items);
}

export function fittedDuration(task) {
  const original = task.calendarFit?.originalMinutes;
  if (task.pendingEstimate || !Number.isSafeInteger(original) || !Number.isSafeInteger(task.minutes) || task.minutes < 1 || task.minutes >= original) return null;
  return {
    label:duration(task.minutes) + " planned · " + duration(original) + " estimate",
    explanation:"Dayline shortened this block by " + duration(original-task.minutes) + " to fit around calendar commitments. Changing the duration keeps your chosen length."
  };
}

function taskButtons(task,view,displayName) {
  const name = task.title || task.text;
  const checkbox = button("task-toggle","toggle-task",(task.done ? "Reopen " : "Mark complete — ") + name);
  checkbox.dataset.id = task.id;
  checkbox.dataset.focus = view + "-toggle-" + task.id;
  checkbox.setAttribute("aria-pressed", String(Boolean(task.done)));
  checkbox.title = task.done ? "Reopen task" : "Mark complete";
  checkbox.disabled = task.syncStatus === "deleting";
  if (task.done) checkbox.append(icon("check"));
  const title = button("task-title","edit-task","Edit " + name);
  title.append(element("span","task-name",displayName || name),icon("pencil"));
  title.title = "Edit task";
  title.dataset.id = task.id;
  title.dataset.focus = view + "-edit-" + task.id;
  return [checkbox,title];
}

function taskControls(task, state, view,openChecklist = false) {
  const agenda = view === "agenda";
  const name = task.title || task.text;
  const [checkbox,title] = taskButtons(task,agenda ? "agenda" : "board");
  const content = element("div","task-content");
  content.append(title);
  const category = categoryOf(state,task);
  const meta = element("span","task-meta");
  if (task.estimateState === "queued") {
    meta.textContent = "Queued for estimate";
  } else if (task.estimateState === "estimating") {
    meta.textContent = "Estimating…";
  } else if (task.estimateState === "failed") {
    meta.textContent = "Estimate unavailable";
  } else if (task.pendingEstimate) {
    meta.textContent = "Awaiting estimate";
  } else if (task.allDay) {
    if (agenda) meta.textContent = category.name;
    else meta.append(categoryDot(category),document.createTextNode("All day · " + category.name));
  } else if (agenda) {
    if (task.end) meta.append(element("span","agenda-until","Until " + instantTime(task.end,state.settings.timeZone)));
    meta.append(element("span","agenda-category",category.name));
  } else {
    const time = task.start ? instantTime(task.start,state.settings.timeZone) : category.name;
    meta.append(categoryDot(category),element("span","sr-only",task.start ? category.name + ", " : ""),document.createTextNode(time));
    meta.title = category.name;
  }
  const details = element("div","task-details");
  details.append(meta);
  if (!task.pendingEstimate && task.syncStatus !== "deleting" && Number.isSafeInteger(task.minutes) && task.minutes > 0) {
    const group = element("div","duration-adjust");
    group.setAttribute("role","group");
    group.setAttribute("aria-label","Work duration for " + name);
    group.dataset.durationFor = task.id;
    const decrease = button("nudge","adjust-duration","Subtract 5 minutes from " + name,"−");
    const increase = button("nudge","adjust-duration","Add 5 minutes to " + name,"+");
    for (const [control,delta] of [[decrease,-5],[increase,5]]) {
      control.dataset.id = task.id;
      control.dataset.delta = String(delta);
      control.dataset.focus = (agenda ? "agenda-" : "board-") + "duration-" + task.id + "-" + delta;
      control.title = delta > 0 ? "Add 5 minutes" : "Subtract 5 minutes";
    }
    decrease.disabled = task.minutes <= 5;
    const initial = task.allDay && task.minutes === 1440 && !task.estimatedMinutes ? "Effort" : duration(task.minutes);
    const value = element("span","duration-value",initial);
    value.setAttribute("aria-live","polite");
    group.append(decrease,value,increase); details.append(group);
  }
  content.append(details);
  const move = moveLaterButton(task,view);
  if (move) content.append(move);
  const place = view === "backlog" && placeControls(task,state);
  if (place) content.append(place);
  const fit = fittedDuration(task);
  if (fit) {
    const note = element("span","task-fit",fit.label);
    note.title = fit.explanation;
    content.append(note);
  }
  const overrun = overrunNote(task);
  if (overrun) {
    const note = element("span","task-fit",overrun.label);
    note.title = overrun.explanation;
    content.append(note);
  }
  const checklist = taskChecklist(task,view,openChecklist);
  if (checklist) content.append(checklist);
  const issue = task.syncStatus === "deleting" ? "Removal queued" : task.issue;
  // A calendar problem that holds every task is said once, above the list.
  const shared = view === "backlog" && issue === state.connection?.error;
  if (issue && !shared && task.estimateState !== "queued" && task.estimateState !== "estimating") content.append(element("span","task-issue",issue));
  return [checkbox,content];
}

function taskRow(task,state,day,view) {
  const row = element("div","task-row" + (task.done ? " is-done" : ""));
  addOrderHandle(row,task,day,view);
  row.append(...taskControls(task,state,view));
  return row;
}

function taskDay(task, zone) {
  return !task.pendingEstimate && task.start && zonedDay(task.start,zone);
}

export function releasedCompletionDay(task,zone) {
  if (!task.done || task.start || task.end) return "";
  if (task.completedDay) return task.completedDay;
  if (task.earliestDay && task.earliestDay === task.latestDay) return task.earliestDay;
  const recorded = task.completedAt || task.createdAt;
  return recorded ? zonedDay(recorded,zone) : "";
}

// A completed note keeps its full accessible name and editor title. Familiar
// correspondence phrases can be abbreviated without a second model request.
export function shortCompletedTitle(name) {
  const message = /^(?:write|send|compose|draft)\s+(?:(?:an?|the)\s+)?(e-?mail|message|text|reply)\s+to\s+(.+)$/iu.exec(name);
  if (!message) return name;
  const recipient = message[2].split(/\s+(?:about\b|regarding\b|concerning\b|to\s+(?:ask|coordinate|confirm|arrange|discuss)\b)/iu)[0].trim();
  const verb = { message:"Message",text:"Text",email:"Email","e-mail":"Email",reply:"Reply to" }[message[1].toLowerCase()];
  return recipient ? verb + " " + recipient : name;
}

const expandedCompletions = new Set();

function completedSection(tasks,day,view,slotZone) {
  const section = element("section","completed-section" + (slotZone ? " in-slot" : ""));
  section.setAttribute("aria-label","Completed tasks for " + formatDay(day,{weekday:"long",month:"short",day:"numeric"}));
  section.append(element("h3",slotZone ? "sr-only" : "completed-label",slotZone ? "Completed early" : "Completed"));
  let rows = section;
  if (slotZone && tasks.length > 1) {
    const group = element("details","completed-group");
    const key = tasks.map(task => task.id).join("-");
    group.open = expandedCompletions.has(key);
    group.ontoggle = () => {
      if (group.isConnected) {
        if (group.open) expandedCompletions.add(key);
        else expandedCompletions.delete(key);
      }
    };
    const summary = element("summary","completed-group-summary");
    summary.dataset.focus = view + "-completed-group-" + key;
    summary.setAttribute("aria-label",tasks.length + " tasks completed early. Show or hide the list.");
    summary.append(icon("check"),element("span","completed-short-name",shortCompletedTitle(tasks[0].title || tasks[0].text)),
      element("span","completed-count","+" + (tasks.length-1)),icon("down"));
    group.append(summary);
    section.append(group);
    rows = group;
  }
  for (const task of tasks) {
    const row = element("div","completed-row");
    const [toggle,title] = taskButtons(task,view,slotZone && shortCompletedTitle(task.title || task.text)), content = element("div","completed-content");
    content.append(title);
    row.append(toggle,content);
    if (slotZone) {
      const {start,end} = task.completedPlannedSlot;
      const original = "Originally " + instantTime(start,slotZone) + "–" + instantTime(end,slotZone);
      const fullTitle = task.title || task.text;
      title.title = fullTitle + " · " + original;
      title.setAttribute("aria-description",original);
      content.append(element("span","sr-only",original));
      row.append(element("span","completed-duration",duration(Math.round((Date.parse(end)-Date.parse(start))/60000))));
    } else {
      const checklist = taskChecklist(task,view);
      if (checklist) content.append(checklist);
    }
    rows.append(row);
  }
  return section;
}

function groupReleasedSlots(tasks,entries,day,zone) {
  const matched = new Map(), remaining = [];
  // Prefer the timed task now occupying the reservation, then the nearest
  // meeting or free interval. All-day banners have no clock position.
  const rank = entry => entry.task ? 0 : entry.meeting ? 1 : entry.kind === "moved" ? 3 : 2;
  const positions = entries.filter(entry => !entry.task?.allDay && !entry.meeting?.allDay &&
    !(entry.kind === "busy" && entry.start === 0 && entry.end === 1440))
    .sort((a,b) => rank(a)-rank(b) || b.start-a.start);
  for (const task of tasks) {
    const slot = task.completedPlannedSlot;
    const start = Date.parse(slot?.start), end = Date.parse(slot?.end);
    const valid = end > start && zonedDay(start,zone) === day;
    const minute = valid ? instantMinutes(start,zone) : null;
    const row = valid && positions.find(entry => entry.start <= minute && minute < entry.end);
    if (!row) { remaining.push(task); continue; }
    if (!matched.has(row)) matched.set(row,[]);
    matched.get(row).push(task);
  }
  return {matched,remaining};
}

function groupWeek(tasks,days,zone) {
  const grouped = new Map(days.map(day => [day,[]]));
  for (const task of tasks) {
    const released = releasedCompletionDay(task,zone);
    if (released) grouped.get(released)?.push(task);
    else if (task.allDay && !task.pendingEstimate) {
      for (const day of days) if (rangeOnDay(task,day,zone)) grouped.get(day).push(task);
    } else grouped.get(taskDay(task,zone))?.push(task);
  }
  return grouped;
}

function ordered(tasks) {
  return [...tasks].sort((a,b) => String(a.start || a.createdAt).localeCompare(String(b.start || b.createdAt)) || a.text.localeCompare(b.text));
}

function dayStrip(container, days, selected, today, tasksByDay, calendar, moves) {
  const buttons = days.map((day) => {
    const label = formatDay(day,{weekday:"long",month:"long",day:"numeric",year:"numeric"});
    const count = tasksByDay.get(day)?.length || 0;
    const meetings = calendar.get(day)?.meetings.length || 0;
    const moved = moves.get(day)?.length || 0;
    const suffix = [count && count + (count === 1 ? " task" : " tasks"),meetings && meetings + (meetings === 1 ? " meeting" : " meetings"),
      moved && moved + (moved === 1 ? " moved task" : " moved tasks")].filter(Boolean);
    const select = button(suffix.length ? "has-tasks" : "","pick-day",[label,...suffix].join(", "));
    select.dataset.day = day;
    select.dataset.focus = container.id + "-" + day;
    select.setAttribute("aria-pressed",String(day === selected));
    if (day === today) select.setAttribute("aria-current","date");
    select.append(element("span","",formatDay(day,{weekday:"short"})),element("strong","",formatDay(day,{day:"numeric"})));
    return select;
  });
  container.style.gridTemplateColumns = "repeat(" + days.length + ", minmax(0, 1fr))";
  container.replaceChildren(...buttons);
}

export function renderWeek(state,{monday,selected,today,weekends,events = []}) {
  const zone = state.settings.timeZone;
  const fullWeek = Array.from({length:7},(_,i) => addDays(monday,i));
  const days = weekends ? fullWeek : fullWeek.slice(0,5);
  const tasksByDay = groupWeek(ordered(state.tasks),fullWeek,zone);
  const moves = movesByDay(state.tasks,fullWeek,zone);
  const calendar = new Map(days.map(day => [day,calendarEntriesForDay(state,events,day,zone)]));
  const visible = new Set(days.flatMap(day => tasksByDay.get(day)));
  const hiddenWeekendTasks = new Set(fullWeek.slice(days.length).flatMap(day => tasksByDay.get(day)).filter(task => !visible.has(task))).size;
  summary(id("week-summary"),[...visible],new Set(days.flatMap(day => calendar.get(day).meetings.map(entry => entry.meeting.id))).size);
  const weekendHistory = fullWeek.slice(days.length).some(day => moves.get(day).length);
  if (hiddenWeekendTasks || weekendHistory) {
    const showWeekends = button("summary-link","show-weekends","Show weekend days",hiddenWeekendTasks
      ? hiddenWeekendTasks + (hiddenWeekendTasks === 1 ? " weekend task" : " weekend tasks") : "Weekend move history");
    id("week-summary").append(element("span","middle-dot","·"),showWeekends);
  }
  dayStrip(id("week-strip"),days,selected,today,tasksByDay,calendar,moves);
  // The week is a time grid: one hour axis, and every block as tall as it is long.
  const plans = new Map(days.map(day => {
    const {meetings,anonymous} = calendar.get(day);
    const entries = tasksByDay.get(day).filter(task => task.start).map(task => ({task,...rangeOnDay(task,day,zone)}));
    const all = groupOverlappingMeetings([...entries,...meetings,...anonymous,...moves.get(day)]).sort(entryOrder);
    return [day,{banners:all.filter(wholeDay),timed:all.filter(entry => !wholeDay(entry)),
      completed:tasksByDay.get(day).filter(task => !task.start && task.done)}];
  }));
  const hours = weekHours(state.settings,[...plans.values()].flatMap(plan => plan.timed));
  const work = {start:hhmmMinutes(state.settings.startTime),end:hhmmMinutes(state.settings.endTime)};
  const anyBanner = [...plans.values()].some(plan => plan.banners.length);
  const columns = days.map((day) => {
    const isToday = day === today;
    const off = !state.settings.workDays.includes(dayIndex(day));
    const column = element("article","day-column" + (isToday ? " is-today" : "") + (off ? " is-off" : ""));
    const label = formatDay(day,{weekday:"long",month:"long",day:"numeric"});
    column.setAttribute("aria-label",label);
    column.dataset.selected = String(day === selected);
    const head = element("div","day-head");
    const jump = button("day-jump","open-day","Open agenda for " + label);
    jump.dataset.day = day;
    jump.dataset.focus = "week-head-" + day;
    jump.title = "View day agenda";
    jump.append(element("span","day-name",weekdayNames[dayIndex(day)-1].slice(0,3)),element("span","day-number",formatDay(day,{day:"numeric"})));
    const add = button("icon-button day-add","add-day","Add a task on " + label);
    add.dataset.day = day;
    add.dataset.focus = "add-" + day;
    add.title = "Add a task on " + label;
    add.append(icon("plus"));
    const endControls = element("div","day-head-end");
    endControls.append(add);
    if (isToday) endControls.append(element("span","today-tag","Today"));
    head.append(jump,endControls);
    const {banners,timed,completed} = plans.get(day);
    const rowFor = entry => {
      if (entry.task) return taskRow(entry.task,state,day,"board");
      if (entry.kind === "overlap") return meetingColumns(entry,day,undefined,true);
      if (entry.meeting) return meetingCard(entry,day,false);
      if (entry.kind === "moved") return movedMarker(entry,"board",categoryOf(state,entry.parent).color);
      const row = element("div","week-busy");
      const time = entry.start === 0 && entry.end === 1440 ? "All day" : displayTime(entry.start) + "–" + displayTime(entry.end);
      row.append(element("span","","Calendar busy"),element("small","",time));
      return row;
    };
    const allDay = element("div","week-allday");
    for (const entry of banners) allDay.append(timelineBlock(rowFor(entry),entry));
    const body = element("div","day-body");
    body.dataset.clockDay = day;
    body.style.setProperty("--grid-minutes",String(hours.end-hours.start));
    body.style.setProperty("--work-from",String(off ? 0 : Math.max(0,work.start-hours.start)));
    body.style.setProperty("--work-to",String(off ? 0 : Math.max(0,work.end-hours.start)));
    // An empty stretch of the day still has a place for the current-time line.
    const ruler = element("div","week-ruler");
    ruler.setAttribute("aria-hidden","true");
    body.append(timelineBlock(ruler,{kind:"available",start:hours.start,end:hours.end}));
    const lanes = weekLanes(timed);
    for (const entry of timed) {
      const length = Math.max(entry.end-entry.start,WEEK_SHORTEST), task = entry.task;
      const kind = task ? "task" + (task.done ? " is-done" : "") : entry.kind === "overlap" ? "overlap" : entry.meeting ? "meeting" : entry.kind;
      const slot = element("div","week-slot is-" + kind + (length <= 15 ? " is-brief" : length <= 30 ? " is-short" : ""));
      const {lane,count} = lanes.get(entry);
      slot.style.setProperty("--from",String(entry.start-hours.start));
      slot.style.setProperty("--minutes",String(length));
      slot.style.setProperty("--lane",String(lane));
      slot.style.setProperty("--lanes",String(count));
      if (task) slot.style.setProperty("--task-color",categoryColor(categoryOf(state,task).color));
      slot.append(timelineBlock(rowFor(entry),entry));
      body.append(slot);
    }
    const foot = element("div","week-foot");
    if (completed.length) foot.append(timelineBlock(completedSection(completed,day,"board"),{kind:"banner"}));
    column.append(head,allDay,body,foot);
    return column;
  });
  const axis = element("div","week-hours");
  axis.setAttribute("aria-hidden","true");
  const scale = element("div","week-hours-scale");
  for (let minute = hours.start; minute <= hours.end; minute += 60) {
    const mark = element("span","week-hour",displayTime(minute));
    mark.style.setProperty("--from",String(minute-hours.start));
    scale.append(mark);
  }
  axis.append(element("div","week-hours-head"),element("div","week-hours-allday",anyBanner ? "All day" : ""),scale,element("div","week-foot"));
  const board = id("week-board");
  board.style.setProperty("--columns",String(days.length));
  board.replaceChildren(axis,...columns);
}

const WEEK_SHORTEST = 10;
const wholeDay = entry => Boolean(entry.task?.allDay || entry.meeting?.allDay || (entry.kind === "busy" && entry.start === 0 && entry.end === 1440));

// The hours every column shows: working hours, widened to whole hours around anything earlier or later.
export function weekHours(settings,timed) {
  let start = hhmmMinutes(settings.startTime), end = hhmmMinutes(settings.endTime);
  for (const entry of timed) {
    start = Math.min(start,entry.start);
    end = Math.max(end,entry.end);
  }
  return {start:Math.floor(start/60)*60,end:Math.min(1440,Math.ceil(end/60)*60)};
}

// Blocks that share time sit side by side. A block is drawn at least ten
// minutes tall, so a five-minute task also takes a lane beside its neighbour.
export function weekLanes(entries) {
  const placed = new Map();
  let group = [], ends = [], latest = -Infinity;
  const close = () => {
    for (const entry of group) placed.get(entry).count = ends.length;
    group = []; ends = []; latest = -Infinity;
  };
  for (const entry of [...entries].sort((a,b) => a.start-b.start || b.end-a.end)) {
    const until = Math.max(entry.end,entry.start+WEEK_SHORTEST);
    if (group.length && entry.start >= latest) close();
    let lane = ends.findIndex(end => end <= entry.start);
    if (lane === -1) lane = ends.length;
    ends[lane] = until;
    latest = Math.max(latest,until);
    placed.set(entry,{lane,count:1});
    group.push(entry);
  }
  close();
  return placed;
}

function mergeRanges(ranges) {
  const result = [];
  for (const next of [...ranges].sort((a,b) => a.start - b.start || a.end - b.end)) {
    if (next.end <= next.start) continue;
    const last = result.at(-1);
    if (last && next.start <= last.end) last.end = Math.max(last.end,next.end);
    else result.push({...next});
  }
  return result;
}

function entryOrder(a,b) {
  const allDay = e => Boolean(e.task?.allDay || e.meeting?.allDay);
  return Number(allDay(b)) - Number(allDay(a)) || a.start - b.start || a.end - b.end;
}

export function calendarEntriesForDay(state,events,day,zone) {
  const meetings = events.flatMap(meeting => {
    const range = rangeOnDay(meeting,day,zone);
    return range ? [{...range,kind:"meeting",meeting}] : [];
  });
  const busy = mergeRanges(state.busy.map(item => rangeOnDay(item,day,zone)).filter(Boolean));
  const known = meetings.filter(entry => !nonblockingMeeting(entry.meeting));
  const linked = state.settings.calendarMode === "sync" ? state.tasks
    .filter(t => t.start && t.end && (t.hasCalendarEvent ?? t.syncStatus === "synced"))
    .map(t => rangeOnDay(t,day,zone)).filter(Boolean) : [];
  const identified = mergeRanges([...known,...linked]);
  const anonymous = busy.flatMap(period => subtractRanges(period,identified).map(range => ({...range,kind:"busy"})));
  // An invitation can be visible in Google Calendar without reserving the
  // viewer's time. Free/busy is authoritative over the area it has verified.
  const coverage = !state.connection.error && rangeOnDay({start:state.busyStart,end:state.busyEnd},day,zone);
  const unverified = coverage ? known.flatMap(entry => subtractRanges(entry,[coverage])) : known;
  return {meetings,anonymous,occupied:mergeRanges([...busy,...unverified])};
}

function subtractRanges(range, cuts) {
  let cursor = range.start;
  const result = [];
  for (const cut of cuts) {
    if (cut.end <= cursor || cut.start >= range.end) continue;
    if (cut.start > cursor) result.push({start:cursor,end:Math.min(cut.start,range.end)});
    cursor = Math.max(cursor,cut.end);
    if (cursor >= range.end) break;
  }
  if (cursor < range.end) result.push({start:cursor,end:range.end});
  return result;
}

export function freeTimeRows(ranges,day,now,zone,history = []) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) return ranges.map(range => ({...range,kind:"available"}));
  const next = new Date(Math.ceil(instant.getTime() / 60000) * 60000);
  const nextDay = zonedDay(next,zone);
  const cutoff = day < nextDay ? 1440 : day > nextDay ? 0 : instantMinutes(next,zone);
  const result = [];
  for (const {start,end} of ranges) {
    if (start < cutoff) {
      const earlier = {start,end:Math.min(end,cutoff)};
      for (const gap of subtractRanges(earlier,history)) result.push({...gap,kind:"elapsed"});
    }
    if (end > cutoff) result.push({start:Math.max(start,cutoff),end,kind:"available"});
  }
  return result;
}

function agendaTask(entry,state,day) {
  const {task} = entry;
  const card = element("div","agenda-block agenda-task" + (task.done ? " is-done" : ""));
  card.style.setProperty("--task-color",categoryColor(categoryOf(state,task).color));
  const openChecklist = !task.done && task.subtasks?.length > 0 && task.subtasks.length <= 3 && entry.end-entry.start >= 30;
  addOrderHandle(card,task,day,"agenda");
  card.append(...taskControls(task,state,"agenda",openChecklist));
  return card;
}

export function agendaBlockSize(entry,day,zone) {
  const item = entry.task || entry.meeting || entry.move;
  if (item?.allDay || (entry.kind === "busy" && entry.start === 0 && entry.end === 1440)) {
    return {minimumRem:2.5,compact:true};
  }
  let minutes = Math.max(0,entry.end-entry.start);
  // On a clock-change day elapsed time can differ from the clock labels.
  // Multi-day entries use the part displayed on this day.
  const slotZone = entry.zone || zone;
  if (item?.start && item.end && zonedDay(item.start,slotZone) === day && zonedDay(item.end,slotZone) === day) {
    minutes = (Date.parse(item.end)-Date.parse(item.start))/60000;
  }
  const minimumRem = item
    ? 2.1 + Math.min(minutes,60)*.065 + Math.min(Math.max(minutes-60,0),60)*.02
    : 2 + Math.min(minutes,90)*.016;
  return {minimumRem:Number(minimumRem.toFixed(3)),compact:minutes <= 15};
}

export function renderAgenda(state,{monday,selected,today,events = []}) {
  const zone = state.settings.timeZone;
  id("agenda").dataset.clockDay = selected;
  const days = Array.from({length:7},(_,i) => addDays(monday,i));
  const tasksByDay = groupWeek(state.tasks,days,zone);
  const moves = movesByDay(state.tasks,days,zone);
  const calendar = new Map(days.map(day => [day,calendarEntriesForDay(state,events,day,zone)]));
  dayStrip(id("agenda-strip"),days,selected,today,tasksByDay,calendar,moves);
  const taskEntries = state.tasks.flatMap((task) => {
    const range = task.start && task.end && !task.pendingEstimate && rangeOnDay(task,selected,zone);
    return range ? [{...range,kind:"task",task}] : [];
  });
  const booked = mergeRanges(taskEntries);
  const {meetings,anonymous,occupied} = calendar.get(selected);
  const completed = tasksByDay.get(selected).filter(task => !task.start && task.done);
  const history = moves.get(selected);
  const entries = [...taskEntries,...meetings,...anonymous,...history];
  const workday = state.settings.workDays.includes(dayIndex(selected));
  const coverage = !state.connection.error && rangeOnDay({start:state.busyStart,end:state.busyEnd},selected,zone);
  if (workday) {
    const hours = {start:hhmmMinutes(state.settings.startTime),end:hhmmMinutes(state.settings.endTime)};
    const free = subtractRanges(hours,mergeRanges([...booked,...occupied]));
    // Saved move intervals describe the old plan. Only elapsed free-time
    // labels give way to them, so future availability stays independent.
    entries.push(...freeTimeRows(free,selected,state.now || Date.now(),zone,mergeRanges(history)));
  }
  const released = groupReleasedSlots(completed,entries,selected,zone);
  summary(id("agenda-summary"),[...taskEntries.map((entry) => entry.task),...completed],meetings.length);
  if (!entries.length && !completed.length) {
    id("agenda").replaceChildren(element("p","agenda-empty",workday ? "No time blocks for this day." : "Outside your working days. No tasks are scheduled."));
    return;
  }
  const rows = groupOverlappingMeetings(entries).sort(entryOrder).map((entry) => {
    const row = element("div","agenda-slot" + (entry.kind === "moved" ? " agenda-moved" : ""));
    if (entry.kind !== "overlap") {
      const size = agendaBlockSize(entry,selected,zone);
      row.style.setProperty("--agenda-block-height",size.minimumRem + "rem");
      if (size.compact) row.classList.add("is-compact");
    }
    const fullBusyDay = entry.kind === "busy" && entry.start === 0 && entry.end === 1440;
    row.append(element("span","agenda-start",entry.task?.allDay || entry.meeting?.allDay || fullBusyDay ? "All day" : displayTime(entry.start)));
    if (entry.kind === "task") row.append(timelineBlock(agendaTask(entry,state,selected),entry));
    else if (entry.kind === "moved") row.append(timelineBlock(movedMarker(entry,"agenda",categoryOf(state,entry.parent).color),entry));
    else if (entry.kind === "overlap") row.append(timelineBlock(meetingColumns(entry,selected,meeting => agendaBlockSize(meeting,selected,zone)),entry));
    else if (entry.meeting) row.append(timelineBlock(meetingCard(entry,selected,true),entry));
    else {
      const isBusy = entry.kind === "busy";
      const block = element("div","agenda-block " + (isBusy ? "agenda-busy" : "agenda-free") + (entry.kind === "elapsed" ? " is-elapsed" : ""));
      const verified = !state.connection.connected || (coverage && coverage.start <= entry.start && entry.end <= coverage.end);
      const title = isBusy ? "Calendar busy" : entry.kind === "elapsed" ? (verified ? "Earlier free time" : "Earlier availability unconfirmed") : verified ? "Unallocated work time" : "Availability unconfirmed";
      block.append(element("span","slot-title",title),element("span","slot-detail","Until " + displayTime(entry.end) + " · " + duration(entry.end - entry.start)));
      row.append(timelineBlock(block,entry));
    }
    const nearby = entry.kind === "overlap"
      ? entry.cells.flatMap(cell => released.matched.get(cell.entry) || [])
      : released.matched.get(entry);
    if (nearby?.length) {
      row.classList.add("has-completed");
      row.append(completedSection(nearby,selected,"agenda",zone));
    }
    return row;
  });
  if (released.remaining.length) rows.push(timelineBlock(completedSection(released.remaining,selected,"agenda"),{kind:"banner"}));
  id("agenda").replaceChildren(...rows);
}

export function renderBacklog(state) {
  const tasks = state.tasks.filter((task) => !task.done && (task.pendingEstimate || !task.start));
  id("backlog-count").textContent = String(tasks.length);
  if (tasks.length) {
    const list = element("div","tray-list");
    list.append(...tasks.map((task) => taskRow(task,state,"unscheduled","backlog")));
    const problem = state.connection?.error, held = problem ? tasks.filter(task => task.issue === problem).length : 0;
    if (held) {
      // Say once why the tasks are here and what brings them back.
      const reason = element("div","tray-reason");
      reason.setAttribute("role","status");
      const text = element("p","",(held === 1 ? "1 task waits" : held + " tasks wait") + " here because Dayline could not read Google Calendar, so it cannot tell which times are free. " +
        "As soon as the calendar can be read, Dayline plans " + (held === 1 ? "it" : "them") + " again, at the same time as before where that is still free.");
      const actions = element("div","tray-reason-actions");
      actions.append(element("span","tray-reason-detail",problem),button("secondary","refresh-availability","Check Google Calendar again","Check again"),
        button("secondary","calendar-settings","Open calendar settings","Calendar settings"));
      reason.append(text,actions);
      id("backlog-content").replaceChildren(reason,list);
    } else id("backlog-content").replaceChildren(list);
  } else {
    id("backlog-content").replaceChildren(element("p","empty-tray","Tasks waiting for a slot will appear here."));
  }
}
