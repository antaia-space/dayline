// The requests a booking sends to Google Calendar, checked against a recorder in place of the network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationUrl, bookingDescription, cancelBookingEvent, createBookingEvent, getBookingEvent, listBookingEvents, moveBookingEvent, refreshToken } from '../src/google.mjs';

const token = 'test-access', calendarId = 'urs@antaia.space';
const eventId = 'bkb' + '0123456789abcdefghijklmn';
const start = Date.parse('2026-11-24T17:00:00Z'), end = Date.parse('2026-11-24T17:30:00Z');
const guest = { name: 'Ada Guest', email: 'ada@example.test', timeZone: 'Europe/Zurich' };
const scopes = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.freebusy', 'https://www.googleapis.com/auth/calendar.events'];
const reply = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status });
const failure = (status, reason) => reply({ error: { code: status, message: reason, errors: [{ reason }] } }, status);
const event = (overrides = {}) => ({ id: eventId, etag: '"1"', status: 'confirmed', start: { dateTime: '2026-11-24T17:00:00Z' }, end: { dateTime: '2026-11-24T17:30:00Z' },
  extendedProperties: { private: { booking: '1', type: 'meeting', name: guest.name, email: guest.email, tz: guest.timeZone } }, ...overrides });
const booked = { eventId, type: 'meeting', start, end, name: guest.name, email: guest.email, timeZone: guest.timeZone };

function simulate(t, ...handlers) {
  let index = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const handler = handlers[index++];
    assert.ok(handler, 'Unexpected request to ' + new URL(url).pathname);
    return typeof handler === 'function' ? handler(new URL(url), init) : handler;
  });
  t.after(() => assert.equal(index, handlers.length));
}

test('booking access asks for event writes and nothing beyond the sync permissions', async t => {
  const url = new URL(authorizationUrl({ clientId: 'client', redirectUri: 'http://127.0.0.1:43127/oauth/callback', state: 's', codeChallenge: 'c',
    mode: 'booking', loginHint: 'urs@antaia.space' }));
  assert.deepEqual(new Set(url.searchParams.get('scope').split(' ')), new Set(scopes));
  assert.equal(url.searchParams.get('login_hint'), 'urs@antaia.space');
  simulate(t, (endpoint, init) => {
    assert.deepEqual(new Set(init.body.get('scope').split(' ')), new Set(scopes));
    return reply({ access_token: token, expires_in: 3600, scope: scopes.join(' ') });
  }, reply({ access_token: token, expires_in: 3600, scope: scopes.slice(0, 4).join(' ') }));
  assert.equal((await refreshToken({ clientId: 'client', refreshToken: 'r', mode: 'booking' })).access_token, token);
  await assert.rejects(refreshToken({ clientId: 'client', refreshToken: 'r', mode: 'booking' }), { reason: 'insufficientScopes' });
});

