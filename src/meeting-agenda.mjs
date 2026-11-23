import { DateTime } from 'luxon';
import { mergeMeetingCopies } from './meetings.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const empty = () => ({ events: [], warnings: [] });

export function meetingRange(from, to, timeZone) {
  const start = DAY.test(from) && DateTime.fromISO(from, { zone: timeZone });
  const end = DAY.test(to) && DateTime.fromISO(to, { zone: timeZone });
  const days = start?.isValid && end?.isValid ? end.diff(start, 'days').days : 0;
  if (days < 1 || days > 42) {
    throw Object.assign(new Error('Choose a calendar range between one day and six weeks.'), { status: 400 });
  }
  return { start: start.toUTC().toISO(), end: end.toUTC().toISO(), timeZone };
}

async function loadWeek(calendars, range, read) {
  const results = new Array(calendars.length);
  const warnings = new Set();
  const pending = calendars.entries();
  async function loadNext() {
    for (const [index, calendar] of pending) {
      try {
        results[index] = await read(calendar, range);
      } catch (error) {
        results[index] = [];
        const label = calendar.name || 'a selected calendar';
        const signIn = error.status === 401 || error.reason === 'invalid_grant' || error.reason === 'insufficientPermissions';
        warnings.add(signIn ? 'Reconnect ' + calendar.accountEmail + ' in Settings to read meeting details.'
          : 'Meeting details for ' + label + ' could not be loaded. Refresh to try again.');
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, calendars.length) }, loadNext));
  return { events: mergeMeetingCopies(results.flat()), warnings: [...warnings] };
}

// Personal meeting details live only in this local process. Concurrent browser
// and desktop views share one Google request per selected calendar and week.
export class MeetingAgenda {
  weeks = new Map();

  clear() { this.weeks.clear(); }

  expire() {
    for (const week of this.weeks.values()) week.expires = 0;
  }

  async read(calendars, range, read) {
    if (!calendars.length) return empty();
    const key = JSON.stringify(range);
    let week = this.weeks.get(key);
    if (week?.pending) return week.pending;
    if (week?.expires > Date.now()) return week.result;
    if (!week) {
      if (this.weeks.size >= 12) this.weeks.delete(this.weeks.keys().next().value);
      week = { result: null, expires: 0 };
      this.weeks.set(key, week);
    }
    week.pending = loadWeek(calendars, range, read).then(result => {
      // A user may have disconnected an account or excluded a calendar mid-read.
      if (this.weeks.get(key) !== week) return empty();
      week.result = result;
      week.expires = Date.now() + (result.warnings.length ? 10000 : 60000);
      return result;
    }).finally(() => { week.pending = null; });
    return week.pending;
  }

  containsLink(href) {
    for (const week of this.weeks.values()) {
      if (week.result?.events.some(event => event.joinUrl === href || event.calendarUrl === href)) return true;
    }
    return false;
  }
}
