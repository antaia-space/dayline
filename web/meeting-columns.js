import { displayTime, element } from "./ui.js";
import { meetingCard } from "./meetings.js";

// On a small screen a dense group scrolls independently. Keep the visible
// columns through live calendar updates, even if one of its meetings moved.
export function retainMeetingScroll(root) {
  const offsets = new Map();
  for (const grid of root.querySelectorAll(".meeting-overlap")) {
    if (!grid.scrollLeft) continue;
    for (const title of grid.querySelectorAll(".meeting-title")) offsets.set(title.dataset.focus,grid.scrollLeft);
  }
  return () => {
    if (!offsets.size) return;
    for (const grid of root.querySelectorAll(".meeting-overlap")) {
      const retained = [...grid.querySelectorAll(".meeting-title")].find(title => offsets.has(title.dataset.focus));
      if (retained) grid.scrollLeft = offsets.get(retained.dataset.focus);
    }
  };
}

// Each connected set of overlapping meetings shares a grid. An end time is
// exclusive, so a meeting can reuse a column the moment its predecessor ends.
export function groupOverlappingMeetings(entries) {
  const result = [], timed = [];
  for (const entry of entries) {
    if (!entry.meeting || entry.meeting.allDay) {
      result.push(entry);
      continue;
    }
    // Use instants within the day so two occurrences of 1 am on a clock-change
    // day remain distinct. Overnight meetings share the visible day boundaries.
    const from = entry.start === 0 ? -Infinity : Date.parse(entry.meeting.start);
    const to = entry.end === 1440 ? Infinity : Date.parse(entry.meeting.end);
    timed.push({entry,from,to});
  }
  timed.sort((a,b) => a.from-b.from || b.to-a.to || a.entry.meeting.id.localeCompare(b.entry.meeting.id));
  let cells = [], columnEnds = [], latestEnd = -Infinity;
  function finish() {
    if (cells.length === 1) result.push(cells[0].entry);
    else if (cells.length) result.push({
      kind:"overlap",start:cells[0].entry.start,end:cells.find(cell => cell.to === latestEnd).entry.end,
      columns:columnEnds.length,cells
    });
    cells = []; columnEnds = []; latestEnd = -Infinity;
  }
  for (const cell of timed) {
    if (cell.from >= latestEnd && cells.length) finish();
    const free = columnEnds.findIndex(end => end <= cell.from);
    cell.column = free === -1 ? columnEnds.length : free;
    columnEnds[cell.column] = cell.to;
    latestEnd = Math.max(latestEnd,cell.to);
    cells.push(cell);
  }
  finish();
  return result;
}

export function meetingColumns(group,day,blockSize) {
  const agenda = Boolean(blockSize);
  const grid = element("div","meeting-overlap");
  if (group.columns > 2) grid.classList.add("dense-meetings");
  grid.setAttribute("role","group");
  grid.setAttribute("aria-label","Overlapping meetings, " + displayTime(group.start) + "–" + displayTime(group.end));
  grid.style.setProperty("--meeting-columns",String(group.columns));
  const clocks = new Map();
  for (const {entry,from,to} of group.cells) {
    clocks.set(from,entry.start);
    clocks.set(to,entry.end);
  }
  const times = [...clocks.keys()].sort((a,b) => a-b);
  const lines = new Map(times.map((time,i) => [time,i+1]));
  // A grid line represents each distinct boundary, including staggered starts.
  // Track minima show their order. Content can grow when a title wraps.
  grid.style.gridTemplateRows = times.slice(1).map((end,i) => {
    const start = times[i];
    const minutes = Number.isFinite(end-start) ? (end-start)/60000 : clocks.get(end)-clocks.get(start);
    const height = Math.min(agenda ? 3.9 : 2,Math.max(.35,minutes*(agenda ? .065 : .033)));
    return "minmax(" + height.toFixed(3) + "rem,auto)";
  }).join(" ");
  const differentStarts = group.cells.some(cell => cell.from !== group.cells[0].from);
  for (const {entry,from,to,column} of group.cells) {
    const card = meetingCard(entry,day,agenda,differentStarts);
    card.style.gridColumn = String(column+1);
    card.style.gridRow = lines.get(from) + " / " + lines.get(to);
    if (agenda) {
      const {minimumRem,compact} = blockSize(entry);
      card.style.setProperty("--agenda-block-height",minimumRem + "rem");
      if (compact) card.classList.add("short-meeting");
    }
    grid.append(card);
  }
  return grid;
}