test('a booking is one event with a Meet link, the guest invited by Google, and a chosen id', async t => {
  simulate(t, (url, init) => {
    assert.equal(url.pathname, '/calendar/v3/calendars/urs%40antaia.space/events');
    assert.deepEqual([init.method, url.searchParams.get('sendUpdates'), url.searchParams.get('conferenceDataVersion')], ['POST', 'all', '1']);
    assert.equal(init.headers.Authorization, 'Bearer ' + token);
    assert.deepEqual(JSON.parse(init.body), {
      id: eventId, summary: 'Meeting: Ada Guest and Urs Wilcke', description: 'd',
      start: { dateTime: '2026-11-24T17:00:00.000Z' }, end: { dateTime: '2026-11-24T17:30:00.000Z' },
      attendees: [{ email: 'urs@antaia.space', responseStatus: 'accepted' }, { email: 'ada@example.test', displayName: 'Ada Guest' }],
      conferenceData: { createRequest: { requestId: eventId, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      extendedProperties: { private: { booking: '1', type: 'meeting', name: 'Ada Guest', email: 'ada@example.test', tz: 'Europe/Zurich' } },
      guestsCanModify: false, reminders: { useDefault: true },
    });
    return reply(event());
  });
  assert.deepEqual(await createBookingEvent(token, { calendarId, eventId, title: 'Meeting: Ada Guest and Urs Wilcke', description: 'd', start, end,
    ownerEmail: 'urs@antaia.space', guest, type: 'meeting' }), booked);
});

test('a repeated insert adopts the event already made; a foreign event with that id is never adopted', async t => {
  const input = { calendarId, eventId, title: 'T', description: 'd', start, end, ownerEmail: 'ada@example.test', guest, type: 'meeting' };
  simulate(t, (_url, init) => {
    // The owner booking their own page is not listed twice.
    assert.deepEqual(JSON.parse(init.body).attendees, [{ email: 'ada@example.test', displayName: 'Ada Guest' }]);
    return failure(409, 'duplicate');
  }, reply(event()), failure(409, 'duplicate'), reply(event({ extendedProperties: {} })));
  assert.deepEqual(await createBookingEvent(token, input), booked);
  await assert.rejects(createBookingEvent(token, input), { status: 409 });
});

test('ids outside the booking format never reach Google', async t => {
  simulate(t);
  for (const id of ['abc', 'bkx' + '0'.repeat(24), 'bkb' + 'W'.repeat(24), '0123456789abcdeffedcba9876543210', 'bkb' + '0'.repeat(24) + '/../x']) {
    await assert.rejects(getBookingEvent(token, { calendarId, eventId: id }), { reason: 'invalidEventId' });
    await assert.rejects(cancelBookingEvent(token, { calendarId, eventId: id }), { reason: 'invalidEventId' });
    await assert.rejects(moveBookingEvent(token, { calendarId, eventId: id, start, end }), { reason: 'invalidEventId' });
  }
});

test('move and cancel notify the guest through Google and tolerate an event that is already gone', async t => {
  simulate(t,
    (url, init) => {
      assert.equal(url.pathname, '/calendar/v3/calendars/urs%40antaia.space/events/' + eventId);
      assert.deepEqual([init.method, url.searchParams.get('sendUpdates')], ['PATCH', 'all']);
      assert.deepEqual(JSON.parse(init.body), { start: { dateTime: '2026-11-24T18:00:00.000Z' }, end: { dateTime: '2026-11-24T18:30:00.000Z' } });
      return reply(event({ start: { dateTime: '2026-11-24T10:00:00', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-11-24T10:30:00', timeZone: 'America/Los_Angeles' } }));
    },
    (url, init) => {
      assert.deepEqual([init.method, url.searchParams.get('sendUpdates')], ['DELETE', 'all']);
      return reply(null, 204);
    },
    failure(410, 'deleted'), failure(404, 'notFound'), reply(event({ status: 'cancelled' })), failure(403, 'forbidden'));
  const hour = 3_600_000;
  assert.deepEqual(await moveBookingEvent(token, { calendarId, eventId, start: start + hour, end: end + hour }), { ...booked, start: start + hour, end: end + hour });
  await cancelBookingEvent(token, { calendarId, eventId });
  await cancelBookingEvent(token, { calendarId, eventId });
  assert.equal(await getBookingEvent(token, { calendarId, eventId }), null);
  assert.equal(await getBookingEvent(token, { calendarId, eventId }), null);
  await assert.rejects(getBookingEvent(token, { calendarId, eventId }), { status: 403 });
});

test('listing asks only for marked events and returns no titles or guests lists', async t => {
  simulate(t, url => {
    assert.equal(url.searchParams.get('privateExtendedProperty'), 'booking=1');
    assert.equal(url.searchParams.get('timeMin'), '2026-11-23T16:00:00.000Z');
    assert.equal(url.searchParams.get('fields'), 'kind,nextPageToken,items(id,etag,status,start,end,extendedProperties/private)');
    return reply({ kind: 'calendar#events', items: [event(), event({ id: 'bkp' + 'v'.repeat(24) }), event({ id: 'someone-elses' }), event({ status: 'cancelled' })] });
  });
  const listed = await listBookingEvents(token, { calendarId, timeMin: '2026-11-23T16:00:00.000Z' });
  assert.deepEqual(listed.map(b => b.eventId), [eventId, 'bkp' + 'v'.repeat(24)]);
});

test('what a guest typed cannot add markup or links to the calendar', () => {
  const html = bookingDescription({ about: 'A <call>', guest: { name: '<img src=x>', email: 'a@b.cd' }, notes: 'line one\n<a href="https://evil.example">click</a>',
    manageUrl: 'https://book.example.invalid/urs/booking/' + 'a'.repeat(24) + '.' + 'S'.repeat(27) });
  assert.equal(html, 'A &lt;call&gt;<br><br>Booked by &lt;img src=x&gt; (a@b.cd).<br><br>Notes from &lt;img src=x&gt;:<br>line one<br>&lt;a href=&quot;https://evil.example&quot;&gt;click&lt;/a&gt;' +
    '<br><br><a href="https://book.example.invalid/urs/booking/' + 'a'.repeat(24) + '.' + 'S'.repeat(27) + '">Reschedule or cancel</a>');
  assert.throws(() => bookingDescription({ guest, manageUrl: 'javascript:alert(1)' }), { reason: 'invalidActionUrl' });
});
