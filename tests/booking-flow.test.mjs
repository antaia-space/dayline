// A guest books, reschedules and cancels through the public page, end to end:
// guest request → receiver → booking page object → this Mac → src/google.mjs →
// a stand-in Google. Nothing here is mocked between the guest and the calendar
// except the network itself.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRelay } from '../relay/receiver.mjs';
import { BookingBoard } from '../relay/booking.mjs';
import { BookingDesk } from '../src/booking-relay.mjs';
import { DaylineService } from '../src/service.mjs';
import { defaultBooking } from '../src/booking-service.mjs';
import { defaultSettings } from '../src/store.mjs';
import { zonedToUtcMs } from '../src/booking-slots.mjs';
import { fakeGoogle } from './fake-google.mjs';

const LA = 'America/Los_Angeles', MINUTE = 60_000, HOUR = 60 * MINUTE;
const client = 'test-app.apps.googleusercontent.com', origin = 'https://book.example.invalid';
const secret = 'Synthetic receiver secret reserved for this test only';
const scopes = name => ['openid', 'email', ...name.map(s => 'https://www.googleapis.com/auth/' + s)].join(' ');
const readOnly = scopes(['calendar.calendarlist.readonly', 'calendar.events.freebusy']);
const withEvents = scopes(['calendar.calendarlist.readonly', 'calendar.events.freebusy', 'calendar.events']);
// Monday 23 November 2026, 08:00 in Los Angeles.
const monday = (hour, minute = 0, day = 23) => zonedToUtcMs(2026, 11, day, hour, minute, LA);
const iso = ms => new Date(ms).toISOString();

class MemoryStore {
  constructor(state) { this.state = structuredClone(state); }
  save() { this.saved = structuredClone(this.state); }
}

