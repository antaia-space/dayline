// The public booking page on the receiver: what it accepts, what it stores,
// and when it deletes it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRelay } from '../relay/receiver.mjs';
import { BookingBoard, KEEP_CLOSED, KEEP_PAGE, KEEP_UNCOLLECTED, MAX_WAITING, newRequestId, signToken, STALE_AFTER, verifyToken } from '../relay/booking.mjs';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const start = Date.parse('2026-11-23T16:00:00Z');
const secret = new TextEncoder().encode('Synthetic receiver secret reserved for this test only');
const stream = 's'.repeat(43);
const meeting = { slug: 'meeting', title: 'Meeting', description: 'A regular working call.', durationMin: 30, bufferMin: 15, minNoticeMin: 60, maxDaysAhead: 45, hidden: false };
const quiet = { slug: 'private', title: 'Private call', description: '', durationMin: 30, bufferMin: 0, minNoticeMin: 0, maxDaysAhead: 45, hidden: true };
const slot = n => start + DAY + n * 30 * MINUTE;
const page = (extra = {}) => ({ owner: { name: 'Urs Wilcke', headline: 'Antaia' }, types: [meeting, quiet],
  slots: { meeting: [slot(0), slot(1), slot(2), slot(3), slot(4)], private: [slot(0), slot(1), slot(2)] }, paused: null, ...extra });
const guestInput = (at, extra = {}) => ({ type: 'meeting', start: at, name: 'Ada Guest', email: 'Ada@Example.test', timeZone: 'Europe/Zurich', notes: 'Hello', ...extra });

function board() {
  const stored = new Map(), signals = [];
  let time = start;
  const storage = { get: async key => structuredClone(stored.get(key)), put: async (key, value) => void stored.set(key, structuredClone(value)),
    delete: async key => void stored.delete(key) };
  const instance = new BookingBoard({ storage, secret, now: () => time, signal: async id => void signals.push(id) });
  const call = (op, extra = {}) => instance.handle({ op, handle: 'urs', ip: '203.0.113.7', ...extra });
  return { stored, signals, call, instance, advance: ms => { time += ms; }, now: () => time,
    publish: (extra = {}) => call('sync', { streamId: stream, input: { page: page(), bookings: [], ...extra } }),
    book: (at, extra = {}, ip) => call('book', { input: guestInput(at, extra), ...(ip && { ip }) }) };
}

test('manage tokens verify only for the right page, secret and an untouched id', async () => {
  const id = newRequestId();
  assert.match(id, /^[0-9a-v]{24}$/);
  const token = await signToken(id, 'urs', secret);
  assert.match(token, /^[0-9a-v]{24}\.[A-Za-z0-9_-]{27}$/);
  assert.equal(await verifyToken(token, 'urs', secret), id);
  assert.equal(await verifyToken(token, 'someone-else', secret), null);
  assert.equal(await verifyToken(token, 'urs', new TextEncoder().encode('another secret of sufficient length here')), null);
  const other = (id[0] === '0' ? '1' : '0') + token.slice(1);
  assert.equal(await verifyToken(other, 'urs', secret), null);
  assert.equal(await verifyToken('no-dot', 'urs', secret), null);
  assert.equal(await verifyToken(undefined, 'urs', secret), null);
});

test('the page offers published times, holds a requested one, and stores only the listed fields', async () => {
  const b = board();
  assert.equal((await b.call('page')).status, 404);
  assert.deepEqual((await b.publish()).body, { requests: [], waiting: 0, publishedAt: start });

  // Hidden types stay off the index; internal settings are not shown to guests.
  const index = (await b.call('page')).body;
  assert.deepEqual(index, { owner: { name: 'Urs Wilcke', headline: 'Antaia' }, open: true,
    types: [{ slug: 'meeting', title: 'Meeting', description: 'A regular working call.', durationMin: 30, maxDaysAhead: 45 }] });
  assert.equal((await b.call('slots', { slug: 'private' })).body.slots.length, 3);
  assert.equal((await b.call('slots', { slug: 'missing' })).status, 404);

  const booked = await b.book(slot(1));
  assert.equal(booked.status, 202);
  assert.deepEqual([booked.body.status, booked.body.start, booked.body.end], ['pending', slot(1), slot(2)]);
  assert.deepEqual(b.signals, [stream]);
  const id = booked.body.token.slice(0, 24);
  assert.deepEqual(b.stored.get('ledger'), { [id]: { id, type: 'meeting', start: slot(1), end: slot(2), status: 'pending', createdAt: start,
    expiresAt: slot(1) - 30 * MINUTE, guest: { name: 'Ada Guest', email: 'ada@example.test', timeZone: 'Europe/Zurich', notes: 'Hello' } } });
  assert.deepEqual(Object.keys(b.stored.get('page')).sort(), ['owner', 'paused', 'publishedAt', 'slots', 'streamId', 'types']);

  // The held time and its gap are gone for every type; a type without a gap keeps its neighbours.
  assert.deepEqual((await b.call('slots', { slug: 'meeting' })).body.slots, [slot(3), slot(4)]);
  assert.deepEqual((await b.call('slots', { slug: 'private' })).body.slots, [slot(0), slot(2)]);
  assert.equal((await b.book(slot(1), { email: 'bob@example.test' })).status, 409);
  assert.equal((await b.book(slot(1))).body.token, booked.body.token);

  // The Mac collects the request with the guest's details and the signed link token.
  const handed = (await b.call('sync', { streamId: stream, input: {} })).body.requests;
  assert.deepEqual(handed, [{ kind: 'book', id, token: booked.body.token, type: 'meeting', start: slot(1), end: slot(2),
    guest: { name: 'Ada Guest', email: 'ada@example.test', timeZone: 'Europe/Zurich', notes: 'Hello' }, createdAt: start, expired: false }]);
  await b.call('sync', { streamId: stream, input: { outcomes: [{ id, kind: 'book', ok: true, start: slot(1), end: slot(2) }] } });
  assert.deepEqual(b.stored.get('ledger')[id], { id, type: 'meeting', start: slot(1), end: slot(2), status: 'confirmed', createdAt: start, handed: true, confirmedAt: start });
});

