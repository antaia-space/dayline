import assert from 'node:assert/strict';
import test from 'node:test';
import { meetingLink, mergeMeetingCopies, readCalendarMeetings } from '../src/meetings.mjs';

const calendar = { providerId: 'planning@example.org', id: 'local-reference', name: 'Planning', accessRole: 'owner',
  primary: true, accountEmail: 'riley@example.org', timeZone: 'America/Los_Angeles' };
const range = { start: '2026-11-23T08:00:00Z', end: '2026-11-30T08:00:00Z', timeZone: 'America/Los_Angeles' };
const time = dateTime => ({ dateTime });
const appointment = { id: 'event1', iCalUID: 'unique-invitation@example.org', summary: 'Project review',
  start: time('2026-11-23T10:00:00-08:00'), end: time('2026-11-23T11:00:00-08:00'), htmlLink: 'https://www.google.com/calendar/event?eid=fixture' };
const read = (items, source = calendar, viewport = range) => readCalendarMeetings('test-credential', source, viewport,
  async () => Response.json({ kind: 'calendar#events', items }));
const display = async (items, source, viewport) => mergeMeetingCopies(await read(items, source, viewport));

test('meeting reads page through overlapping expanded instances and return only the display fields', async () => {
  const requests = [];
  const event = { ...appointment, description: 'Internal memo; unrelated reference https://docs.google.com/example.',
    location: 'Room C', transparency: 'transparent', extendedProperties: { private: { anotherTool: 'unrelated-selection' } },
    organizer: { displayName: 'Alex Rowan', email: 'alex@example.org' },
    attendees: [{ displayName: 'Riley', email: 'riley@example.org', responseStatus: 'tentative', optional: true, self: true, comment: 'Private comment' }],
    conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+10000000000' },
      { entryPointType: 'video', uri: 'https://video.cobalt-union.dev/room/review' }] } };
  const first = async (address, init) => {
    const url = new URL(address);
    assert.equal(init.headers.Authorization, 'Bearer test-credential');
    assert.equal(init.redirect, 'error');
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(url.pathname, '/calendar/v3/calendars/planning%40example.org/events');
    assert.equal(url.searchParams.get('timeMin'), '2026-11-23T08:00:00.000Z');
    assert.equal(url.searchParams.get('timeMax'), '2026-11-30T08:00:00.000Z');
    assert.equal(url.searchParams.get('timeZone'), range.timeZone);
    assert.equal(url.searchParams.get('singleEvents'), 'true');
    assert.equal(url.searchParams.get('showDeleted'), 'false');
    assert.equal(url.searchParams.get('orderBy'), 'startTime');
    assert.doesNotMatch(url.searchParams.get('fields'), /attachments|comment|reminders|password/);
    const token = url.searchParams.get('pageToken');
    requests.push(token);
    return Response.json(!token ? { kind: 'calendar#events', items: [], nextPageToken: 'page-2' } :
      { kind: 'calendar#events', items: [event, { id: 'cancelled', status: 'cancelled' },
        { ...appointment, id: 'daylineTask', extendedProperties: { private: { dayline: '1', daylineTaskId: 'task' } } },
        { ...appointment, id: 'endsAtStart', start: time('2026-11-23T07:00:00Z'), end: time(range.start) },
        { ...appointment, id: 'startsAtEnd', start: time(range.end), end: time('2026-11-30T09:00:00Z') },
        { ...appointment, id: 'malformed', end: { date: '2026-11-24' } }] });
  };
  const [item, ...rest] = mergeMeetingCopies(await readCalendarMeetings('test-credential', { ...calendar, representedTaskIds: new Set(['task']) }, range, first));
  assert.deepEqual(requests, [null, 'page-2']);
  assert.deepEqual(rest, []);
  assert.match(item.id, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual({ ...item, id: 'hashed' }, {
    id: 'hashed', title: 'Project review', start: '2026-11-23T18:00:00.000Z', end: '2026-11-23T19:00:00.000Z',
    allDay: false, startDate: null, endDate: null, calendarName: 'Planning', visibility: 'default', transparent: true,
    location: 'Room C', joinUrl: 'https://video.cobalt-union.dev/room/review', calendarUrl: appointment.htmlLink,
    organizer: { name: 'Alex Rowan', email: 'alex@example.org' }, attendeesOmitted: false,
    attendees: [{ name: 'Riley', email: 'riley@example.org', response: 'tentative', optional: true, self: true, organizer: false }] });
  assert.doesNotMatch(JSON.stringify(item), /memo|comment|unrelated-selection|unique-invitation|test-credential/);
});

