import { addDays, button, displayTime, element, formatDay, icon, instantMinutes, instantTime, zonedDay } from "./ui.js";

const empty = () => ({events:[],warnings:[]});

// Meeting titles, guests and links live only in this window and are dropped
// immediately when the week, enabled calendars or account permissions change.
export function createMeetingFeed({read,changed,now = Date.now}) {
  let key = null, data = empty(), pending = false, generation = 0, loaded = 0, stamp = "";
  function update(state,monday,force = false) {
    const accounts = state.connection.accounts || [];
    const authorized = state.connection.connected && accounts.some(account => account.meetingDetails);
    const next = authorized ? JSON.stringify([monday,state.settings.timeZone,state.settings.calendarMode,
      accounts.map(a => [a.sub,a.mode,Boolean(a.meetingDetails)]),state.settings.excludedCalendarIds]) : "";
    const sync = state.connection.lastSync ?? "";
    if (next !== key) {
      key = next; data = empty(); pending = false; generation++; loaded = 0; stamp = "";
    }
    if (!authorized || (!force && (pending || (loaded && stamp === sync && now() - loaded < 60000)))) return data;
    const request = ++generation;
    pending = true;
    stamp = sync;
    read("/api/meetings?from=" + monday + "&to=" + addDays(monday,7)).then(result => {
      if (request !== generation) return;
      data = {events:Array.isArray(result.events) ? result.events : [],warnings:Array.isArray(result.warnings) ? result.warnings : []};
    }).catch(error => {
      if (request === generation) data = {events:[],warnings:[error.message || "Meeting details are unavailable."]};
    }).finally(() => {
      if (request !== generation) return;
      pending = false; loaded = now(); changed();
    });
    return data;
  }
  return {update,get current() { return data; }};
}

export function rangeOnDay(item,day,zone) {
  if (item?.allDay && item.startDate && item.endDate) {
    return item.startDate <= day && day < item.endDate ? {start:0,end:1440} : null;
  }
  if (!item?.start || !item?.end) return null;
  const first = zonedDay(item.start,zone), last = zonedDay(item.end,zone);
  if (!first || !last || first > day || last < day) return null;
  const start = first < day ? 0 : instantMinutes(item.start,zone);
  const end = last > day ? 1440 : instantMinutes(item.end,zone);
  return end > start ? {start,end} : null;
}

