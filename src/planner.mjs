import { DateTime } from 'luxon';

export const CATEGORIES = Object.freeze([
  { id: 'focus', name: 'Focus', color: '#4c68a0', googleColorId: '9' },
  { id: 'writing', name: 'Writing', color: '#846099', googleColorId: '3' },
  { id: 'people', name: 'People', color: '#397f72', googleColorId: '2' },
  { id: 'admin', name: 'Admin', color: '#b26835', googleColorId: '6' },
  { id: 'personal', name: 'Personal', color: '#ad5779', googleColorId: '4' },
]);

// Prefer the action that appears first. A specific phrase such as “draft an
// email” takes precedence over the generic “draft” at that same position.
const taskKinds = [
  ['people', 15, 'correspondence', /\b(?:(?:draft|write|send|answer|check|compose|return)\s+(?:(?:a|an|the|my|some|quick|short)\s+)*(?:e-?mails?|messages?|repl(?:y|ies))|e-?mail|message|slack|reply|respond|follow[ -]?up|reach out)\b/i],
  ['people', 60, 'a working session', /\b(?:workshop|interview|brainstorm|retrospective|kick[ -]?off)\b/i],
  ['people', 30, 'a conversation', /\b(?:meet(?:ing)?|call|1[: -]1|1[: -]on[: -]1|one.on.one|stand[ -]?up|catch[ -]?up|check[ -]?in|discuss|sync(?: up)?|touch base)\b/i],
  ['personal', 45, 'a personal appointment or errand', /\b(?:grocery|groceries|dentist|doctor|gym|workout|yoga|school pickup|pick up (?:the )?(?:kids|prescription)|go for a (?:run|walk)|personal|errands?|haircut|pay (?:the )?rent)\b/i],
  ['admin', 25, 'administrative work', /\b(?:(?:review|process|send|file|submit|pay|approve|reconcile|organize|organise)\s+(?:(?:a|an|the|my|all|our|outstanding|monthly|expense|travel)\s+)*(?:invoices?|expenses?|forms?|receipts?|bills?|reports?)|invoic(?:e|es|ing)|expenses?|receipts?|bookkeep(?:ing)?|timesheets?|budget|paperwork|payroll|reimburse(?:ment)?|book (?:a |the )?(?:flight|trip|hotel|room)|renew|archive|schedule|appointment booking)\b/i],
  ['writing', 60, 'drafting or editing', /\b(?:writ(?:e|ing)|draft|edit|proofread|outline|document(?:ation)?|author|prepare (?:a |the )?(?:deck|slides|presentation|report)|proposal|briefing|slides?|presentation|blog post|article|newsletter|copywriting)\b/i],
  ['focus', 90, 'building or investigating', /\b(?:research|design|architect|implement|develop|build|debug|prototype|code|analy[sz]e|investigate|refactor|map out)\b/i],
  ['focus', 45, 'focused work', /\b(?:review|read|study|test|fix|plan|evaluate|compare|organize|organise|prepare|update)\b/i],
];
const generalTask = ['focus', 30, 'a general task'];
const smallNumbers = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ones = 'one|two|three|four|five|six|seven|eight|nine';
const numberPattern = '(?:\\d+(?:\\.\\d+)?|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:' + ones + '))?|' + Object.keys(smallNumbers).join('|') + ')';

function numberFrom(text) {
  if (/^\d/.test(text)) return Number(text);
  return text.split(/[- ]/).reduce((total, part) => total + smallNumbers[part], 0);
}

function durationInText(source) {
  const normalized = source.toLowerCase()
    .replace(/(\d)\s*½/g, '$1.5').replace(/½/g, '0.5')
    .replace(/three[- ]quarters?(?: of)? (?:an? )?hour/g, '45 minutes')
    .replace(/\b(?:a )?quarter(?: of)?[- ](?:an? )?hour\b/g, '15 minutes')
    .replace(/\bhalf[- ](?:an? )?hour\b/g, '30 minutes')
    .replace(new RegExp('\\b(' + numberPattern + ') (?:and a half hours?|hours? and a half)\\b', 'g'), (_, n) => (numberFrom(n) + 0.5) + ' hours')
    .replace(/(\d)\s*(?:h|hr|hrs)(?=\d)/g, '$1 hours ');
  const durations = new RegExp('\\b(' + numberPattern + ')(?:(?<=[0-9])[\\s-]*|[\\s-]+)(hours?|hrs?|h|minutes?|mins?|m)\\b', 'g');
  let previousEnd = null;
  let total = 0;
  for (const match of normalized.matchAll(durations)) {
    if (previousEnd !== null && !/^\s*(?:,?\s*(?:and\s*)?)?$/.test(normalized.slice(previousEnd, match.index))) break;
    total += numberFrom(match[1]) * (/^h/.test(match[2]) ? 60 : 1);
    previousEnd = match.index + match[0].length;
  }
  return previousEnd === null ? null : Math.ceil(total);
}