async function world(t, { asleep = false } = {}) {
  let time = monday(8);
  const pair = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'k', alg: 'RS256', use: 'sig' }] });
  const accounts = [
    { key: 'work', refresh: 'refresh-work', sub: 'sub-work', email: 'urs@antaia.space', scope: withEvents,
      calendars: [{ id: 'urs@antaia.space', summary: 'Work', primary: true, accessRole: 'owner' }],
      // Tuesday 10:00–11:00: a meeting whose title this test never gives to anything but Google.
      busy: [{ start: iso(monday(10, 0, 24)), end: iso(monday(11, 0, 24)) }] },
    { key: 'home', refresh: 'refresh-home', sub: 'sub-home', email: 'urs@example.test', scope: readOnly,
      calendars: [{ id: 'urs@example.test', summary: 'Private', primary: true, accessRole: 'owner' }],
      // Tuesday 14:00–15:00: a private appointment that may only block time.
      busy: [{ start: iso(monday(14, 0, 24)), end: iso(monday(15, 0, 24)) }] },
  ];
  const google = fakeGoogle({ accounts, clientId: client, identity: account => new SignJWT({ sub: account.sub, email: account.email,
    email_verified: true, hd: account.email.endsWith('@antaia.space') ? 'antaia.space' : undefined, iss: 'https://accounts.google.com', aud: client,
    iat: Math.floor(time / 1000), exp: Math.floor(time / 1000) + 3600 }).setProtectedHeader({ alg: 'RS256', kid: 'k' }).sign(pair.privateKey) });
  const realFetch = globalThis.fetch;
  globalThis.fetch = google.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  // The receiver, with in-memory stand-ins for its two kinds of Durable Object.
  const boards = new Map(), stored = new Map(), signals = [];
  let desk;
  const state = { awake: !asleep };
  const env = {
    GOOGLE_CLIENT_ID: client, RELAY_SECRET: secret,
    STREAMS: { idFromName: id => id, get: id => ({ async fetch(request) {
      signals.push(new URL(request.url).pathname + ' ' + id);
      if (state.awake) state.pending = desk.wake();
      return new Response(null, { status: 204 });
    } }) },
    PAGES: { idFromName: name => name, get: name => ({ async fetch(request) {
      if (!boards.has(name)) {
        const storage = { get: async key => structuredClone(stored.get(name + '/' + key)), put: async (key, value) => void stored.set(name + '/' + key, structuredClone(value)),
          delete: async key => void stored.delete(name + '/' + key) };
        boards.set(name, new BookingBoard({ storage, secret: new TextEncoder().encode(secret), now: () => time,
          signal: stream => env.STREAMS.get(stream).fetch(new Request('https://device.internal/signal', { method: 'POST' })) }));
      }
      return Response.json(await boards.get(name).handle(await request.json()));
    } }) },
  };
  const relay = createRelay({ keys, now: () => time });
  const guest = async (method, path, body, ip = '203.0.113.7') => {
    const response = await relay(new Request(origin + path, { method, headers: { 'CF-Connecting-IP': ip, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body) }), env);
    return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) };
  };

  // This Mac: two connected accounts. Only the work account may write events.
  const booking = { ...defaultBooking(), enabled: true, owner: { name: 'Urs Wilcke', headline: 'Antaia' } };
  const store = new MemoryStore({ version: 1, tasks: [], lastSync: null, agent: { provider: 'local' },
    settings: { ...defaultSettings(), timeZone: LA },
    client: JSON.stringify({ clientId: client, clientSecret: '' }),
    accounts: [{ sub: 'sub-work', email: 'urs@antaia.space', secret: 'refresh-work', mode: 'availability', meetingDetails: false, booking: true },
      { sub: 'sub-home', email: 'urs@example.test', secret: 'refresh-home', mode: 'availability', meetingDetails: false }],
    calendarPush: { deviceId: 'd'.repeat(43), channels: [] }, booking });
  const service = new DaylineService({ store, vault: { seal: async value => value, open: async value => value }, clock: () => new Date(time) });
  await service.discover();
  const work = service.calendars.find(c => c.sub === 'sub-work');
  Object.assign(service.data.booking, { calendarId: work.id, accountSub: work.sub });
  desk = new BookingDesk({ service, origin, now: () => time, fetch: (url, init) => relay(new Request(url, init), env), onBooked: () => {} });
  const wake = async () => { await desk.wake(); await state.pending; };
  return { google, guest, service, desk, wake, state, signals, stored, boards, advance: ms => { time += ms; }, now: () => time,
    async book(start, type = 'meeting', extra = {}) {
      const answer = await guest('POST', '/api/urs/book', { type, start, name: 'Ada Guest', email: 'ada@example.test', timeZone: 'Europe/Zurich',
        notes: 'About the <b>engine</b>', ...extra });
      await state.pending;
      return answer;
    } };
}

