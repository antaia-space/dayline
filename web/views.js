import {
  addDays, button, categoryColor, dayIndex, displayTime, duration, element, formatDay,
  hhmmMinutes, icon, instantTime, weekdayNames, zonedDay
} from "./ui.js";
import { meetingCard, nonblockingMeeting, rangeOnDay } from "./meetings.js";

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
  const timed = tasks.filter(task => !task.allDay);
  const total = timed.reduce((n,t) => n + Number(t.minutes || 0),0);
  const allDay = tasks.length - timed.length;
  const completed = tasks.filter((t) => t.done).length;
  const text = tasks.length + (tasks.length === 1 ? " task" : " tasks");
  const items = [element("strong","",text)];
  if (timed.length) items.push(element("span","middle-dot","·"),element("span","",duration(total) + " planned"));
  if (allDay) items.push(element("span","middle-dot","·"),element("span","",allDay + " all-day"));
  if (completed) items.push(element("span","middle-dot","·"),element("span","",completed + " complete"));
  if (meetings) items.push(element("span","middle-dot","·"),element("span","",meetings + (meetings === 1 ? " meeting" : " meetings")));
  container.replaceChildren(...items);
}

function taskControls(task, state, agenda = false) {
  const name = task.title || task.text;
  const checkbox = button("task-toggle","toggle-task",(task.done ? "Reopen " : "Mark complete — ") + name);
  checkbox.dataset.id = task.id;
  checkbox.dataset.focus = (agenda ? "agenda-" : "board-") + "toggle-" + task.id;
  checkbox.setAttribute("aria-pressed", String(Boolean(task.done)));
  checkbox.title = task.done ? "Reopen task" : "Mark complete";
  checkbox.disabled = task.syncStatus === "deleting";
  if (task.done) checkbox.append(icon("check"));
  const content = element("div","task-content");
  const title = button("task-title","edit-task","Edit " + name,name);
  title.dataset.id = task.id;
  title.dataset.focus = (agenda ? "agenda-" : "board-") + "edit-" + task.id;
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
    const endTime = task.end ? "Until " + instantTime(task.end,state.settings.timeZone) + " · " : "";
    meta.textContent = endTime + category.name;
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
  const issue = task.syncStatus === "deleting" ? "Removal queued" : task.issue;
  if (issue && task.estimateState !== "queued" && task.estimateState !== "estimating") content.append(element("span","task-issue",issue));
  return [checkbox,content];
}

function taskRow(task,state) {
  const row = element("div","task-row" + (task.done ? " is-done" : ""));
  row.append(...taskControls(task,state));
  return row;
}

function taskDay(task, zone) {
  return !task.pendingEstimate && task.start && zonedDay(task.start,zone);
}

function groupWeek(tasks,days,zone) {
  const grouped = new Map(days.map(day => [day,[]]));
  for (const task of tasks) {
    if (task.allDay && !task.pendingEstimate) {
      for (const day of days) if (rangeOnDay(task,day,zone)) grouped.get(day).push(task);
    } else grouped.get(taskDay(task,zone))?.push(task);
  }
  return grouped;
}

function ordered(tasks) {
  return [...tasks].sort((a,b) => String(a.start || a.createdAt).localeCompare(String(b.start || b.createdAt)) || a.text.localeCompare(b.text));
}

function dayStrip(container, days, selected, today, tasksByDay, calendar) {
  const buttons = days.map((day) => {
    const label = formatDay(day,{weekday:"long",month:"long",day:"numeric",year:"numeric"});
    const count = tasksByDay.get(day)?.length || 0;
    const meetings = calendar.get(day)?.meetings.length || 0;
    const suffix = [count && count + (count === 1 ? " task" : " tasks"),meetings && meetings + (meetings === 1 ? " meeting" : " meetings")].filter(Boolean);
    const select = button(count || meetings ? "has-tasks" : "","pick-day",[label,...suffix].join(", "));
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
  const calendar = new Map(days.map(day => [day,calendarEntriesForDay(state,events,day,zone)]));
  const visible = new Set(days.flatMap(day => tasksByDay.get(day)));
  const hiddenWeekendTasks = new Set(fullWeek.slice(days.length).flatMap(day => tasksByDay.get(day)).filter(task => !visible.has(task))).size;
  summary(id("week-summary"),[...visible],new Set(days.flatMap(day => calendar.get(day).meetings.map(entry => entry.meeting.id))).size);
  if (hiddenWeekendTasks) {
    const showWeekends = button("summary-link","show-weekends","Show weekend tasks",hiddenWeekendTasks + (hiddenWeekendTasks === 1 ? " weekend task" : " weekend tasks"));
    id("week-summary").append(element("span","middle-dot","·"),showWeekends);
  }
  dayStrip(id("week-strip"),days,selected,today,tasksByDay,calendar);
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
    jump.append(element("span","day-name",weekdayNames[dayIndex(day)-1]),element("span","day-number",formatDay(day,{day:"numeric"})));
    const add = button("icon-button day-add","add-day","Add a task on " + label);
    add.dataset.day = day;
    add.dataset.focus = "add-" + day;
    add.title = "Add a task on " + label;
    add.append(icon("plus"));
    const endControls = element("div","day-head-end");
    endControls.append(add);
    if (isToday) endControls.append(element("span","today-tag","Today"));
    head.append(jump,endControls);
    const body = element("div","day-body");
    const {meetings,anonymous} = calendar.get(day);
    const entries = tasksByDay.get(day).map(task => ({task,...rangeOnDay(task,day,zone)}));
    for (const entry of [...entries,...meetings,...anonymous].sort(entryOrder)) {
      if (entry.task) body.append(taskRow(entry.task,state));
      else if (entry.meeting) body.append(meetingCard(entry,day,false));
      else {
        const row = element("div","week-busy");
        const time = entry.start === 0 && entry.end === 1440 ? "All day" : displayTime(entry.start) + "–" + displayTime(entry.end);
        row.append(element("span","","Calendar busy"),element("small","",time));
        body.append(row);
      }
    }
    column.append(head,body);
    return column;
  });
  const board = id("week-board");
  board.style.setProperty("--columns",String(days.length));
  board.replaceChildren(...columns);
}

