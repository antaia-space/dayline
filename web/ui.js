const svgNamespace = "http://www.w3.org/2000/svg";
const paths = {
  week: ["M3.5 7.5h17M7 3.5v4m10-4v4M5.5 5.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z", "M9.3 11.2v6.1m5.4-6.1v6.1"],
  agenda: ["M6 4v16M10.5 6h9m-9 6h6m-6 6h8M4.5 6h3m-3 6h3m-3 6h3"],
  device: ["M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v10.5h-17V6A1.5 1.5 0 0 1 5 4.5Zm-3 14h20"],
  link: ["M10.2 13.8a4 4 0 0 0 5.7 0l3.3-3.3a4 4 0 0 0-5.7-5.7l-1.2 1.2", "M13.8 10.2a4 4 0 0 0-5.7 0l-3.3 3.3a4 4 0 0 0 5.7 5.7l1.2-1.2"],
  cloud: ["M7 17.5h10.2a4.3 4.3 0 0 0 .5-8.5A6.2 6.2 0 0 0 6 8.3a4.7 4.7 0 0 0 1 9.2Z"],
  settings: ["m10 3-.5 2.1-1.7.9-2-.6-1.9 3.2 1.5 1.5-.1 2-1.5 1.5 1.9 3.3 2.1-.6 1.7 1 .5 2H14l.5-2.1 1.7-.9 2 .5 1.9-3.2-1.5-1.5v-2l1.5-1.5-1.9-3.2-2.1.5-1.7-.9L14 3Z", "M15 11.7a3 3 0 1 1-6 0 3 3 0 1 1 6 0Z"],
  left: ["m14.6 5.5-6.5 6.5 6.5 6.5"], right: ["m9.4 5.5 6.5 6.5-6.5 6.5"],
  down: ["m5.5 9.4 6.5 6.5 6.5-6.5"], x: ["m6 6 12 12M18 6 6 18"],
  plus: ["M12 5v14M5 12h14"], check: ["m4.5 12.5 4.6 4.5L19.5 6.7"],
  pencil: ["m4 20 4.6-1.1L19 8.5a1.6 1.6 0 0 0 0-2.3l-1.2-1.3a1.7 1.7 0 0 0-2.4 0L5.1 15.4 4 20Zm9.8-13.4 3.6 3.6M3.8 21.1h16.6"],
  tray: ["m3.3 13.3 3-7.2h11.4l3 7.2v5.2H3.3v-5.2Zm0 0h5l1.5 2.2h4.4l1.5-2.2h5"],
  clock: ["M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 1 1 17 0Z", "M12 7v5.4l3.5 2"],
  sync: ["M19.2 9a7.3 7.3 0 0 0-12-2.3L4.5 9.5M4.5 5v4.5H9M4.8 15a7.3 7.3 0 0 0 12 2.3l2.7-2.8M19.5 19v-4.5H15"],
  info: ["M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 1 1 17 0Z", "M12 11v5m0-8v.1"],
  file: ["M6.2 3.5h7.6l4.2 4.2v12.8H6.2V3.5Zm7.3.3v4.5H18M9 13h6m-6 3h6"]
};

