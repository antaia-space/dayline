import test from 'node:test';
import assert from 'node:assert/strict';
import { CalendarPush } from '../src/calendar-push.mjs';
import { watchCalendar, stopCalendarWatch } from '../src/google.mjs';

const day = 86400000;
const initialTime = Date.parse('2026-11-23T09:00:00Z');
const origin = 'https://relay.example.test';
const cal = (id, sub = 'work') => ({ id, sub, details: false });
const waitSignal = (ms = 8) => new Promise(resolve => setTimeout(resolve, ms));
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('Google channel registration sends the opaque notification ticket only to Google and stops just the registered channel', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    const params = JSON.parse(init.body);
    calls.push({ url: String(url), params, headers: init.headers, method: init.method });
    if (String(url).endsWith('/stop')) return new Response('');
    return reply({ kind: 'api#channel', id: params.id, resourceId: 'provider-resource', expiration: String(initialTime + day),
      resourceUri: 'private-calendar-address', token: 'ignored-echo' });
  };
  const options = { calendarId: 'team@example.test', channelId: 'receiver-channel', channelToken: 'notification-secret',
    address: origin + '/v1/google/stream-1', ttlSeconds: 3600 };
  const channel = await watchCalendar('calendar-access', options, fetch);
  assert.deepEqual(channel, { channelId: options.channelId, resourceId: 'provider-resource', expiration: initialTime + day });
  await stopCalendarWatch('calendar-access', channel, fetch);
  assert.match(calls[0].url, /googleapis\.com\/calendar\/v3\/calendars\/team%40example\.test\/events\/watch$/);
  assert.deepEqual(calls[0].params, { id: options.channelId, type: 'web_hook', token: options.channelToken, address: options.address, params: { ttl: '3600' } });
  assert.match(calls[1].url, /googleapis\.com\/calendar\/v3\/channels\/stop$/);
  assert.deepEqual(calls[1].params, { id: options.channelId, resourceId: 'provider-resource' });
  assert.ok(calls.every(x => x.method === 'POST' && x.headers.Authorization === 'Bearer calendar-access'));
  for (const status of [404, 410]) await stopCalendarWatch('calendar-access', channel, () => reply({}, status));
  await assert.rejects(stopCalendarWatch('calendar-access', channel, () => reply({}, 403)), { status: 403 });
  await assert.rejects(watchCalendar('calendar-access', { ...options, ttlSeconds: 604801 }, fetch), { status: 400 });
  await assert.rejects(watchCalendar('calendar-access', { ...options, address: 'http://example.test/webhook' }, fetch), { status: 400 });
  await assert.rejects(watchCalendar('calendar-access', options, () => reply({ id: 'other', resourceId: 'x', expiration: 99 })), { status: 502 });
});

function fixture(t, options = {}) {
  const source = { revision: 'permission-1', calendars: options.calendars || [cal('private-calendar@example.test')] };
  const h = { time: initialTime, source, sockets: [], posts: [], watches: [], stops: [], storage: options.storage || {},
    saves: [], operations: [], signals: 0, statuses: [], identities: 0 };
  class Socket extends EventTarget {
    constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; this.protocol = 'dayline.v1'; this.sent = []; h.sockets.push(this); }
    close() { if (!this.closed) { this.closed = true; this.dispatchEvent(new Event('close')); } }
    send(data) { this.sent.push(data); if (h.autoPong) this.packet({ type: 'pong' }); }
    packet(object) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(object) })); }
    notice(channelId, messageNumber, state = 'exists') { this.packet({ type: 'calendar', channelId, messageNumber, state }); }
  }
  const fakeGoogle = {
    async watchCalendar(auth, params) {
      h.watches.push({ auth, ...params });
      h.operations.push({ op: 'watch', id: params.channelId });
      if (h.onWatch) await h.onWatch(params);
      return { channelId: params.channelId, resourceId: 'resource-' + h.watches.length, expiration: h.time + params.ttlSeconds * 1000 };
    },
    async stopCalendarWatch(auth, params) { h.stops.push({ auth, ...params }); h.operations.push({ op: 'stop', id: params.channelId }); },
  };
  h.push = new CalendarPush({ origin, sources: () => source, google: fakeGoogle,
    token: async sub => 'access-for-' + sub, identity: async () => { h.identities++; return 'google-id-proof'; },
    load: () => h.storage, save: state => {
      if (h.failSave?.(state)) throw new Error('Disk full');
      h.storage = structuredClone(state);
      h.saves.push(h.storage);
      h.operations.push({ op: 'save', channels: state.channels.map(c => c.channelId) });
    }, onChange: () => h.signals++, onStatus: status => h.statuses.push(status), now: () => h.time,
    random: () => 0, coalesceMs: 0, retryMs: 10, automatic: false,
    fetch: async (url, init) => {
      const number = h.posts.push({ url, headers: init.headers, body: JSON.parse(init.body), redirect: init.redirect });
      return reply({ streamId: 'stream-1', receiveToken: 'receive-ticket-' + number, notifyToken: 'notify-ticket-' + number, expiresAt: h.time + 8 * day });
    }, WebSocket: Socket, ...options.pushOptions });
  h.ready = async () => {
    await h.push.update();
    h.sockets.at(-1).packet({ type: 'ready' });
    await h.push.update();
    await waitSignal();
  };
  t.after(() => h.push.stop());
  return h;
}

