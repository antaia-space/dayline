import { addDays, dayIndex, element, hhmmMinutes, instantMinutes, instantTime, zonedDay } from "./ui.js";

const minute = 60000;
const entries = new WeakMap();
const limit = (value,low,high) => Math.max(low,Math.min(high,value));

// Retain a reference to the rendered interval, separately from its content.
// An all-day banner or an old move can separate rows, but cannot be active.
export function timelineBlock(node,entry) {
  const item = entry.task || entry.meeting;
  let kind = entry.kind;
  if (item?.allDay || (kind === "busy" && entry.start === 0 && entry.end === 1440)) kind = "banner";
  else if (entry.task) kind = entry.task.done ? "finished" : "task";
  node.dataset.clockBlock = kind;
  entries.set(node,entry);
  return node;
}

const dayBounds = new Map();
function midnight(day,zone) {
  const key = zone + "/" + day;
  if (dayBounds.has(key)) return dayBounds.get(key);
  // Local midnight can have a different UTC offset from noon on the same day.
  const pivot = Date.parse(day+"T00:00:00Z")/minute;
  let low = pivot - 1500, high = pivot + 1500;
  while (low < high) {
    const mid = Math.floor((low+high)/2);
    if (zonedDay(mid*minute,zone) < day) low = mid+1;
    else high = mid;
  }
  if (dayBounds.size > 12) dayBounds.clear();
  dayBounds.set(key,low*minute);
  return low*minute;
}

function geometry(node,now,day,zone,wall) {
  const entry = entries.get(node), kind = node.dataset.clockBlock;
  const rect = node.getBoundingClientRect();
  if (!entry || !rect.height || !rect.width) return null;
  const item = entry.task || entry.meeting || (entry.zone === zone && entry.move);
  let from = entry.start-wall, to = entry.end-wall, tracks;
  if (kind === "overlap" || (item?.start && item.end && kind !== "banner")) {
    const first = midnight(day,zone), last = midnight(addDays(day,1),zone);
    if (kind === "overlap") {
      const times = [...new Set(entry.cells.flatMap(cell => [limit(cell.from,first,last),limit(cell.to,first,last)]))].sort((a,b) => a-b);
      from = (times[0]-now)/minute; to = (times.at(-1)-now)/minute;
      // Use actual grid track heights, including wrapped titles. This aligns
      // the line with the start of each staggered meeting in every column.
      const heights = getComputedStyle(node).gridTemplateRows.trim().split(/\s+/).map(value => /^\d+(?:\.\d+)?px$/.test(value) ? parseFloat(value) : NaN);
      if (heights.length === times.length-1 && heights.every(Number.isFinite)) {
        const gap = parseFloat(getComputedStyle(node).rowGap) || 0;
        let position = rect.top;
        tracks = heights.map((height,i) => {
          const part = {from:(times[i]-now)/minute,to:(times[i+1]-now)/minute,top:position,bottom:position+height};
          position += height+gap; return part;
        });
      }
    } else {
      from = (Math.max(first,Date.parse(item.start))-now)/minute;
      to = (Math.min(last,Date.parse(item.end))-now)/minute;
    }
  }
  return {node,kind,from,to,top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,tracks,task:entry.task};
}

const rank = {task:0,overlap:1,meeting:1,busy:2,available:3,elapsed:3};
const fraction = range => limit(-range.from/(range.to-range.from),0,1);

export function currentPosition(rows,insideHours) {
  const active = rows.filter(r => Object.hasOwn(rank,r.kind) && r.from <= 0 && r.to > 0)
    .sort((a,b) => rank[a.kind]-rank[b.kind] || b.from-a.from || a.to-b.to)[0];
  if (active) {
    const segment = active.tracks?.find(part => part.from <= 0 && part.to > 0) || active;
    return {y:segment.top + fraction(segment)*(segment.bottom-segment.top),anchor:active,active};
  }
  // The week is a compact list. Within a gap, stay between its cards. A
  // free-time row in Day supplies a true proportional position instead.
  if (!insideHours) return null;
  const timed = rows.filter(r => r.kind !== "banner");
  const before = timed.filter(r => r.to <= 0).sort((a,b) => b.to-a.to || b.bottom-a.bottom)[0];
  const after = timed.filter(r => r.from > 0).sort((a,b) => a.from-b.from || a.top-b.top)[0];
  if (before && after) {
    const space = Math.max(0,after.top-before.bottom);
    return {y:before.bottom + space*(-before.to/(after.from-before.to)),anchor:after};
  }
  if (before) return {y:before.bottom+1,anchor:before};
  if (after) return {y:after.top-1,anchor:after};
  return {y:rows.length ? Math.max(...rows.map(row => row.bottom))+3 : null};
}