test('guest input is validated and bounded before anything is stored', async () => {
  const b = board();
  await b.publish();
  const refused = async (extra, status) => assert.equal((await b.book(slot(0), extra)).status, status, JSON.stringify(extra));
  await refused({ name: 'A' }, 400);
  await refused({ email: 'not-an-address' }, 400);
  await refused({ timeZone: 'Mars/Olympus' }, 400);
  await refused({ start: 'soon' }, 400);
  await refused({ type: 'missing' }, 404);
  await refused({ website: 'https://spam.example' }, 400);
  await refused({ start: slot(0) + MINUTE }, 409);
  assert.equal(b.stored.has('ledger'), false);
  const long = await b.book(slot(0), { name: 'N'.repeat(500), notes: 'x'.repeat(5000) });
  const record = Object.values(b.stored.get('ledger'))[0];
  assert.deepEqual([long.status, record.guest.name.length, record.guest.notes.length], [202, 100, 2000]);
});

test('one address and one sleeping Mac cannot be used to hold every time', async () => {
  const b = board();
  const many = Array.from({ length: 40 }, (_, i) => start + DAY + i * HOUR);
  await b.publish({ page: page({ slots: { meeting: many, private: [] } }) });
  for (let i = 0; i < 6; i++) assert.equal((await b.book(many[i], { email: 'g' + i + '@example.test' })).status, 202);
  assert.equal((await b.book(many[6], { email: 'g6@example.test' })).status, 429);
  for (let i = 6; i < MAX_WAITING; i++) assert.equal((await b.book(many[i], { email: 'g' + i + '@example.test' }, '198.51.100.' + i)).status, 202);
  assert.equal((await b.book(many[20], { email: 'late@example.test' }, '198.51.100.99')).status, 503);
});

test('a stale or paused page offers nothing', async () => {
  const b = board();
  await b.publish();
  b.advance(STALE_AFTER - MINUTE);
  assert.equal((await b.call('slots', { slug: 'private' })).body.open, true);
  b.advance(2 * MINUTE);
  const stale = (await b.call('slots', { slug: 'private' })).body;
  assert.deepEqual([stale.open, stale.slots], [false, []]);
  await b.publish({ page: page({ paused: 'reconnect' }) });
  assert.deepEqual((await b.call('slots', { slug: 'meeting' })).body.slots, []);
  // Minimum notice keeps counting on the receiver while a snapshot ages.
  const aging = board();
  await aging.publish();
  aging.advance(DAY - 30 * MINUTE);
  assert.deepEqual((await aging.call('slots', { slug: 'meeting' })).body.slots, [slot(1), slot(2), slot(3), slot(4)]);
});

