// Availability arithmetic for booking links, ported from antaia-space/meet
// (src/lib/slots.ts and src/lib/time.ts). Time zones use Intl alone, so a
// clock change is handled the same way on the Mac and in a guest's browser.

const formatters = new Map();

function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock date and time that an instant has in a time zone. */
export function zonedParts(utcMs, timeZone) {
  const out = {};
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute };
}

function offsetMs(utcMs, timeZone) {
  const p = zonedParts(utcMs, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return wall - Math.floor(utcMs / 60_000) * 60_000;
}

/**
 * The instant at which a time zone shows the given wall-clock time.
 * A time skipped by a clock change maps to the instant one hour later;
 * a time that occurs twice maps to its first occurrence.
 */
export function zonedToUtcMs(year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuess = wall - offsetMs(wall, timeZone);
  return wall - offsetMs(firstGuess, timeZone);
}

export function ymd(d) {
  return d.year + '-' + String(d.month).padStart(2, '0') + '-' + String(d.day).padStart(2, '0');
}

export function addDays(d, n) {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(d) {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

/** "09:30" -> 570. "24:00" is allowed as the end of a day. */
export function parseHm(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) throw new Error('Bad time "' + hm + '", expected HH:MM');
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) > 59 || minutes > 24 * 60) throw new Error('Bad time "' + hm + '"');
  return minutes;
}

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * Start times (epoch ms, ascending) at which the meeting type can be booked
 * inside [fromMs, toMs). Working hours are wall-clock times in the owner's
 * time zone; busy intervals ({ start, end } in epoch ms) come from the calendar.
 */
export function computeSlots({ type, ownerTimeZone: tz, fromMs, toMs, nowMs, busy }) {
  const earliest = Math.max(fromMs, nowMs + type.minNoticeMin * MINUTE);
  const latest = Math.min(toMs, nowMs + type.maxDaysAhead * DAY);
  if (!(earliest < latest)) return [];

  const duration = type.durationMin * MINUTE;
  const step = Math.max(5, type.slotStepMin);
  const gap = type.bufferMin * MINUTE;

  // One owner-local day of margin on each side covers every time zone offset.
  let day = zonedParts(earliest - DAY, tz);
  const lastDay = ymd(zonedParts(latest + DAY, tz));
  const found = new Set();

  while (ymd(day) <= lastDay) {
    const windows = type.dateOverrides?.[ymd(day)] ?? type.hours[WEEKDAYS[dayOfWeek(day)]] ?? [];
    for (const window of windows) {
      const windowEnd = parseHm(window.end);
      for (let t = parseHm(window.start); t + type.durationMin <= windowEnd; t += step) {
        const start = zonedToUtcMs(day.year, day.month, day.day, Math.floor(t / 60), t % 60, tz);
        if (start < earliest || start >= latest) continue;
        const blockedFrom = start - gap;
        const blockedTo = start + duration + gap;
        if (busy.some(b => b.start < blockedTo && b.end > blockedFrom)) continue;
        found.add(start);
      }
    }
    day = addDays(day, 1);
  }
  return [...found].sort((a, b) => a - b);
}
