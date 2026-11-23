import { DaylineService } from '../../src/service.mjs';
import { defaultSettings } from '../../src/store.mjs';
import { readCalendarMeetings } from '../../src/meetings.mjs';

export const day = '2026-11-23';
export const week = '?from=2026-11-23&to=2026-11-30';
export const at = time => day + 'T' + time + ':00.000Z';
export const taskInput = { requestId: 'f'.repeat(32), text: 'Prepare studio notes for 30 minutes', day };

// The production service and meeting adapter run normally. Only Google's HTTP
// data and a signed-in account are simulated. Every supported write is a trap.
export function liveCalendarFixture({ includeHome = true } = {}) {
  const work = 'studio@example.invalid', home = 'personal@example.invalid';
  const calls = { changes: [], busy: [], detailedBusy: [], details: [], writes: [], failedBusy: 0 };
  const account = (sub, meetingDetails) => ({ sub, email: sub, secret: sub, mode: 'availability', meetingDetails });
  const store = { state: { version: 1, tasks: [], settings: { ...defaultSettings(), timeZone: 'UTC', endTime: '12:00' },
    accounts: [account(work, true), ...(includeHome ? [account(home, false)] : [])], agent: { provider: 'local' } }, save() {} };
  let version = 1;
  let event = { id: 'fixture-review', iCalUID: 'review@synthetic.invalid', status: 'confirmed', summary: 'Studio review',
    start: { dateTime: at('09:00') }, end: { dateTime: at('09:30') }, location: 'North room',
    htmlLink: 'https://calendar.google.com/calendar/event?eid=c3ludGhldGlj', hangoutLink: 'https://meet.google.com/abc-defg-hij',
    organizer: { email: work, displayName: 'Studio host', self: true },
    attendees: [{ email: 'guest@example.invalid', displayName: 'Morgan Fixture', responseStatus: 'needsAction' }] };
  const controls = { busyError: false, changeError: false, busyGate: null };
  function intervals(id, start, end) {
    const items = id === work && event ? [{ start: event.start.dateTime, end: event.end.dateTime }] : [];
    return items.filter(item => item.start < end && item.end > start);
  }
  function update(changes) {
    event = changes === null ? null : { ...event, ...changes };
    version++;
  }
  function attendee(responseStatus) { return [{ email: 'guest@example.invalid', displayName: 'Morgan Fixture', responseStatus }]; }
  const google = {
    async refreshToken({ refreshToken }) { return { access_token: refreshToken, expires_in: 3600 }; },
    async listCalendars(id) {
      return [{ id, name: id === work ? 'Studio' : 'Personal', primary: true,
        accessRole: id === work ? 'owner' : 'freeBusyReader', timeZone: 'UTC', writable: false }];
    },
    async getBusy(id, { calendarIds, start, end }) {
      calls.busy.push(id);
      if (controls.busyGate) { controls.busyGate.entered.resolve(); await controls.busyGate.proceed.promise; }
      if (controls.busyError) { calls.failedBusy++; throw Object.assign(new Error('Synthetic calendar offline'), { status: 503 }); }
      return calendarIds.flatMap(calendarId => intervals(calendarId, start, end));
    },
    async getBusyByCalendar(id, { calendarIds, start, end }) {
      calls.detailedBusy.push(id);
      return calendarIds.map(calendarId => ({ calendarId, busy: intervals(calendarId, start, end) }));
    },
    async readCalendarChangePage(id, { calendarId, syncToken, etag }) {
      if (id !== work || calendarId !== work) throw new Error('Read-only busy calendars have no event-list grant.');
      calls.changes.push({ syncToken, version });
      if (controls.changeError) throw Object.assign(new Error('Synthetic provider offline'), { status: 503 });
      const next = 's' + version;
      const validator = '"' + (syncToken || 'initial') + '-' + next + '"';
      if (etag === validator) return { notModified: true };
      return { etag: validator, nextSyncToken: next, nextPageToken: null, hasChanges: Boolean(syncToken && syncToken !== next) };
    }
  };
  for (const name of ['putTaskEvent', 'deleteTaskEvent', 'listTaskEvents', 'getTaskEvent', 'busyWithoutReservations']) {
    google[name] = () => { calls.writes.push(name); throw new Error('Unexpected calendar event-sync call: ' + name); };
  }
  const service = new DaylineService({ store, google, bundledClient: { clientId: 'local-fixture' }, vault: { open: value => value },
    clock: () => new Date(at('08:45')),
    readMeetings: (access, calendar, range) => {
      calls.details.push(calendar.providerId);
      return readCalendarMeetings(access, calendar, range, async () => Response.json({ kind: 'calendar#events', items: event ? [event] : [] }));
    } });
  const moved = () => update({ summary: 'Revised studio review', start: { dateTime: at('10:30') }, end: { dateTime: at('11:00') },
    location: 'South room', attendees: attendee('accepted') });
  return { service, calls, controls, work, home, moved, update, attendee };
}