test('hides a linked Dayline task while retaining a teammate’s shared task event', async () => {
  const marked = (key, summary) => ({ ...appointment, id: key, iCalUID: key,
    summary, extendedProperties: { private: { dayline: '1', daylineTaskId: key } } });
  const own = marked('local-task-id', 'My editable task');
  const colleague = marked('teammate-task-id', 'Studio preparation');
  const [visible] = await display([own, colleague], { ...calendar, representedTaskIds: new Set(['local-task-id']) });
  assert.equal(visible.title, 'Studio preparation');
  assert.equal((await display([colleague])).length, 1);
  assert.doesNotMatch(JSON.stringify(visible), /teammate-task-id|extendedProperties/);
});

test('keeps all-day floating dates on the planner clock, including the short DST day and cross-zone calendars', async () => {
  const allDay = { id: 'all-day', start: { date: '2026-03-08' }, end: { date: '2026-03-09' }, summary: 'Studio closed' };
  const day = { start: '2026-03-08T08:00:00Z', end: '2026-03-09T07:00:00Z', timeZone: 'America/Los_Angeles' };
  let queried;
  const events = await readCalendarMeetings('test-credential', { ...calendar, timeZone: 'Pacific/Kiritimati' }, day, async url => {
    queried = new URL(url);
    return Response.json({ kind: 'calendar#events', items: [allDay,
      { ...allDay, id: 'day-before', start: { date: '2026-03-07' }, end: { date: '2026-03-08' } },
      { ...allDay, id: 'timed', start: { dateTime: '2026-03-08T12:00:00', timeZone: 'Europe/Berlin' },
        end: { dateTime: '2026-03-08T12:30:00', timeZone: 'Europe/Berlin' } }] });
  });
  assert.equal(queried.searchParams.get('timeMin'), '2026-03-07T10:00:00.000Z');
  const [first, second] = mergeMeetingCopies(events);
  assert.deepEqual([first.allDay, first.startDate, first.endDate, first.start, first.end],
    [true, '2026-03-08', '2026-03-09', '2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z']);
  assert.deepEqual([second.allDay, second.start, second.end], [false, '2026-03-08T11:00:00.000Z', '2026-03-08T11:30:00.000Z']);
});

test('calendar sharing and guest-list restrictions apply to the actual signed-in person', async () => {
  const event = { ...appointment, visibility: 'private', summary: 'Confidential session', location: 'Room D',
    description: 'Only for invited guests', hangoutLink: 'https://meet.google.com/abc-defg-hij',
    organizer: { displayName: 'Alex', email: 'alex@example.org', self: true }, guestsCanSeeOtherGuests: false,
    attendees: [{ displayName: 'Alex', email: 'alex@example.org', organizer: true, responseStatus: 'accepted' },
      { displayName: 'Riley', email: 'riley@example.org', responseStatus: 'needsAction' },
      { displayName: 'Lee', email: 'lee@example.org', responseStatus: 'declined', optional: true }] };
  for (const accessRole of ['reader', 'writerWithoutPrivateAccess']) {
    const [restricted] = await display([event], { ...calendar, accessRole, primary: false, accountEmail: 'mika@example.org' });
    assert.deepEqual([restricted.title, restricted.location, restricted.organizer, restricted.joinUrl, restricted.calendarUrl,
      restricted.attendees, restricted.attendeesOmitted], ['Private event', null, null, null, null, [], true]);
  }
  const [guest] = await display([event], { ...calendar, primary: false, accessRole: 'reader' });
  assert.equal(guest.title, 'Confidential session');
  assert.deepEqual(guest.attendees.map(a => [a.name, a.self, a.response]), [['Alex', false, 'accepted'], ['Riley', true, 'needsAction']]);
  assert.equal(guest.attendeesOmitted, true);
  const [organizer] = await display([event], { ...calendar, primary: false, accessRole: 'reader', accountEmail: 'alex@example.org' });
  assert.deepEqual(organizer.attendees.map(a => a.name), ['Alex', 'Riley', 'Lee']);
  assert.equal(organizer.attendeesOmitted, false);
  const [partial] = await display([{ ...event, attendeesOmitted: true, guestsCanSeeOtherGuests: true, attendees: [event.attendees[1]] }]);
  assert.deepEqual(partial.attendees.map(a => a.name), ['Riley']);
  assert.equal(partial.attendeesOmitted, true);
  let requests = 0;
  assert.deepEqual(await readCalendarMeetings('unused', { ...calendar, accessRole: 'freeBusyReader' }, range, () => { requests++; }), []);
  assert.equal(requests, 0);
});