function workEstimate(text) {
  let kind = generalTask;
  let firstAction = Infinity;
  for (const candidate of taskKinds) {
    const match = candidate[3].exec(text);
    if (match && match.index < firstAction) {
      kind = candidate;
      firstAction = match.index;
    }
  }
  const [category, base, purpose] = kind;
  const explicit = durationInText(text);
  if (explicit !== null) {
    if (!Number.isSafeInteger(explicit) || explicit < 1) throw new RangeError('Enter a positive duration in minutes or hours.');
    return { category, minutes: explicit, explicitMinutes: true, reason: 'Your task specifies ' + explicit + (explicit === 1 ? ' minute.' : ' minutes.') };
  }

  const workload = text.match(/\b(\d{1,4})\s+(pages|slides|invoices|emails|calls|interviews)\b/i);
  const unitMinutes = { pages: 4, slides: 7, invoices: 8, emails: 8, calls: 25, interviews: 45 };
  let minutes = workload ? Math.max(base, Number(workload[1]) * unitMinutes[workload[2].toLowerCase()]) : base;
  let context = '';
  if (/\b(?:quick|briefly|short|simple|minor|skim)\b/i.test(text)) {
    minutes *= 0.6;
    context = ', allowing for a quick pass';
  } else if (/\b(?:thorough|comprehensive|detailed|full day|deep dive|in.depth|complex|extensive|from scratch)\b/i.test(text)) {
    minutes *= 1.5;
    context = ', allowing for the extra depth';
  }
  minutes = Math.max(5, Math.ceil(minutes / 5) * 5);
  if (workload) context += ' with ' + workload[0].toLowerCase();
  return { category, minutes, explicitMinutes: false, reason: 'Estimated ' + minutes + ' minutes for ' + purpose + context + '.' };
}

function instantInZone(value, zone) {
  if (value === undefined || value === null) return DateTime.now().setZone(zone);
  if (DateTime.isDateTime(value)) return value.setZone(zone);
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone });
  if (typeof value === 'number') return DateTime.fromMillis(value, { zone });
  return DateTime.fromISO(String(value), { zone });
}

const weekdayNames = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthsPattern = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const weekdaysPattern = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const dateWords = '\\b(?:day after tomorrow|tomorrow|today|tonight|end of (?:the )?day|eod|cob|(?:end of (?:the )?)?(?:this |next )?week(?:end)?|(?:next |this )?' + weekdaysPattern + '|\\d{4}-\\d{2}-\\d{2}|' + monthsPattern + '\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|(?:in|within) (' + numberPattern + ') (?:days?|weeks?))\\b';