export function minuteTicker(draw,{now=()=>Date.now(),schedule=setTimeout,cancel=clearTimeout,visible=()=>!document.hidden}={}) {
  let offset = 0, timer, paired = false;
  const current = () => now()+offset;
  function wake() {
    cancel(timer); timer=undefined;
    if (!paired || !visible()) return;
    draw(current());
    timer = schedule(wake,minute-((current()%minute+minute)%minute));
  }
  return {current,wake,sync(value) {
    const stamp = new Date(value).getTime();
    offset = Number.isFinite(stamp) ? stamp-now() : 0; paired=true; wake();
  },stop() { paired=false; cancel(timer); timer=undefined; }};
}

export function createCurrentTime({root,getSettings}) {
  const line=element("div","current-time-line"), dot=element("span","current-time-dot"), label=element("time","current-time-label");
  line.setAttribute("role","img"); dot.setAttribute("aria-hidden","true"); label.setAttribute("aria-hidden","true");
  line.append(dot,label);
  let active=null, observed=null, frame=0, inFreeTime=false;
  const repaint=()=>{ if (!frame) frame=requestAnimationFrame(()=>{frame=0;draw(ticker.current());}); };
  const observer=new ResizeObserver(repaint);
  function highlight(node) {
    if (active === node) return;
    if (active) { active.classList.remove("is-current-task"); active.removeAttribute("aria-current"); }
    active=node;
    if (active) { active.classList.add("is-current-task"); active.setAttribute("aria-current","time"); }
  }
  function draw(now) {
    inFreeTime=false;
    const settings=getSettings();
    if (!settings) return;
    const zone=settings.timeZone, day=zonedDay(now,zone), region=root.querySelector('[data-clock-day="'+day+'"]');
    if (observed!==region) {
      observer.disconnect(); observed=region;
      if (region) {
        observer.observe(region);
        for (const block of region.querySelectorAll("[data-clock-block]")) observer.observe(block);
      }
    }
    if (!region || !region.getClientRects().length) { line.remove(); highlight(null); return; }
    const wall=instantMinutes(now,zone), hours=settings.workDays.includes(dayIndex(day)) && wall>=hhmmMinutes(settings.startTime) && wall<hhmmMinutes(settings.endTime);
    const rows=[...region.querySelectorAll("[data-clock-block]")].map(node=>geometry(node,now,day,zone,wall)).filter(Boolean);
    inFreeTime=region.id === "agenda" && rows.some(r => (r.kind === "available" || r.kind === "elapsed") && r.from<=0 && r.to>0);
    const position=currentPosition(rows,hours);
    if (!position) { line.remove(); highlight(null); return; }
    const rect=region.getBoundingClientRect(), slot=position.active, task=slot?.kind === "task" && slot.task;
    highlight(task ? slot.node : null);
    const time=instantTime(now,zone);
    line.dataset.day=day;
    line.dataset.currentTime=String(Math.floor(wall/60)).padStart(2,"0")+":"+String(wall%60).padStart(2,"0");
    if (task) line.dataset.currentTask=task.id; else delete line.dataset.currentTask;
    line.setAttribute("aria-label","Current time " + time + (task ? ". Scheduled task, " + (task.title || task.text) : ""));
    label.textContent=time; label.dateTime=new Date(now).toISOString();
    line.style.top=limit((position.y ?? rect.top+9)-rect.top,1,Math.max(1,rect.height-1))+"px";
    const anchor=position.anchor;
    if (anchor && anchor.kind!=="banner") {
      line.style.left=Math.max(4,anchor.left-rect.left)+"px";
      line.style.right=Math.max(2,rect.right-anchor.right)+"px";
    } else { line.style.removeProperty("left"); line.style.removeProperty("right"); }
    if (line.parentElement!==region) region.append(line);
  }
  const ticker=minuteTicker(draw);
  function rendered() { observer.disconnect(); observed=null; draw(ticker.current()); }
  window.addEventListener("pageshow",ticker.wake);
  window.addEventListener("focus",ticker.wake);
  window.addEventListener("resize",repaint);
  document.addEventListener("visibilitychange",ticker.wake);
  for (const type of ["toggle","dragstart","dragend"]) root.addEventListener(type,repaint,true);
  return {sync:ticker.sync,rendered,get inFreeTime() { return inFreeTime; }};
}