test('reschedule and cancel queue for the Mac and settle from its answers', async () => {
  const b = board();
  await b.publish();
  const { token } = (await b.book(slot(0))).body, id = token.slice(0, 24);
  const sync = input => b.call('sync', { streamId: stream, input }).then(answer => answer.body.requests);

  // Before the Mac has seen it, a request simply changes its time.
  assert.equal((await b.call('reschedule', { token, input: { start: slot(4) } })).body.start, slot(4));
  assert.deepEqual((await sync({})).map(r => [r.kind, r.start]), [['book', slot(4)]]);
  await sync({ outcomes: [{ id, kind: 'book', ok: true, start: slot(4), end: slot(4) + 30 * MINUTE }] });

  // After confirmation a move waits for the Mac; both times stay held meanwhile.
  await b.publish({ bookings: [{ id, type: 'meeting', start: slot(4), end: slot(4) + 30 * MINUTE }] });
  const moving = (await b.call('reschedule', { token, input: { start: slot(0) } })).body;
  assert.deepEqual([moving.status, moving.start, moving.change], ['confirmed', slot(4), { kind: 'move', start: slot(0), end: slot(1) }]);
  assert.deepEqual((await b.call('slots', { slug: 'private' })).body.slots, [slot(1), slot(2)]);
  assert.deepEqual(await sync({}), [{ kind: 'move', id, token, start: slot(0), end: slot(1) }]);
  // A refusal leaves the meeting where it was and says so.
  await sync({ outcomes: [{ id, kind: 'move', ok: false, start: slot(0), end: slot(1) }] });
  const kept = (await b.call('status', { token })).body;
  assert.deepEqual([kept.start, kept.change, kept.note], [slot(4), null, 'move-declined']);
  await b.call('reschedule', { token, input: { start: slot(1) } });
  await sync({ outcomes: [{ id, kind: 'move', ok: true, start: slot(1), end: slot(2) }] });
  assert.deepEqual([(await b.call('status', { token })).body.start, (await b.call('status', { token })).body.note], [slot(1), null]);

  // Cancel waits for the Mac to delete the event.
  const leaving = (await b.call('cancel', { token })).body;
  assert.deepEqual([leaving.status, leaving.change.kind], ['confirmed', 'cancel']);
  assert.equal((await b.call('reschedule', { token, input: { start: slot(3) } })).status, 409);
  assert.deepEqual(await sync({}), [{ kind: 'cancel', id }]);
  await sync({ outcomes: [{ id, kind: 'cancel', ok: true }] });
  assert.equal((await b.call('status', { token })).body.status, 'cancelled');
  assert.equal((await b.call('status', { token: token.slice(0, 25) + 'A'.repeat(27) })).status, 404);
});

test('a guest who cancels while the Mac is creating the event still gets it removed', async () => {
  const b = board();
  await b.publish();
  const { token } = (await b.book(slot(0))).body, id = token.slice(0, 24);
  await b.call('sync', { streamId: stream, input: {} });
  assert.equal((await b.call('cancel', { token })).body.status, 'cancelled');
  const next = (await b.call('sync', { streamId: stream, input: { outcomes: [{ id, kind: 'book', ok: true, start: slot(0), end: slot(1) }] } })).body.requests;
  assert.deepEqual(next, [{ kind: 'cancel', id }]);
});

test('Google Calendar corrects the copy when the owner moves or deletes a booked meeting', async () => {
  const b = board();
  await b.publish();
  const { token } = (await b.book(slot(0))).body, id = token.slice(0, 24);
  await b.call('sync', { streamId: stream, input: { outcomes: [{ id, kind: 'book', ok: true, start: slot(0), end: slot(1) }] } });
  // Right after confirmation an incomplete list from Google is not taken as a deletion.
  await b.publish({ bookings: [] });
  assert.equal((await b.call('status', { token })).body.status, 'confirmed');
  b.advance(5 * MINUTE);
  await b.publish({ bookings: [{ id, type: 'meeting', start: slot(3), end: slot(4) }] });
  assert.equal((await b.call('status', { token })).body.start, slot(3));
  await b.publish({ bookings: [] });
  const gone = (await b.call('status', { token })).body;
  assert.deepEqual([gone.status, gone.note], ['cancelled', 'removed']);
  // A booking the receiver has no record of is taken from the calendar, so its link keeps working.
  const known = newRequestId();
  await b.publish({ bookings: [{ id: known, type: 'meeting', start: slot(2), end: slot(3) }] });
  assert.equal((await b.call('status', { token: await signToken(known, 'urs', secret) })).body.status, 'confirmed');
});

test('stored data is deleted on schedule', async () => {
  const b = board();
  await b.publish();
  const waiting = (await b.book(slot(0))).body.token, done = (await b.book(slot(2), { email: 'bob@example.test' })).body.token;
  await b.call('sync', { streamId: stream, input: { outcomes: [{ id: done.slice(0, 24), kind: 'book', ok: true, start: slot(2), end: slot(3) }] } });

  // A request lapses for the guest 30 minutes before its start, and frees the time.
  b.advance(slot(0) - 29 * MINUTE - b.now());
  assert.equal((await b.call('status', { token: waiting })).body.status, 'expired');
  // The Mac still learns who asked, so the owner can write to them.
  const late = (await b.call('sync', { streamId: stream, input: {} })).body.requests;
  assert.deepEqual([late[0].expired, late[0].guest.email], [true, 'ada@example.test']);

  // A confirmed meeting's record goes when the meeting has ended.
  b.advance(slot(3) + MINUTE - b.now());
  await b.instance.expire();
  assert.deepEqual(Object.keys(b.stored.get('ledger')), [waiting.slice(0, 24)]);

  // Details the Mac never collected go after seven days; the bare record a week later.
  b.advance(KEEP_UNCOLLECTED);
  await b.instance.expire();
  const lapsed = b.stored.get('ledger')[waiting.slice(0, 24)];
  assert.deepEqual([lapsed.status, lapsed.guest], ['expired', undefined]);
  b.advance(KEEP_CLOSED + MINUTE);
  assert.equal(typeof await b.instance.expire(), 'number');
  assert.equal(b.stored.has('ledger'), false);

  // A page whose Mac never came back is deleted too.
  b.advance(KEEP_PAGE);
  assert.equal(await b.instance.expire(), null);
  assert.equal(b.stored.size, 0);
});