export function icon(name) {
  const result = document.createElementNS(svgNamespace, "svg");
  for (const [key, value] of Object.entries({viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", "stroke-width":"1.65", "stroke-linecap":"round", "stroke-linejoin":"round", "aria-hidden":"true", focusable:"false", class:"icon"})) result.setAttribute(key,value);
  for (const d of paths[name] || []) {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d",d);
    result.append(path);
  }
  return result;
}

export function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

export function button(className, action, label, text) {
  const result = element("button",className,text);
  result.type = "button";
  result.dataset.action = action;
  result.setAttribute("aria-label", label);
  return result;
}

const formatters = new Map();
function formatter(options,locale) {
  const key = JSON.stringify([locale,options]);
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(locale,options));
  return formatters.get(key);
}
export const weekdayNames = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
export const dateValue = (day) => new Date(day + "T12:00:00Z");
export const dayIndex = (day) => (dateValue(day).getUTCDay() || 7);
export function addDays(day, count) {
  const date = dateValue(day);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0,10);
}
export const startOfWeek = (day) => addDays(day, 1 - dayIndex(day));
export const formatDay = (day, options) => formatter({...options, timeZone:"UTC"}).format(dateValue(day));
const relativePeriod = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function navigationLabel(selectedDay, today, view) {
  const weekly = view === "week";
  const start = dateValue(weekly ? startOfWeek(today) : today);
  const end = dateValue(weekly ? startOfWeek(selectedDay) : selectedDay);
  // These are calendar dates in the planner's zone, represented at UTC noon.
  const days = (end - start) / 86400000;
  const text = weekly ? relativePeriod.format(days / 7, "week") : relativePeriod.format(days, "day");
  return text[0].toUpperCase() + text.slice(1);
}

export function isoWeek(day) {
  const thursday = dateValue(addDays(day, 4 - dayIndex(day)));
  const first = Date.UTC(thursday.getUTCFullYear(), 0, 1, 12);
  return Math.ceil(((thursday.getTime() - first) / 86400000 + 1) / 7);
}

export function zonedDay(instant, zone) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = formatter({timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"},"en-US-u-ca-gregory-nu-latn").formatToParts(date);
  const values = Object.fromEntries(parts.map(({type,value}) => [type,value]));
  return values.year + "-" + values.month + "-" + values.day;
}

export const weekLabel = (monday) => {
  const sunday = addDays(monday,6);
  const sameMonth = monday.slice(0,7) === sunday.slice(0,7);
  const sameYear = monday.slice(0,4) === sunday.slice(0,4);
  return formatDay(monday, {month:"long",day:"numeric",...(!sameYear ? {year:"numeric"} : {})}) + "–" + formatDay(sunday, sameMonth ? {day:"numeric"} : {month:"short",day:"numeric",...(!sameYear ? {year:"numeric"} : {})});
};

function clockFormatter(timeZone, seconds = false) {
  return formatter({timeZone,hour:"2-digit",minute:"2-digit",...(seconds ? {second:"2-digit"} : {}),hourCycle:"h23"},"en-GB-u-nu-latn");
}
export const instantTime = (instant, timeZone) => clockFormatter(timeZone).format(new Date(instant));
export function instantDateTime(instant, timeZone, {seconds = false} = {}) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return "";
  return formatter({timeZone,dateStyle:"medium"}).format(date) + ", " + clockFormatter(timeZone,seconds).format(date);
}
export const duration = (value) => {
  const minutes = Math.max(0, Math.round(Number(value) || 0));
  if (minutes < 60) return minutes + "m";
  return Math.floor(minutes / 60) + "h" + (minutes % 60 ? " " + minutes % 60 + "m" : "");
};
export function displayTime(minutes) {
  const date = new Date(Date.UTC(2024,0,1,0,Math.max(0,Math.round(minutes)) || 0));
  return instantTime(date,"UTC");
}
export const hhmmMinutes = (time) => {
  const [h, m] = time.split(":").map(Number);
  return 60 * h + m;
};
export function instantMinutes(instant, timeZone) {
  return hhmmMinutes(instantTime(instant,timeZone));
}
export function categoryColor(color) {
  return /^#[\da-f]{6}$/i.test(color || "") ? color : "#76816f";
}
export function workdaysLabel(workDays) {
  const work = new Set(workDays);
  const runs = [];
  for (let i = 1; i <= 7; i++) {
    if (!work.has(i)) continue;
    const begin = i;
    while (i < 7 && work.has(i + 1)) i++;
    const first = weekdayNames[begin-1].slice(0,3);
    runs.push(begin === i ? first : first + "–" + weekdayNames[i-1].slice(0,3));
  }
  return runs.join(", ") || "No working days";
}