test('shares stable IDs across invitations and moved copies without collapsing independent events or recurring instances', async () => {
  const one = { ...appointment, recurringEventId: 'series', originalStartTime: time('2026-11-23T10:00:00-08:00') };
  const another = { ...one, id: 'second', originalStartTime: time('2026-11-24T10:00:00-08:00'), summary: 'Different occurrence' };
  const extra = { ...one, iCalUID: 'different@example.org', summary: 'Independent simultaneous meeting' };
  const primary = await read([one, another, extra]);
  const secondary = await read([{ ...one, id: 'different-provider-id', originalStartTime: time('2026-11-23T18:00:00Z'),
    start: time('2026-11-23T19:00:00Z'), end: time('2026-11-23T20:00:00Z'), summary: 'Separate copy' }],
    { ...calendar, providerId: 'studio@example.org', primary: false, name: 'Shared' });
  const merged = mergeMeetingCopies([...secondary, ...primary]);
  assert.equal(merged.length, 3);
  assert.equal(new Set(merged.map(i => i.id)).size, 3);
  assert.deepEqual(merged, mergeMeetingCopies([...primary, ...secondary]));
  assert.ok(merged.every(i => i.calendarName === 'Planning' && !('copyPriority' in i)));
});

test('deduplicated invitations prefer an active account and the richer visible version', async () => {
  const primary = await read([{ ...appointment, attendees: [{ email: calendar.accountEmail, responseStatus: 'declined', self: true }] }]);
  const archive = await read([appointment], { ...calendar, primary: false, name: 'Mirror' });
  const active = await read([{ ...appointment, hangoutLink: 'https://meet.google.com/abc-defg-hij',
    attendees: [{ email: 'lee@example.org', responseStatus: 'accepted', self: true }] }],
    { ...calendar, accountEmail: 'lee@example.org', name: 'Studio' });
  const [chosen] = mergeMeetingCopies([...primary, ...archive, ...active]);
  assert.deepEqual([chosen.calendarName, chosen.joinUrl, ...chosen.attendees.map(a => a.response)], ['Studio', 'https://meet.google.com/abc-defg-hij', 'accepted']);
});

test('meeting actions permit validated public video endpoints and only known conference joins in user-authored text', async () => {
  const safe = 'https://us02web.zoom.us/j/123456789?pwd=fixture';
  const fallback = { ...appointment, conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://localhost:8080/secret' }] },
    location: 'Room P', description: 'Notes https://files.cobalt-union.dev/room and <a href="' + safe + '&amp;lang=en">Join</a>' };
  const [item] = await display([fallback]);
  assert.equal(item.joinUrl, safe + '&lang=en');
  const [meet] = await display([{ ...appointment, hangoutLink: 'https://meet.google.com/abc-defg-hij', location: safe }]);
  assert.equal(meet.joinUrl, 'https://meet.google.com/abc-defg-hij');
  for (const bad of ['javascript:alert(1)', 'file:///etc/hosts', 'http://meet.google.com/abc-defg-hij', 'https://user@meet.google.com/abc-defg-hij',
    'https://meet.google.com:7443/room', 'https://intranet/room', 'https://router.local/room', 'https://127.1/room',
    'https://[::1]/room', 'https://127.0.0.1.nip.io/room']) assert.equal(meetingLink(bad, 'join'), null, bad);
  for (const bad of ['https://meet.google.com.evil.cobalt-union.dev/abc-defg-hij', 'https://zoom.us/redirect?goto=room', 'https://conference.cobalt-union.dev/room']) {
    const [noLink] = await display([{ ...appointment, description: 'Join ' + bad }]);
    assert.equal(noLink.joinUrl, null, bad);
  }
  assert.equal(meetingLink('https://www.google.com/url?url=https://other.dev', 'calendar'), null);
  assert.equal(meetingLink('https://calendar.google.com.cobalt-union.dev/calendar/event', 'calendar'), null);
  assert.equal(meetingLink('https://calendar.google.com/calendar/u/0/r/eventedit/fixture', 'calendar'), 'https://calendar.google.com/calendar/u/0/r/eventedit/fixture');
});