test('without a receiver, or without a selected real calendar, no identity, device or provider watch is created', async t => {
  const disabled = fixture(t, { pushOptions: { origin: null } });
  assert.deepEqual(await disabled.push.update(), { connected: false, selected: 1, covered: 0, lastNotificationAt: null });
  const empty = fixture(t, { calendars: [cal('e_2_de#weeknum@group.v.calendar.google.com'), { ...cal('unsupported'), canCheckAvailability: false }] });
  assert.deepEqual(await empty.push.update(), { connected: false, selected: 0, covered: 0, lastNotificationAt: null });
  for (const h of [disabled, empty]) {
    assert.deepEqual(h.saves, []); assert.deepEqual(h.posts, []); assert.deepEqual(h.watches, []);
    assert.deepEqual(h.sockets, []); assert.equal(h.identities, 0); assert.equal(h.push.covers('work', 'unsupported'), false);
  }
});

test('native stream authenticates, coalesces early sync and regular events, and never gives the receiver private calendar data or access tokens', async t => {
  const h = fixture(t);
  h.onWatch = ({ channelId }) => h.sockets[0].notice(channelId, '1', 'sync');
  await h.ready();
  assert.equal(h.push.covers('work', h.source.calendars[0].id), true);
  assert.deepEqual(h.push.status(), { connected: true, selected: 1, covered: 1, lastNotificationAt: new Date(initialTime).toISOString() });
  assert.equal(h.identities, 1); assert.equal(h.signals, 1);
  assert.deepEqual(h.posts, [{ url: origin + '/v1/session', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer google-id-proof' },
    body: { deviceId: h.storage.deviceId } }]);
  assert.match(h.storage.deviceId, /^[A-Za-z0-9_-]{43}$/);
  const [socket] = h.sockets;
  assert.equal(socket.url, 'wss://relay.example.test/v1/stream/stream-1');
  assert.deepEqual(socket.protocols, ['dayline.v1', 'ticket.receive-ticket-1']);
  const [watch] = h.watches;
  assert.deepEqual(watch, { channelId: watch.channelId, auth: 'access-for-work', calendarId: h.source.calendars[0].id,
    channelToken: 'notify-ticket-1', address: origin + '/v1/google/stream-1', ttlSeconds: 604800 });
  assert.deepEqual(Object.keys(h.storage.channels[0]).sort(), ['channelId', 'expiresAt', 'providerId', 'renewAt', 'resourceId', 'streamId', 'sub']);
  assert.doesNotMatch(JSON.stringify(h.saves), /google-id-proof|access-for-work|receive-ticket|notify-ticket/);
  socket.notice('unknown-channel', '9'); socket.notice(watch.channelId, '1', 'sync');
  socket.notice(watch.channelId, '50', 'unrecognized'); socket.notice(watch.channelId, -2); socket.notice(watch.channelId, {});
  await waitSignal(); assert.equal(h.signals, 1);
  socket.notice(watch.channelId, '4'); socket.notice(watch.channelId, '3');
  socket.notice(watch.channelId, '7', 'not_exists');
  await waitSignal(); assert.equal(h.signals, 2);
  socket.notice(watch.channelId, '7'); socket.notice(watch.channelId, '1');
  await waitSignal(); assert.equal(h.signals, 2);
  assert.ok(h.statuses.every(status => Object.keys(status).sort().join(',') === 'connected,covered,lastNotificationAt,selected'));
});