function mergeRanges(ranges) {
  const result = [];
  for (const next of [...ranges].sort((a,b) => a.start - b.start || a.end - b.end)) {
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
    .filter(t => t.hasCalendarEvent ?? t.syncStatus === "synced")
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

function agendaTask(entry,state) {
  const {task} = entry;
  const card = element("div","agenda-block agenda-task" + (task.done ? " is-done" : ""));
  card.style.setProperty("--task-color",categoryColor(categoryOf(state,task).color));
  card.append(...taskControls(task,state,true));
  return card;
}

export function renderAgenda(state,{monday,selected,today,events = []}) {
  const zone = state.settings.timeZone;
  const days = Array.from({length:7},(_,i) => addDays(monday,i));
  const tasksByDay = groupWeek(state.tasks,days,zone);
  const calendar = new Map(days.map(day => [day,calendarEntriesForDay(state,events,day,zone)]));
  dayStrip(id("agenda-strip"),days,selected,today,tasksByDay,calendar);
  const taskEntries = state.tasks.flatMap((task) => {
    const range = !task.pendingEstimate && rangeOnDay(task,selected,zone);
    return range ? [{...range,kind:"task",task}] : [];
  });
  const booked = mergeRanges(taskEntries);
  const {meetings,anonymous,occupied} = calendar.get(selected);
  const entries = [...taskEntries,...meetings,...anonymous];
  const workday = state.settings.workDays.includes(dayIndex(selected));
  const coverage = !state.connection.error && rangeOnDay({start:state.busyStart,end:state.busyEnd},selected,zone);
  if (workday) {
    const hours = {start:hhmmMinutes(state.settings.startTime),end:hhmmMinutes(state.settings.endTime)};
    for (const range of subtractRanges(hours,mergeRanges([...booked,...occupied]))) entries.push({...range,kind:"available"});
  }
  entries.sort(entryOrder);
  summary(id("agenda-summary"),taskEntries.map((entry) => entry.task),meetings.length);
  if (!entries.length) {
    id("agenda").replaceChildren(element("p","agenda-empty",workday ? "No time blocks for this day." : "Outside your working days. No tasks are scheduled."));
    return;
  }
  const rows = entries.map((entry) => {
    const row = element("div","agenda-slot");
    const fullBusyDay = entry.kind === "busy" && entry.start === 0 && entry.end === 1440;
    row.append(element("span","agenda-start",entry.task?.allDay || entry.meeting?.allDay || fullBusyDay ? "All day" : displayTime(entry.start)));
    if (entry.kind === "task") row.append(agendaTask(entry,state));
    else if (entry.meeting) row.append(meetingCard(entry,selected,true));
    else {
      const isBusy = entry.kind === "busy";
      const block = element("div","agenda-block " + (isBusy ? "agenda-busy" : "agenda-free"));
      const verified = !state.connection.connected || (coverage && coverage.start <= entry.start && entry.end <= coverage.end);
      const title = isBusy ? "Calendar busy" : verified ? "Unallocated work time" : "Availability unconfirmed";
      block.append(element("span","slot-title",title),element("span","slot-detail","Until " + displayTime(entry.end) + " · " + duration(entry.end - entry.start)));
      row.append(block);
    }
    return row;
  });
  id("agenda").replaceChildren(...rows);
}

export function renderBacklog(state) {
  const tasks = ordered(state.tasks.filter((task) => task.pendingEstimate || !task.start));
  id("backlog-count").textContent = String(tasks.length);
  if (tasks.length) {
    const list = element("div","tray-list");
    list.append(...tasks.map((task) => taskRow(task,state)));
    id("backlog-content").replaceChildren(list);
  } else {
    id("backlog-content").replaceChildren(element("p","empty-tray","Tasks waiting for a slot will appear here."));
  }
}