function daySpan(phrase, today) {
  if (/^\d{4}-/.test(phrase)) {
    const date = DateTime.fromISO(phrase, { zone: today.zoneName });
    return [date, date];
  }
  const namedMonth = phrase.match(new RegExp('^(' + monthsPattern + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?$'));
  if (namedMonth) {
    const month = monthNames.indexOf(namedMonth[1].slice(0, 3)) + 1;
    const day = Number(namedMonth[2]);
    const year = namedMonth[3] ? Number(namedMonth[3]) : today.year + Number(month < today.month || month === today.month && day < today.day);
    const date = DateTime.fromObject({ year, month, day }, { zone: today.zoneName });
    return [date, date];
  }
  const relative = phrase.match(new RegExp('^(?:in|within) (' + numberPattern + ') (days?|weeks?)$'));
  if (relative) {
    const days = Math.round(numberFrom(relative[1]) * (relative[2].startsWith('week') ? 7 : 1));
    const date = today.plus({ days });
    return [date, date];
  }
  if (phrase.includes('week')) {
    const monday = today.startOf('week').plus({ weeks: phrase.includes('next') ? 1 : 0 });
    if (phrase.includes('weekend')) {
      const saturday = monday.plus({ days: 5 });
      return [saturday, saturday.plus({ days: 1 })];
    }
    return [monday, monday.plus({ days: phrase.includes('end of') ? 4 : 6 })];
  }
  const weekday = weekdayNames.indexOf(phrase.replace(/^(?:next|this) /, '').slice(0, 3)) + 1;
  if (weekday) {
    const date = phrase.startsWith('next ')
      ? today.startOf('week').plus({ days: 6 + weekday })
      : today.plus({ days: (weekday - today.weekday + 7) % 7 });
    return [date, date];
  }
  const days = phrase === 'day after tomorrow' ? 2 : phrase === 'tomorrow' ? 1 : 0;
  const date = today.plus({ days });
  return [date, date];
}

function dateConstraints(text, today) {
  let earliestDay = null;
  let latestDay = null;
  let deadlineTime = null;
  const consumedClocks = [];
  const precedingClock = new RegExp('\\b(?:by|due(?: by)?|before|no later than)\\s+(' + clockPattern + ')\\s+(?:on\\s+)?$', 'i');
  const followingClock = new RegExp('^\\s*,?\\s*(?:(?:at|by|before|until)\\s+(' + clockPattern + ')(?![\\w:-])|(morning|afternoon|evening)\\b)', 'i');
  for (const match of text.matchAll(new RegExp(dateWords, 'gi'))) {
    const phrase = match[0].toLowerCase();
    // Bare “week” in “a week of research” does not name a scheduling date.
    if (phrase === 'week') continue;
    const [first, last] = daySpan(phrase, today);
    if (!first.isValid || !last.isValid) throw new RangeError('Enter a valid calendar date for this task.');
    const before = text.slice(0, match.index).toLowerCase();
    const clockBefore = before.match(precedingClock);
    const since = /\b(?:from|starting(?: on)?|after|not before|no earlier than)\s*$/.test(before);
    const due = !since && (Boolean(clockBefore) || /\b(?:by|due(?:\s+(?:on|by))?|no later than|until|through|before)\s+(?:the\s+)?$/.test(before)
      || /^(?:within|end of|eod|cob)/.test(phrase) || (earliestDay && /\bto\s*$/.test(before)));
    if (!due) {
      const day = first.plus({ days: /\bafter\s*$/.test(before) ? 1 : 0 }).toISODate();
      if (!earliestDay || day > earliestDay) earliestDay = day;
    }
    if (since) continue;

    const end = match.index + match[0].length;
    const clockAfter = due ? text.slice(end).match(followingClock) : null;
    let cutoff = null;
    if (clockBefore) {
      cutoff = clockMinute(clockBefore[1]);
      consumedClocks.push([clockBefore.index, match.index]);
    }
    if (clockAfter) {
      const periodEnd = { morning: 720, afternoon: 1020, evening: 1440 };
      const time = clockAfter[1] ? clockMinute(clockAfter[1]) : periodEnd[clockAfter[2].toLowerCase()];
      cutoff = Math.min(cutoff ?? 1440, time);
      consumedClocks.push([end, end + clockAfter[0].length]);
    }
    const day = last.minus({ days: due && /\bbefore\s*$/.test(before) && !clockAfter ? 1 : 0 }).toISODate();
    if (!latestDay || day < latestDay) {
      latestDay = day;
      deadlineTime = cutoff === null ? null : clockString(cutoff);
    } else if (day === latestDay && cutoff !== null) {
      const candidate = clockString(cutoff);
      if (!deadlineTime || candidate < deadlineTime) deadlineTime = candidate;
    }
  }
  let flexibleText = text;
  for (const [from, to] of consumedClocks.sort((a, b) => b[0] - a[0])) {
    flexibleText = flexibleText.slice(0, from) + ' '.repeat(to - from) + flexibleText.slice(to);
  }
  return { earliestDay, latestDay, deadlineTime, flexibleText };
}

const clockPattern = '(?:noon|midnight|(?:[01]?\\d|2[0-3])(?:[.:][0-5]\\d)?\\s*(?:[ap]\\.?\\s*m\\.?)?)';
function clockMinute(clock, period) {
  const clean = clock.trim().toLowerCase().replace(/\s/g, '').replace(/^(\d{1,2})\.(\d{2})/, '$1:$2').replace(/\./g, '');
  if (clean === 'noon') return 720;
  if (clean === 'midnight') return 0;
  const parts = clean.match(/^(\d{1,2})(?::(\d{2}))?([ap]m)?$/);
  if (!parts) return null;
  let hour = Number(parts[1]);
  if (parts[3]) {
    if (!hour || hour > 12) return null;
    hour = hour % 12 + (parts[3] === 'pm' ? 12 : 0);
  } else if (hour >= 1 && hour <= 11 && !parts[1].startsWith('0')) {
    if (period === 'afternoon' || period === 'evening' || (!period && hour <= 6 && !parts[2])) hour += 12;
  }
  return hour * 60 + Number(parts[2] || 0);
}

function clockString(minutes) {
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

function timeConstraints(text, minutes) {
  const period = text.match(/\b(morning|afternoon|evening|tonight)\b/i)?.[1].toLowerCase();
  const bands = { morning: [0, 720], afternoon: [720, 1020], evening: [1020, 1440], tonight: [1020, 1440] };
  const [bandStart, bandEnd] = bands[period] || [null, null];
  let low = bandStart;
  let high = bandEnd;
  if (/\bafter lunch\b/i.test(text)) low = Math.max(low ?? 0, 780);
  if (/\bbefore lunch\b/i.test(text)) high = Math.min(high ?? 1440, 720);

  const range = text.match(new RegExp('\\b(?:between|from)\\s+(' + clockPattern + ')\\s*(?:and|to|until|[-–—])\\s*(' + clockPattern + ')(?![\\w:-])', 'i'));
  if (range) {
    const left = clockMinute(range[1], period);
    const right = clockMinute(range[2], period);
    if (left !== null && right !== null) {
      low = Math.max(low ?? 0, left);
      high = Math.min(high ?? 1440, right);
    }
  }
  const clocks = new RegExp('\\b(no earlier than|no later than|after|starting at|before|until|by|at)\\s+(' + clockPattern + ')(?![\\w:-]|\\s*(?:hours?|hrs?|minutes?|mins?|days?)\\b)', 'gi');
  for (const match of text.matchAll(clocks)) {
    if (range && match.index >= range.index && match.index < range.index + range[0].length) continue;
    const minute = clockMinute(match[2], period);
    if (minute === null) throw new RangeError('Enter a valid clock time for this task.');
    const prep = match[1].toLowerCase();
    if (['after', 'at', 'starting at', 'no earlier than'].includes(prep)) low = Math.max(low ?? 0, minute);
    if (['by', 'until', 'before', 'no later than'].includes(prep)) high = Math.min(high ?? 1440, minute);
    if (prep === 'at' || prep === 'starting at') high = Math.min(high ?? 1440, minute + minutes);
  }
  return { windowStart: low === null ? null : clockString(low), windowEnd: high === null ? null : clockString(high) };
}

export function estimateTask(text, { now, timeZone = 'UTC', estimatedMinutes } = {}) {
  const today = instantInZone(now, timeZone).startOf('day');
  if (!today.isValid) throw new RangeError('Choose a valid time zone and scheduling date.');
  const estimate = workEstimate(text);
  const { flexibleText, ...dates } = dateConstraints(text, today);
  return { ...estimate, ...dates, ...timeConstraints(flexibleText, estimate.explicitMinutes ? estimate.minutes : (estimatedMinutes ?? estimate.minutes)) };
}

// An exact start such as “at 10” creates an end derived from the estimate.
// Recompute that end on resize while retaining explicit deadlines and ranges.
export function resizedClockWindow(task, minutes, timeZone) {
  if (!task.windowStart || !task.windowEnd) return task.windowEnd;
  const captured = instantInZone(task.estimateRequestedAt || task.createdAt, timeZone).startOf('day');
  if (!captured.isValid) return task.windowEnd;
  try {
    const { flexibleText } = dateConstraints(task.text, captured);
    const original = timeConstraints(flexibleText, task.minutes);
    if (original.windowStart === task.windowStart && original.windowEnd === task.windowEnd) {
      return timeConstraints(flexibleText, minutes).windowEnd;
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // Legacy or calendar-edited text may have an unrelated clock expression.
  }
  return task.windowEnd;
}

const minuteMs = 60_000;
const gridMs = 5 * minuteMs;

function validDay(text, zone) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = DateTime.fromISO(text, { zone }).startOf('day');
  return date.isValid && date.toISODate() === text ? date : null;
}

function searchDays({ task, settings, now, horizonDays = 28 }) {
  if (!settings?.timeZone || !Number.isInteger(horizonDays) || horizonDays < 1) return null;
  const current = instantInZone(now, settings.timeZone);
  if (!current.isValid) return null;
  const today = current.startOf('day');
  const limit = today.plus({ years: 1, days: 1 }).startOf('day');
  let first = today;
  if (task.earliestDay) {
    const earliest = validDay(task.earliestDay, settings.timeZone);
    if (!earliest) return null;
    if (earliest > first) first = earliest;
  }
  let stop = DateTime.min(first.plus({ days: Math.min(horizonDays, 367) }).startOf('day'), limit);
  if (task.latestDay) {
    const latest = validDay(task.latestDay, settings.timeZone);
    if (!latest) return null;
    stop = DateTime.min(stop, latest.plus({ days: 1 }).startOf('day'));
  }
  return first < stop ? { first, stop, current } : null;
}

// The Google free/busy query and the slot search must cover identical dates,
// especially when a task asks for a particular day beyond the usual horizon.
export function planningRange(input) {
  const days = searchDays(input);
  if (!days) return null;
  return { start: days.first.toUTC().toISO(), end: days.stop.toUTC().toISO() };
}

function clockValue(value, allowMidnightEnd = false) {
  if (allowMidnightEnd && value === '24:00') return 1440;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function mergeIntervals(intervals) {
  const result = [];
  for (const interval of intervals.sort((left, right) => left.start - right.start)) {
    const last = result[result.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else result.push(interval);
  }
  return result;
}

function blockedIntervals(busy, zone) {
  if (!Array.isArray(busy)) return null;
  const intervals = [];
  for (const item of busy) {
    if (!item || item.start == null || item.end == null) return null;
    const start = instantInZone(item.start, zone).toMillis();
    const end = instantInZone(item.end, zone).toMillis();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    if (start < end) intervals.push({ start, end });
  }
  return mergeIntervals(intervals);
}

// Map a local work window to actual instants. On a fall-back day the same
// clock time can occur twice; on a spring-forward day it can be absent.
function dayWindows(day, localStart, localEnd) {
  const start = day.toMillis();
  const end = day.plus({ days: 1 }).startOf('day').toMillis();
  const firstOffset = day.offset;
  const lastOffset = day.zone.offset(end - 1);
  const segments = [];
  if (firstOffset === lastOffset) {
    segments.push([start, end, firstOffset]);
  } else {
    let a = start;
    let b = end - 1;
    while (b - a > 1) {
      const middle = a + Math.floor((b - a) / 2);
      if (day.zone.offset(middle) === firstOffset) a = middle;
      else b = middle;
    }
    segments.push([start, b, firstOffset], [b, end, lastOffset]);
  }
  const wallDay = Date.UTC(day.year, day.month - 1, day.day);
  const windows = [];
  for (const [from, until, offset] of segments) {
    const lower = Math.max(from, wallDay + (localStart - offset) * minuteMs);
    const upper = Math.min(until, wallDay + (localEnd - offset) * minuteMs);
    if (lower < upper) windows.push({ start: lower, end: upper });
  }
  return mergeIntervals(windows);
}

function freeStart(window, blocked, nowMillis, duration, exactOpening) {
  const roundUp = (time) => Math.ceil(time / gridMs) * gridMs;
  let candidate = exactOpening && nowMillis <= window.start ? window.start : roundUp(Math.max(nowMillis, window.start));
  for (const event of blocked) {
    if (candidate + duration > window.end) return null;
    if (event.end <= candidate) continue;
    if (event.start >= candidate + duration) return candidate;
    candidate = roundUp(event.end);
  }
  return candidate + duration <= window.end ? candidate : null;
}

export function findSlot({ task, settings, busy = [], now, horizonDays = 28 }) {
  const days = searchDays({ task, settings, now, horizonDays });
  if (!days || !Array.isArray(settings.workDays) || !Number.isSafeInteger(task.minutes) || task.minutes < 1) return null;
  const startMinute = Math.max(clockValue(settings.startTime), task.windowStart == null ? 0 : clockValue(task.windowStart));
  const endMinute = Math.min(clockValue(settings.endTime, true), task.windowEnd == null ? 1440 : clockValue(task.windowEnd, true));
  if (!(startMinute < endMinute)) return null;
  const blocked = blockedIntervals(busy, settings.timeZone);
  if (!blocked) return null;
  const duration = task.minutes * minuteMs;
  const exactOpening = task.windowStart != null && task.windowEnd != null && endMinute - startMinute === task.minutes;
  for (let day = days.first; day < days.stop; day = day.plus({ days: 1 }).startOf('day')) {
    if (!settings.workDays.includes(day.weekday)) continue;
    const deadline = task.deadlineTime != null && day.toISODate() === task.latestDay ? clockValue(task.deadlineTime, true) : 1440;
    if (!(startMinute < deadline)) continue;
    for (const window of dayWindows(day, startMinute, Math.min(endMinute, deadline))) {
      const start = freeStart(window, blocked, days.current.toMillis(), duration, exactOpening);
      if (start !== null) return { start: new Date(start).toISOString(), end: new Date(start + duration).toISOString() };
    }
  }
  return null;
}