test('restart reuses the durable watch, renews it before stopping the old one and removes it when unchecked', async t => {
  const first = fixture(t, { pushOptions: { ttlSeconds: 100, renewBeforeMs: 20000 } });
  await first.ready();
  const [original] = first.storage.channels;
  first.push.stop();
  assert.equal(first.sockets[0].closed, true); assert.equal(first.stops.length, 0);
  const restarted = fixture(t, { storage: first.storage, pushOptions: { ttlSeconds: 100, renewBeforeMs: 20000 } });
  await restarted.ready(); assert.equal(restarted.watches.length, 0);
  assert.equal(restarted.posts[0].body.deviceId, first.storage.deviceId); assert.equal(restarted.push.covers(original.sub, original.providerId), true);
  restarted.time = original.renewAt - 1;
  await restarted.push.update(); assert.equal(restarted.watches.length, 0);
  restarted.time++;
  await restarted.push.update(); assert.equal(restarted.watches.length, 1);
  const replacement = restarted.watches[0].channelId;
  assert.notEqual(replacement, original.channelId);
  assert.deepEqual(restarted.operations, [{ op: 'watch', id: replacement }, { op: 'save', channels: [original.channelId, replacement] },
    { op: 'stop', id: original.channelId }, { op: 'save', channels: [replacement] }]);
  assert.equal(restarted.push.covers(original.sub, original.providerId), true);
  restarted.source.calendars = [];
  assert.equal(restarted.push.covers(original.sub, original.providerId), false);
  await restarted.push.update();
  assert.equal(restarted.stops.at(-1).channelId, replacement); assert.equal(restarted.sockets[0].closed, true);
  assert.deepEqual(restarted.storage.channels, []);
  assert.deepEqual(restarted.push.status(), { connected: false, selected: 0, covered: 0, lastNotificationAt: null });
});

test('an accepted but stale Google watch is stopped with its original credential and never retained', async t => {
  const h = fixture(t);
  let release, entered;
  const pending = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  h.onWatch = () => { entered(); return pending; };
  await h.push.update();
  h.sockets[0].packet({ type: 'ready' });
  const first = h.push.update(), second = h.push.update();
  assert.equal(first, second);
  await started;
  h.source.revision = 'reconnected'; h.source.calendars = [];
  release(); await first;
  assert.equal(h.watches.length, 1); assert.equal(h.stops.length, 1);
  assert.equal(h.stops[0].auth, 'access-for-work'); assert.equal(h.stops[0].channelId, h.watches[0].channelId);
  assert.deepEqual(h.storage.channels, []); assert.equal(h.push.status().covered, 0);
});

test('loss of a websocket or a sleeping Mac resumes fallback, catches up on ready and keeps the same Google channel', async t => {
  const h = fixture(t, { pushOptions: { staleAfterMs: 100 } });
  await h.ready();
  const id = h.source.calendars[0].id;
  h.sockets[0].close(); assert.equal(h.push.covers('work', id), false);
  await h.push.update(); assert.equal(h.sockets.length, 1);
  h.time += 11; await h.push.update();
  assert.equal(h.sockets.length, 2); assert.equal(h.push.covers('work', id), false);
  h.sockets[1].packet({ type: 'ready' }); await waitSignal();
  assert.equal(h.signals, 2); assert.equal(h.push.covers('work', id), true);
  h.time += 101; await h.push.update();
  assert.equal(h.sockets[1].closed, true); assert.equal(h.sockets.length, 3); assert.equal(h.push.covers('work', id), false);
  h.sockets[2].packet({ type: 'ready' }); await waitSignal();
  assert.equal(h.signals, 3); assert.equal(h.push.covers('work', id), true);
  await h.push.update({ resume: true }); assert.equal(h.sockets.length, 4);
  assert.equal(h.push.covers('work', id), false); assert.equal(h.watches.length, 1);
});

test('a denied calendar uses fallback while other accounts receive pushes, and a provider rate limit backs off all watches on its account', async t => {
  const h = fixture(t, { calendars: [cal('limited'), cal('same-account'), cal('denied', 'second'), cal('ok', 'second')] });
  h.onWatch = ({ calendarId }) => {
    if (calendarId === 'limited') throw Object.assign(new Error(), { status: 429, retryAfterSeconds: 20 });
    if (calendarId === 'denied') throw Object.assign(new Error(), { status: 403, reason: 'forbidden' });
  };
  await h.ready(); assert.deepEqual(h.watches.map(w => w.calendarId), ['limited', 'denied', 'ok']);
  assert.deepEqual(h.push.status(), { connected: true, selected: 4, covered: 1, lastNotificationAt: null });
  assert.equal(h.push.covers('second', 'ok'), true); assert.equal(h.push.covers('work', 'same-account'), false);
  h.time += 19999; await h.push.update(); assert.equal(h.watches.length, 3);
  h.onWatch = null; h.time++; await h.push.update();
  assert.deepEqual(h.watches.slice(-2).map(w => w.calendarId), ['limited', 'same-account']);
  assert.equal(h.push.status().covered, 3);
});