test('only the signed-in Workspace member can publish their own page', async () => {
  const pair = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'k', alg: 'RS256', use: 'sig' }] });
  const client = 'test-app.apps.googleusercontent.com', base = 'https://relay.example.invalid';
  const calls = [];
  const env = { GOOGLE_CLIENT_ID: client, RELAY_SECRET: 'Synthetic receiver secret reserved for this test only',
    STREAMS: { idFromName: id => id, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
    PAGES: { idFromName: name => name, get: name => ({ async fetch(request) {
      calls.push({ name, ...await request.json() });
      return Response.json({ status: 200, body: { requests: [] } });
    } }) } };
  const relay = createRelay({ keys, now: () => start });
  const request = (path, options) => relay(new Request(base + path, options), env);
  const seconds = Math.floor(start / 1000);
  const session = async email => (await request('/v1/session', { method: 'POST', body: JSON.stringify({ deviceId: 'd'.repeat(43) }),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await new SignJWT({ sub: 'subject', iss: 'https://accounts.google.com', aud: client,
      iat: seconds, exp: seconds + 3600, email_verified: true, hd: 'antaia.space', email })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' }).sign(pair.privateKey) } })).json();
  const sync = (token, body = '{}') => request('/v1/booking/sync', { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) } });

  const urs = await session('Urs@Antaia.space');
  assert.equal(urs.bookingHandle, 'urs');
  assert.equal((await sync(urs.bookingToken, JSON.stringify({ page: null }))).status, 200);
  assert.deepEqual(calls, [{ name: 'urs', op: 'sync', handle: 'urs', streamId: urs.streamId, input: { page: null } }]);

  // No ticket, a ticket for another purpose, and a reserved or unusable name are all refused.
  assert.equal((await sync(null)).status, 401);
  assert.equal((await sync(urs.receiveToken)).status, 401);
  assert.equal((await sync(urs.notifyToken)).status, 401);
  assert.equal((await session('api@antaia.space')).bookingToken, undefined);
  assert.equal((await session('weird+name@antaia.space')).bookingToken, undefined);
  assert.equal((await sync(urs.bookingToken, '[1]')).status, 400);
  assert.equal((await sync(urs.bookingToken, 'x'.repeat(1100 * 1024))).status, 413);
  assert.equal(calls.length, 1);

  // Guests: a page on another site cannot post through a visitor's browser, and bodies are bounded.
  const post = (path, headers, body = '{}') => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await post('/api/urs/book', { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await post('/api/urs/book', { Origin: base })).status, 200);
  assert.equal((await post('/api/urs/book', {}, 'x'.repeat(13 * 1024))).status, 413);
  assert.equal((await request('/api/urs/book')).status, 405);
  assert.equal((await request('/api/v1/page')).status, 404);
  assert.equal((await request('/api/urs/page?x=1')).status, 404);

  // The page shell is static and locked down; reserved names are not pages.
  const shell = await request('/urs/meeting');
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await shell.text(), /<script type="module" src="\/assets\/booking\.js">/);
  assert.equal((await request('/api')).status, 404);
  assert.equal((await request('/urs/meeting', { method: 'POST' })).status, 404);

  // A receiver deployed without booking pages keeps answering as before.
  const { PAGES, ...older } = env;
  assert.equal((await relay(new Request(base + '/urs'), older)).status, 404);
  const plain = await (await relay(new Request(base + '/v1/session', { method: 'POST', body: JSON.stringify({ deviceId: 'd'.repeat(43) }),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await new SignJWT({ sub: 'subject', iss: 'https://accounts.google.com', aud: client,
      iat: seconds, exp: seconds + 3600, email_verified: true, hd: 'antaia.space', email: 'urs@antaia.space' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' }).sign(pair.privateKey) } }), older)).json();
  assert.deepEqual(Object.keys(plain).sort(), ['expiresAt', 'notifyToken', 'receiveToken', 'streamId']);
});