export function safeMeetingLink(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export const nonblockingMeeting = event => Boolean(event.transparent || event.attendees?.some(guest => guest.self && guest.response === "declined"));

function linkTo(value,label,className,accessible) {
  const href = safeMeetingLink(value);
  if (!href) return null;
  const a = element("a",className,label);
  a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
  if (accessible) a.setAttribute("aria-label",accessible);
  return a;
}

export function meetingCard(entry,day,agenda) {
  const event = entry.meeting;
  const name = event.title || "Calendar busy";
  const row = element("div",agenda ? "agenda-block meeting-card agenda-meeting" : "meeting-card week-meeting");
  if (nonblockingMeeting(event)) row.classList.add("meeting-free");
  const title = button("meeting-title","meeting-details","Meeting details for " + name,name);
  title.dataset.id = event.id;
  title.dataset.focus = (agenda ? "agenda-" : "week-") + day + "-meeting-" + event.id;
  title.setAttribute("aria-haspopup","dialog"); title.setAttribute("aria-expanded","false");
  title.setAttribute("aria-controls","meeting-popover");
  const meta = element("div","meeting-meta");
  const time = event.allDay ? "All day" : (agenda ? "Until " + displayTime(entry.end) : displayTime(entry.start) + "–" + displayTime(entry.end));
  meta.append(element("span","",time + (nonblockingMeeting(event) ? " · Free" : "")));
  const join = linkTo(event.joinUrl,"Join","meeting-join","Join " + name);
  if (join) { join.dataset.focus = title.dataset.focus + "-join"; meta.append(join); }
  row.append(title,meta);
  return row;
}

const responseLabels = {accepted:"Accepted",declined:"Declined",tentative:"Tentative",needsAction:"Awaiting reply"};
const personName = person => person?.name || person?.email || "";
const dateName = day => formatDay(day,{weekday:"short",month:"short",day:"numeric",year:"numeric"});
function meetingDate(event,zone) {
  const first = event.allDay && event.startDate || zonedDay(event.start,zone);
  const last = event.allDay && event.endDate ? addDays(event.endDate,-1) : zonedDay(event.end,zone);
  if (event.allDay) return (first === last ? dateName(first) : dateName(first) + " – " + dateName(last)) + " · All day";
  if (first === last) return dateName(first) + " · " + instantTime(event.start,zone) + "–" + instantTime(event.end,zone);
  return dateName(first) + " · " + instantTime(event.start,zone) + " – " + dateName(last) + " · " + instantTime(event.end,zone);
}

function guestList(event) {
  const section = element("section","meeting-guests");
  const guests = (event.attendees || []).filter(person => personName(person));
  if (!guests.length && !event.attendeesOmitted) return null;
  section.append(element("h3","","Guests"));
  if (guests.length) {
    const list = element("ul");
    for (const guest of guests) {
      const row = element("li"), who = element("div","guest-person");
      const marks = [guest.self && "you",guest.organizer && "organizer",guest.optional && "optional"].filter(Boolean);
      who.append(element("span","",personName(guest) + (marks.length ? " (" + marks.join(", ") + ")" : "")));
      if (guest.email && guest.name && guest.email !== guest.name) who.append(element("small","",guest.email));
      row.append(who);
      if (responseLabels[guest.response]) row.append(element("span","guest-response",responseLabels[guest.response]));
      list.append(row);
    }
    section.append(list);
  }
  if (event.attendeesOmitted) section.append(element("p","hint","Google has shared a partial guest list."));
  return section;
}

// One nonmodal, anchored panel serves pointer previews, keyboard focus and touch.
// Clicking the title keeps it open while its links or guest list are explored.
export function createMeetingDetails({root,find,zone}) {
  const panel = element("div","meeting-popover");
  panel.id = "meeting-popover"; panel.setAttribute("popover","manual");
  panel.setAttribute("role","dialog"); panel.setAttribute("aria-labelledby","meeting-popover-title");
  panel.hidden = true; document.body.append(panel);
  let anchor = null, pinned = false, timer, suppressed = null, signature = "";
  function trigger(node) {
    if (!(node instanceof Element) || node.closest("a")) return null;
    return node.closest(".meeting-card")?.querySelector('button[data-action="meeting-details"]');
  }
  function close(restore = false) {
    clearTimeout(timer);
    if (!anchor) return;
    const previous = anchor;
    anchor = null; pinned = false; signature = "";
    previous.setAttribute("aria-expanded","false");
    if (panel.matches(":popover-open")) panel.hidePopover();
    panel.hidden = true; panel.replaceChildren();
    if (restore && previous.isConnected) {
      suppressed = previous;
      previous.focus({preventScroll:true});
      queueMicrotask(() => { suppressed = null; });
    }
  }
  function position() {
    if (!anchor || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect(), margin = 8;
    const height = panel.offsetHeight, width = panel.offsetWidth;
    const below = rect.bottom + margin;
    const top = below + height <= innerHeight - margin ? below : Math.max(margin,rect.top - height - margin);
    panel.style.top = Math.min(top,Math.max(margin,innerHeight - height - margin)) + "px";
    panel.style.left = Math.min(Math.max(margin,rect.left),Math.max(margin,innerWidth - width - margin)) + "px";
  }
  function paint(event) {
    const next = JSON.stringify([event,zone()]);
    if (signature === next) return;
    signature = next;
    const closeButton = button("icon-button","close-meeting","Close meeting details");
    closeButton.append(icon("x")); closeButton.addEventListener("click",() => close(true));
    const heading = element("div","meeting-heading"), identity = element("div");
    if (event.calendarName) identity.append(element("p","meeting-source",event.calendarName));
    const title = element("h2","",event.title || "Calendar busy"); title.id = "meeting-popover-title";
    identity.append(title); heading.append(identity,closeButton);
    const content = [heading,element("p","meeting-when",meetingDate(event,zone()))];
    const fields = element("dl","meeting-fields");
    function field(label,value) { if (value) fields.append(element("dt","",label),element("dd","",value)); }
    field("Where",event.location);
    const host = event.organizer;
    field("Organizer",host?.name && host.email && host.name !== host.email ? host.name + " · " + host.email : personName(host));
    if (nonblockingMeeting(event)) field("Availability","Shown as free");
    if (event.visibility === "private") field("Visibility","Private");
    if (fields.children.length) content.push(fields);
    const links = element("div","meeting-actions");
    const join = linkTo(event.joinUrl,"Join meeting","primary");
    const open = linkTo(event.calendarUrl,"Open in Calendar","meeting-calendar-link");
    if (join) links.append(join);
    if (open) links.append(open);
    if (links.children.length) content.push(links);
    const guests = guestList(event);
    if (guests) content.push(guests);
    panel.replaceChildren(...content);
  }
  function show(target,stick = false) {
    const event = target && find(target.dataset.id);
    if (!event || !target.isConnected || (pinned && anchor !== target && !stick)) return;
    clearTimeout(timer);
    if (anchor !== target) { close(); anchor = target; }
    pinned ||= stick; anchor.setAttribute("aria-expanded","true"); paint(event);
    panel.hidden = false;
    if (!panel.matches(":popover-open")) panel.showPopover();
    position();
    if (stick) panel.querySelector("button")?.focus({preventScroll:true});
  }
  function delayClose() { if (!pinned) { clearTimeout(timer); timer = setTimeout(() => close(),180); } }
  root.addEventListener("pointerover",event => {
    const target = trigger(event.target);
    if (!target || trigger(event.relatedTarget) === target || event.pointerType === "touch" || pinned) return;
    clearTimeout(timer); timer = setTimeout(() => show(target),180);
  });
  root.addEventListener("pointerout",event => {
    const target = trigger(event.target);
    if (target && trigger(event.relatedTarget) !== target && !panel.contains(event.relatedTarget)) delayClose();
  });
  root.addEventListener("focusin",event => {
    const target = trigger(event.target);
    if (target && target !== suppressed && !pinned) show(target);
  });
  root.addEventListener("focusout",event => {
    if (trigger(event.target) && !panel.contains(event.relatedTarget)) delayClose();
  });
  root.addEventListener("click",event => {
    const target = trigger(event.target);
    if (target) show(target,true);
  });
  panel.addEventListener("pointerenter",() => clearTimeout(timer));
  panel.addEventListener("pointerleave",delayClose);
  panel.addEventListener("focusout",event => {
    if (!panel.contains(event.relatedTarget) && !trigger(event.relatedTarget)) close();
  });
  document.addEventListener("pointerdown",event => {
    if (anchor && !panel.contains(event.target) && !trigger(event.target)) close();
  });
  document.addEventListener("keydown",event => {
    if (anchor && event.key === "Escape") { event.preventDefault(); close(pinned || panel.contains(document.activeElement)); }
  });
  window.addEventListener("resize",position);
  window.addEventListener("scroll",position,true);
  function sync() {
    if (!anchor) return;
    const target = root.querySelector('[data-focus="' + CSS.escape(anchor.dataset.focus) + '"]');
    const event = target && target.getClientRects().length && find(target.dataset.id);
    if (!event) return close();
    anchor = target; target.setAttribute("aria-expanded","true"); paint(event); position();
  }
  return {sync,close};
}