test('a guest books, reschedules and cancels while the Mac is awake', async t => {
  const w = await world(t);
  await w.wake();
  assert.equal(w.desk.status().state, 'live');
  assert.equal(w.desk.status().url, origin + '/urs');

  // The public page lists the visible types; the hidden one answers only on its own link.
  const page = await w.guest('GET', '/api/urs/page');
  assert.deepEqual(page.body.types.map(type => type.slug), ['intro', 'meeting', 'deep-dive']);
  assert.equal(page.body.owner.name, 'Urs Wilcke');
  assert.equal((await w.guest('GET', '/api/urs/slots/private')).body.type.title, 'Private call');
  assert.equal((await w.guest('GET', '/urs/meeting')).status, 200);

  // Tuesday: 12 hours of notice hide Monday; the work meeting and the private
  // appointment block their times plus the 15-minute gap on either side.
  const { slots } = (await w.guest('GET', '/api/urs/slots/meeting')).body;
  const tuesday = slots.filter(ms => ms < monday(0, 0, 25));
  const at = (hour, minute = 0) => monday(hour, minute, 24);
  assert.deepEqual(tuesday, [at(9), at(11, 30), at(12), at(12, 30), at(13), at(15, 30), at(16), at(16, 30)]);

  // Booking: the receiver holds the time, signals the Mac, and the Mac writes the event.
  const booked = await w.book(at(12));
  assert.equal(booked.status, 202);
  assert.deepEqual(w.signals, ['/signal ' + w.signals[0].split(' ')[1]]);
  const { token } = booked.body, id = token.slice(0, 24);
  const status = await w.guest('GET', '/api/urs/booking/' + token);
  assert.deepEqual([status.body.status, status.body.start, status.body.end], ['confirmed', at(12), at(12, 30)]);
  const event = w.google.events.get('bkb' + id);
  assert.ok(event, 'the event id carries the wiki prefix and the request id');
  assert.equal(event.calendar, 'urs@antaia.space');
  assert.equal(event.summary, 'Meeting: Ada Guest and Urs Wilcke');
  assert.deepEqual([event.start.dateTime, event.end.dateTime], [iso(at(12)), iso(at(12, 30))]);
  assert.deepEqual(event.attendees, [{ email: 'urs@antaia.space', responseStatus: 'accepted' }, { email: 'ada@example.test', displayName: 'Ada Guest' }]);
  assert.deepEqual(event.conferenceData, { createRequest: { requestId: 'bkb' + id, conferenceSolutionKey: { type: 'hangoutsMeet' } } });
  assert.deepEqual(event.extendedProperties.private, { booking: '1', type: 'meeting', name: 'Ada Guest', email: 'ada@example.test', tz: 'Europe/Zurich' });
  assert.deepEqual([event.sendUpdates, event.conferenceDataVersion, event.guestsCanModify], ['all', '1', false]);
  assert.ok(event.description.includes('<a href="' + origin + '/urs/booking/' + token + '">Reschedule or cancel</a>'));
  assert.ok(event.description.includes('About the &lt;b&gt;engine&lt;/b&gt;'), 'guest notes cannot add markup to the calendar');

  // The Bookings tab on the Mac lists who booked, read from Google Calendar.
  assert.deepEqual(w.desk.upcoming, [{ id: 'bkb' + id, type: 'Meeting', start: at(12), end: at(12, 30), name: 'Ada Guest', email: 'ada@example.test', address: 'urs@antaia.space' }]);

  // Once the Mac has answered, the receiver keeps no guest details.
  const ledger = w.stored.get('urs/ledger');
  assert.deepEqual(ledger[id], { id, type: 'meeting', start: at(12), end: at(12, 30), status: 'confirmed', createdAt: w.now(), handed: true, confirmedAt: w.now() });
  assert.ok(!JSON.stringify([...w.stored.values()]).includes('ada@example.test'));

  // The same time, and the gap around it, is gone for everyone.
  assert.equal((await w.book(at(12), 'meeting', { email: 'bob@example.test', name: 'Bob Guest' })).status, 409);
  const after = (await w.guest('GET', '/api/urs/slots/meeting')).body.slots.filter(ms => ms < monday(0, 0, 25));
  assert.deepEqual(after, [at(9), at(13), at(15, 30), at(16), at(16, 30)]);

  // Reschedule to 16:00 from the signed link.
  assert.equal((await w.guest('POST', '/api/urs/booking/' + token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A') + '/reschedule', { start: at(16) })).status, 404);
  const moved = await w.guest('POST', '/api/urs/booking/' + token + '/reschedule', { start: at(16) });
  await w.state.pending;
  assert.equal(moved.status, 200);
  assert.deepEqual([event.start.dateTime, event.end.dateTime, event.sendUpdates], [iso(at(16)), iso(at(16, 30)), 'all']);
  const movedStatus = (await w.guest('GET', '/api/urs/booking/' + token)).body;
  assert.deepEqual([movedStatus.status, movedStatus.start, movedStatus.change], ['confirmed', at(16), null]);
  await w.wake();
  assert.ok((await w.guest('GET', '/api/urs/slots/meeting')).body.slots.includes(at(12)), 'the old time is offered again');

  // Cancel: Google deletes the event and mails the guest.
  const cancelled = await w.guest('POST', '/api/urs/booking/' + token + '/cancel', {});
  await w.state.pending;
  assert.equal(cancelled.status, 200);
  assert.equal(w.google.events.size, 0);
  assert.equal(w.google.requests.findLast(r => r.method === 'DELETE').query.sendUpdates, 'all');
  assert.equal((await w.guest('GET', '/api/urs/booking/' + token)).body.status, 'cancelled');

  // A type whose notes stay out of the wiki gets the other prefix.
  const confidential = await w.book(at(9), 'private');
  assert.ok(w.google.events.has('bkp' + confidential.body.token.slice(0, 24)));

  // The private account was only ever asked for free/busy.
  const home = w.google.requests.filter(r => r.body.includes('urs@example.test') || r.path.includes('urs%40example.test'));
  assert.ok(home.length > 0 && home.every(r => r.path.endsWith('/freeBusy')));
});

test('a request waits while the Mac sleeps and is confirmed when it wakes', async t => {
  const w = await world(t);
  await w.wake();
  w.state.awake = false;
  const at = (hour, minute = 0) => monday(hour, minute, 25);

  const first = await w.book(at(10));
  assert.deepEqual([first.status, first.body.status], [202, 'pending']);
  assert.equal(w.google.events.size, 0);
  // The held time is refused to a second guest although no event exists yet.
  assert.equal((await w.book(at(10), 'meeting', { email: 'bob@example.test', name: 'Bob Guest' })).status, 409);
  // The same guest sending the form twice gets the same request back.
  assert.equal((await w.book(at(10))).body.token, first.body.token);

  w.advance(9 * HOUR);
  assert.equal((await w.guest('GET', '/api/urs/booking/' + first.body.token)).body.status, 'pending');
  await w.wake();
  assert.equal((await w.guest('GET', '/api/urs/booking/' + first.body.token)).body.status, 'confirmed');
  assert.ok(w.google.events.has('bkb' + first.body.token.slice(0, 24)));
  assert.equal(w.desk.status().waiting, 0);
});

test('a held time that the calendar took meanwhile is declined on wake and reported to the owner', async t => {
  const w = await world(t);
  await w.wake();
  w.state.awake = false;
  const at = (hour, minute = 0) => monday(hour, minute, 25);
  const request = await w.book(at(13));
  w.google.occupy('work', iso(at(13)), iso(at(14)));

  await w.wake();
  const status = (await w.guest('GET', '/api/urs/booking/' + request.body.token)).body;
  assert.deepEqual([status.status, status.note], ['declined', 'taken']);
  assert.equal(w.google.events.size, 0);
  assert.deepEqual(w.service.data.booking.notices.map(({ kind, reason, name, email, type, start }) => [kind, reason, name, email, type, start]),
    [['declined', 'taken', 'Ada Guest', 'ada@example.test', 'Meeting', iso(at(13))]]);
  assert.ok(!JSON.stringify([...w.stored.values()]).includes('ada@example.test'));
  assert.ok(!(await w.guest('GET', '/api/urs/slots/meeting')).body.slots.includes(at(13)));

  // A request the Mac reaches too late lapses instead of landing minutes before its start.
  const late = await w.book(at(16));
  w.advance(at(16) - 20 * MINUTE - w.now());
  assert.equal((await w.guest('GET', '/api/urs/booking/' + late.body.token)).body.status, 'expired');
  await w.wake();
  assert.equal(w.google.events.size, 0);
  assert.deepEqual(w.service.data.booking.notices.map(n => n.kind), ['declined', 'expired']);
});

test('the page pauses when Google access ends and clears when booking is switched off', async t => {
  const w = await world(t);
  await w.wake();
  assert.ok((await w.guest('GET', '/api/urs/slots/meeting')).body.slots.length > 0);

  // For example an External client in Testing, seven days after sign-in.
  w.google.revoke('refresh-work');
  w.service.tokens.clear();
  await w.desk.changed();
  assert.equal(w.desk.status().state, 'paused');
  const paused = (await w.guest('GET', '/api/urs/slots/meeting')).body;
  assert.deepEqual([paused.open, paused.slots], [false, []]);
  assert.equal((await w.book(monday(12, 0, 25))).status, 409);

  w.service.data.booking.enabled = false;
  await w.desk.changed();
  assert.equal(w.desk.status().state, 'off');
  assert.equal((await w.guest('GET', '/api/urs/page')).status, 404);
  assert.equal(w.stored.size, 0);
});