test('failed durable confirmation rolls back a Google channel and preserves fallback', async t => {
  const h = fixture(t);
  h.failSave = x => x.channels.length > 0;
  await h.ready();
  assert.equal(h.watches.length, 1); assert.equal(h.stops[0].channelId, h.watches[0].channelId);
  assert.deepEqual(h.storage.channels, []); assert.equal(h.push.status().covered, 0);
  h.failSave = null; h.time += 11; await h.push.update();
  assert.equal(h.watches.length, 2); assert.equal(h.storage.channels.length, 1); assert.equal(h.push.status().covered, 1);
});

test('an incorrect negotiated protocol is dropped before any provider watch can start', async t => {
  const h = fixture(t);
  await h.push.update(); h.sockets[0].protocol = 'something-else'; h.sockets[0].packet({ type: 'ready' });
  await h.push.update(); assert.equal(h.watches.length, 0); assert.equal(h.sockets[0].closed, true);
  assert.equal(h.push.status().connected, false);
});

test('only a delivered Google notice confirms a channel and shutdown waits for an outstanding store mutation', async t => {
  let release, entered;
  const pending = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const h = fixture(t, { pushOptions: { save: async data => {
    if (data.channels.length) { entered(); await pending; }
  } } });
  await h.push.update();
  h.sockets[0].packet({ type: 'ready' });
  assert.equal(h.push.status().lastNotificationAt, null);
  const work = h.push.update();
  await started;
  h.sockets[0].notice(h.watches[0].channelId, 1, 'sync');
  assert.equal(h.push.status().lastNotificationAt, null);
  let closed = false;
  const closing = h.push.stop().then(() => { closed = true; });
  await waitSignal(); assert.equal(closed, false);
  release(); await Promise.all([work, closing]);
  assert.equal(closed, true); assert.equal(h.push.status().covered, 0);
  assert.equal(h.push.status().lastNotificationAt, new Date(initialTime).toISOString());
});

test('disconnect forgets persisted channels even when the account was removed or its refresh grant revoked', async t => {
  let denied;
  const h = fixture(t, { pushOptions: { token: async sub => {
    if (denied) throw denied;
    return 'access-for-' + sub;
  } } });
  for (const error of [Object.assign(new Error(), { status: 409 }), Object.assign(new Error(), { status: 400, reason: 'invalid_grant' })]) {
    h.source.calendars = [cal('old-work')];
    await h.ready(); assert.equal(h.push.status().covered, 1);
    denied = error;
    h.source.calendars = [];
    await h.push.update();
    assert.deepEqual(h.storage.channels, []); assert.equal(h.push.status().covered, 0);
    denied = null;
  }
});

test('a missing heartbeat reply drops a half-open stream and re-enables fallback detection', async t => {
  const h = fixture(t, { pushOptions: { heartbeatMs: 25, handshakeMs: 25 } });
  h.autoPong = true;
  await h.ready(); await waitSignal(85);
  assert.ok(h.sockets[0].sent.length >= 2); assert.ok(h.sockets[0].sent.every(frame => frame === '{"type":"ping"}'));
  assert.equal(h.push.status().covered, 1);
  h.autoPong = false;
  await waitSignal(85); assert.equal(h.sockets[0].closed, true); assert.equal(h.push.status().covered, 0);
});

test('an incomplete calendar inventory during launch or an outage preserves watches until an explicit removal is known', async t => {
  const original = fixture(t);
  await original.ready(); await original.push.stop();
  const h = fixture(t, { storage: original.storage, calendars: [] });
  h.source.uncertainSubs = ['work']; await h.push.update();
  assert.equal(h.posts.length, 0); assert.equal(h.stops.length, 0);
  assert.equal(h.storage.channels.length, 1); assert.equal(h.push.status().covered, 0);
  h.source.uncertainSubs = []; h.source.calendars = original.source.calendars;
  await h.ready(); assert.equal(h.watches.length, 0); assert.equal(h.push.status().covered, 1);
  h.source.calendars = []; h.source.uncertainSubs = ['work'];
  await h.push.update(); assert.equal(h.stops.length, 0); assert.equal(h.storage.channels.length, 1);
  h.source.uncertainSubs = [];
  await h.push.update(); assert.equal(h.stops.length, 1); assert.equal(h.storage.channels.length, 0);
});
