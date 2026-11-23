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

export function durationInText(source) {
  const normalized = source.toLowerCase()
    .replace(/\bminuten\b/g, 'minutes').replace(/\b(?:stunden?|std)\b/g, 'hours')
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
  const precedingClock = new RegExp('\\b(?:by|due(?: (?:at|by))?|deadline(?: (?:at|by))?|until|before|no later than)\\s+(' + clockPattern + ')\\s+(?:on\\s+)?$', 'i');
  const followingClock = new RegExp('^\\s*,?\\s*(?:(?:(?:at|by|before|until)\\s+(' + clockPattern + ')|(' + bareClockPattern + '))' + clockEnd + '|(morning|afternoon|evening)\\b)', 'iu');
  for (const match of text.matchAll(new RegExp(dateWords, 'gi'))) {
    const phrase = match[0].toLowerCase();
    // Bare “week” in “a week of research” does not name a scheduling date.
    if (phrase === 'week') continue;
    const [first, last] = daySpan(phrase, today);
    if (!first.isValid || !last.isValid) throw new RangeError('Enter a valid calendar date for this task.');
    const before = text.slice(0, match.index).toLowerCase();
    const clockBefore = before.match(precedingClock);
    const since = /\b(?:from|starting(?: on)?|after|not before|no earlier than)\s*$/.test(before);
    const due = !since && (Boolean(clockBefore) || /\b(?:by|(?:due|deadline)(?:\s+(?:on|by|is))?|no later than|until|through|before)\s+(?:the\s+)?$/.test(before)
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
      const time = clockAfter[1] || clockAfter[2] ? clockMinute(clockAfter[1] || clockAfter[2]) : periodEnd[clockAfter[3].toLowerCase()];
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

const hourPattern = '(?:[01]?\\d|2[0-3])';
const meridiem = '[ap]\\.?\\s*m\\.?';
const clockPattern = '(?:noon|midnight|' + hourPattern + '(?:[.:][0-5]\\d)?(?:\\s*' + meridiem + ')?)';
// An unlabelled integer or decimal might be a quantity, a date or a version.
const bareClockPattern = '(?:noon|midnight|' + hourPattern + '(?::[0-5]\\d(?:\\s*' + meridiem + ')?|\\s*' + meridiem + '))';
const clockStart = '(?<![\\p{L}\\p{N}_.:/])';
const clockEnd = '(?![\\p{L}\\p{N}_:/]|\\.\\d)';
const bareClock = new RegExp('^' + bareClockPattern + '$', 'i');
const clocks = new RegExp(clockStart + '(' + clockPattern + ')' + clockEnd, 'giu');
const ranges = new RegExp(clockStart + '(?:(between|from)\\s+)?(' + clockPattern + ')\\s*(and|or|to|until|[-–—])\\s*(' + clockPattern + ')' + clockEnd, 'giu');

const germanTimeWords = {
  heute: 'today', morgen: 'tomorrow', übermorgen: 'day after tomorrow',
  montag: 'monday', dienstag: 'tuesday', mittwoch: 'wednesday', donnerstag: 'thursday',
  freitag: 'friday', samstag: 'saturday', sonntag: 'sunday',
  vormittags: 'morning', nachmittags: 'afternoon', abends: 'evening',
  um: 'at', ab: 'no earlier than', nach: 'after', vor: 'before', bis: 'until',
  gegen: 'around', frühestens: 'no earlier than', spätestens: 'no later than',
  zwischen: 'between', von: 'from', und: 'and',
};
const germanTimeWord = new RegExp('(?<!\\p{L})(?:' + Object.keys(germanTimeWords).join('|') + ')(?!\\p{L})', 'giu');

function schedulingText(text) {
  return text.replace(/\b(\d{1,2})(?:[.:]([0-5]\d))?\s*uhr\b/gi, (_, hour, minute) => hour.padStart(2, '0') + ':' + (minute || '00'))
    .replace(/\bam morgen\b/gi, 'in the morning')
    .replace(germanTimeWord, word => germanTimeWords[word.toLowerCase()]);
}
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

const startsAt = /\b(?:start(?:s|ing)?|begin(?:s|ning)?)\s+at\s*$/i;
const relativeToEvent = /\b(after|before|by|until)\s+(?:(?:the|a|an|my|our|their|team|morning|afternoon|client|weekly|next)\s+)*(?:meeting|call|appointment|interview|class|session|workshop|train|flight)(?:\s+(?:starts?\s+)?at)?\s*$/i;

function clockRole(before, after) {
  if (/^\s*(?:or later|at the earliest)\b/i.test(after)) return 'lower';
  if (/^\s*(?:or earlier|at the latest|deadline|cutoff)\b/i.test(after)) return 'upper';
  if (/^\s*(?:if possible|or so|ish)\b/i.test(after)) return 'approximate';
  const relative = before.match(relativeToEvent);
  if (relative) return relative[1].toLowerCase() === 'after' ? 'lower' : 'upper';
  if (/\b(?:no earlier than|(?:at the )?earliest(?: start)?|after|from)(?: at)?\s*$/i.test(before)) return 'lower';
  if (/\b(?:no later than|(?:at the )?latest(?: start)?|by|until|before)(?: at)?\s*$/i.test(before)
    || /\b(?:end(?:s|ing)?|finish(?:es|ing)?|due|deadline|cutoff)(?: (?:is|at|by|of))*\s*$/i.test(before)) return 'upper';
  if (/\b(?:around|about|approximately|roughly|ideally|preferably|maybe|except|not)(?: at)?\s*$/i.test(before)) return 'approximate';
  return /(?:\bat|@)\s*$/i.test(before) ? 'fixed' : null;
}

function readClocks(text) {
  const period = text.match(/\b(morning|afternoon|evening|tonight)\b/i)?.[1].toLowerCase();
  const bands = { morning: [0, 720], afternoon: [720, 1020], evening: [1020, 1440], tonight: [1020, 1440] };
  const [bandStart, bandEnd] = bands[period] || [null, null];
  let low = bandStart;
  let high = bandEnd;
  if (/\bafter lunch\b/i.test(text)) low = Math.max(low ?? 0, 780);
  if (/\bbefore lunch\b/i.test(text)) high = Math.min(high ?? 1440, 720);

  const rangeSpans = [];
  const starts = new Set();
  for (const match of text.matchAll(ranges)) {
    const connector = match[3].toLowerCase();
    if (!match[1] && (connector === 'and' || (!bareClock.test(match[2]) && !bareClock.test(match[4])))) continue;
    rangeSpans.push([match.index, match.index + match[0].length]);
    if (connector === 'or') continue;
    const left = clockMinute(match[2], period);
    const right = clockMinute(match[4], period);
    if (left !== null && right !== null) {
      low = Math.max(low ?? 0, left);
      high = Math.min(high ?? 1440, right);
      if (startsAt.test(text.slice(0, match.index))) starts.add(left);
    }
  }
  for (const match of text.matchAll(clocks)) {
    if (rangeSpans.some(([from, to]) => match.index >= from && match.index < to)) continue;
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    const role = clockRole(before, after);
    if (!role && !bareClock.test(match[1])) continue;
    if (/^\d+$/.test(match[1]) && (/\d[-–—]$/.test(before) || /^[-–—]\d/.test(after))) continue;
    if (/[€£$#]$/.test(before) || /^\s*(?:[%/]|(?:hours?|hrs?|h|minutes?|mins?|m|days?|pages?|slides?|items?|tickets?|projects?|invoices?)\b)/i.test(after)) continue;
    if (/\b(?:ratio|odds|score|verse|version|timestamp|timecode)\s*(?:(?:of|is|at)\s*)?$/i.test(before)) continue;
    const minute = clockMinute(match[1], period);
    if (minute === null) throw new RangeError('Enter a valid clock time for this task.');
    if (role === 'lower') low = Math.max(low ?? 0, minute);
    else if (role === 'upper') high = Math.min(high ?? 1440, minute);
    else if (role !== 'approximate') starts.add(minute);
  }
  return { low, high, exact: starts.size === 1 ? [...starts][0] : null };
}

function displayWindow({ low, high, exact }, minutes) {
  if (exact !== null) {
    low = Math.max(low ?? 0, exact);
    high = Math.min(high ?? 1440, exact + minutes);
  }
  return { windowStart: low === null ? null : clockString(low), windowEnd: high === null ? null : clockString(high) };
}

function sourceClocks(task, timeZone) {
  if (typeof task?.text !== 'string' || !task.text) return null;
  const captured = instantInZone(task.estimateRequestedAt || task.createdAt, timeZone).startOf('day');
  if (!captured.isValid) return null;
  try { return readClocks(dateConstraints(schedulingText(task.text), captured).flexibleText); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return null;
  }
}

// A narrow model-suggested window, a generated title, and an existing event
// start are not evidence that the author asked for an appointment at that time.
export function explicitStartFor(task, timeZone = 'UTC') {
  const minute = sourceClocks(task, timeZone)?.exact;
  return minute == null ? null : clockString(minute);
}

export function estimateTask(text, { now, timeZone = 'UTC', estimatedMinutes } = {}) {
  const today = instantInZone(now, timeZone).startOf('day');
  if (!today.isValid) throw new RangeError('Choose a valid time zone and scheduling date.');
  const estimate = workEstimate(text);
  const { flexibleText, ...dates } = dateConstraints(schedulingText(text), today);
  const minutes = estimate.explicitMinutes ? estimate.minutes : (estimatedMinutes ?? estimate.minutes);
  return { text, ...estimate, ...dates, ...displayWindow(readClocks(flexibleText), minutes) };
}

// An exact start such as “at 10” creates an end derived from the estimate.
// Recompute that end on resize while retaining explicit deadlines and ranges.
export function resizedClockWindow(task, minutes, timeZone) {
  const source = sourceClocks(task, timeZone);
  return source?.exact != null ? displayWindow(source, minutes).windowEnd : task.windowEnd;
}

const minuteMs = 60_000;

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

function blockedIntervals(busy, zone, instants) {
  if (!Array.isArray(busy)) return null;
  const intervals = [];
  const millis = value => {
    if (!instants) return instantInZone(value, zone).toMillis();
    if (!instants.has(value)) instants.set(value, instantInZone(value, zone).toMillis());
    return instants.get(value);
  };
  for (const item of busy) {
    if (!item || item.start == null || item.end == null) return null;
    const start = millis(item.start), end = millis(item.end);
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

function freeStart(window, blocked, nowMillis, duration) {
  const nextMinute = time => Math.ceil(time / minuteMs) * minuteMs;
  let candidate = nextMinute(Math.max(nowMillis, window.start));
  for (const event of blocked) {
    if (candidate + duration > window.end) return null;
    if (event.end <= candidate) continue;
    if (event.start >= candidate + duration) return candidate;
    candidate = nextMinute(event.end);
  }
  return candidate + duration <= window.end ? candidate : null;
}

function cached(map, key, calculate) {
  if (!map.has(key)) map.set(key, calculate());
  return map.get(key);
}

function workWindows(day, start, end, cache) {
  return cache ? cached(cache.windows, day.toMillis() + '/' + start + '/' + end, () => dayWindows(day, start, end)) : dayWindows(day, start, end);
}

function fixedStart(day, minute, windows, blocked, nowMillis, duration, capturedAt, cache) {
  // Intersect that single wall-clock minute with the day's real instants.
  // It can be missing in spring or have two candidates in autumn.
  for (const { start } of workWindows(day, minute, minute + 1, cache)) {
    const end = start + duration;
    if (start < nowMillis && !(capturedAt <= start && nowMillis < end)) continue;
    if (!windows.some(window => start >= window.start && end <= window.end)) continue;
    if (!blocked.some(event => event.start < end && event.end > start)) return start;
  }
  return null;
}

// All duration trials within one plan share a settings snapshot. Only pure
// calendar calculations are cached; each trial still checks its own busy list.
export function createSlotSearch(settings) {
  const cache = { days: new Map(), nextDays: new Map(), wording: new Map(), windows: new Map(), instants: new Map() };
  return input => findSlot({ ...input, settings, cache });
}

export function findSlot({ task, settings, busy = [], now, horizonDays = 28, allowInProgress = false, cache }) {
  const calendarDays = () => searchDays({ task, settings, now, horizonDays });
  const days = cache ? cached(cache.days, JSON.stringify([now, task.earliestDay, task.latestDay, horizonDays]), calendarDays) : calendarDays();
  if (!days || !Array.isArray(settings.workDays) || !Number.isSafeInteger(task.minutes) || task.minutes < 1) return null;
  const readWording = () => sourceClocks(task, settings.timeZone);
  const wording = cache ? cached(cache.wording, JSON.stringify([task.text, task.estimateRequestedAt || task.createdAt]), readWording) : readWording();
  const exact = wording?.exact;
  // The written clock wins over an older model's window. An actual "before",
  // "after", range or deadline in the same wording still bounds the full task.
  const lower = exact != null ? wording.low ?? 0 : task.windowStart == null ? 0 : clockValue(task.windowStart);
  const upper = exact != null ? wording.high ?? 1440 : task.windowEnd == null ? 1440 : clockValue(task.windowEnd, true);
  const startMinute = Math.max(clockValue(settings.startTime), lower);
  const endMinute = Math.min(clockValue(settings.endTime, true), upper);
  if (!(startMinute < endMinute)) return null;
  const blocked = blockedIntervals(busy, settings.timeZone, cache?.instants);
  if (!blocked) return null;
  const duration = task.minutes * minuteMs;
  const nowMillis = days.current.toMillis();
  const captured = task.estimateRequestedAt || task.createdAt;
  const capturedAt = allowInProgress && captured != null
    ? Math.max(instantInZone(captured, settings.timeZone).toMillis(), Date.parse(task.reopenedAt) || 0) : Infinity;
  const nextDay = day => {
    const next = () => day.plus({ days: 1 }).startOf('day');
    return cache ? cached(cache.nextDays, day.toMillis(), next) : next();
  };
  for (let day = days.first; day < days.stop; day = nextDay(day)) {
    if (!settings.workDays.includes(day.weekday)) continue;
    const deadline = task.deadlineTime != null && day.toISODate() === task.latestDay ? clockValue(task.deadlineTime, true) : 1440;
    if (!(startMinute < deadline)) continue;
    const windows = workWindows(day, startMinute, Math.min(endMinute, deadline), cache);
    if (exact != null) {
      const start = fixedStart(day, exact, windows, blocked, nowMillis, duration, capturedAt, cache);
      if (start !== null) return { start: new Date(start).toISOString(), end: new Date(start + duration).toISOString() };
      continue;
    }
    for (const window of windows) {
      const start = freeStart(window, blocked, nowMillis, duration);
      if (start !== null) return { start: new Date(start).toISOString(), end: new Date(start + duration).toISOString() };
    }
  }
  return null;
}
