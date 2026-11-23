import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/http.mjs';
import { at, liveCalendarFixture, taskInput, week } from './fixtures/live-calendar.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const origin = 'https://receiver.example.test';

async function until(check, description) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { if (await check()) return; await delay(5); }
  assert.fail('Timed out waiting for ' + description);
}

async function openPlanner(app, signal) {
  const ticket = await fetch(app.launchUrl(), { redirect: 'manual' });
  assert.equal(ticket.status, 303);
  const headers = { cookie: ticket.headers.get('set-cookie').split(';')[0] };
  const read = async resource => {
    const response = await fetch(app.origin + resource, { headers, signal });
    assert.equal(response.status, 200);
    return response.json();
  };
  const response = await fetch(app.origin + '/api/updates', { headers, signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const revisions = [], errors = [];
  const listening = (async () => {
    let buffer = '';
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const message = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!message.includes('event: calendar')) continue;
        const packet = JSON.parse(message.split('\ndata: ')[1]);
        assert.deepEqual(Object.keys(packet), ['revision']);
        assert.ok(Number.isSafeInteger(packet.revision));
        revisions.push(packet.revision);
      }
    }
  })().catch(error => { if (!signal.aborted) errors.push(error); });
  return { read, revisions, errors, listening };
}

test('a registered Google push updates meetings and reflows the same task in both paired clients before a fallback poll', async t => {
  const { service, work, calls, moved } = liveCalendarFixture({ includeHome: false });
  service.data.accounts[0].email = 'synthetic-device@antaia.space';
  const proof = 'fixture-id-proof';
  service.google.refreshToken = async ({ refreshToken }) => ({ access_token: refreshToken, id_token: proof, expires_in: 3600 });
  const watches = [], stops = [], relay = [];
  let socket, readsAtRegistration;
  class ReceiverSocket extends EventTarget {
    constructor(url, protocols) { super(); socket = this; this.protocol = 'dayline.v1'; relay.push({ url, protocols }); }
    receive(packet) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) })); }
    send(data) { relay.push({ sent: data }); }
    close() { this.dispatchEvent(new Event('close')); }
  }
  service.google.watchCalendar = async (access, params) => {
    watches.push({ access, ...params });
    readsAtRegistration = calls.busy.length;
    return { channelId: params.channelId, resourceId: 'opaque-google-resource', expiration: Date.now() + 86400000 };
  };
  service.google.stopCalendarWatch = async (_, channel) => { stops.push(channel.channelId); };
  const taskId = await service.createTask(taskInput);
  const fallbackMs = 60000;
  const app = await startServer({ service, webRoot, port: 0, intervalMs: 0,
    calendarMonitorOptions: { intervalMs: fallbackMs, maxIntervalMs: fallbackMs, requestGapMs: fallbackMs, accountGapMs: fallbackMs },
    calendarPushOptions: { origin, WebSocket: ReceiverSocket, coalesceMs: 5, batchDelayMs: 1,
      fetch: async (url, init) => {
        relay.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return Response.json({ streamId: 'opaque-stream', receiveToken: 'receiver-ticket', notifyToken: 'google-ticket', expiresAt: Date.now() + 86400000 });
      } } });
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await app.close(); });
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]);
  const clients = await Promise.all([openPlanner(app, signal), openPlanner(app, signal)]);
  await until(() => clients.every(c => c.revisions.length), 'both paired update streams');
  await until(() => socket, 'the receiver stream');
  socket.receive({ type: 'ready' });
  await until(() => service.data.calendarPush?.channels.length === 1 && calls.busy.length > readsAtRegistration && !service.syncing,
    'a durable watch and its initial catch-up');
  const [watch] = watches;
  assert.equal(watches.length, 1);
  assert.deepEqual([watch.access, watch.calendarId, watch.channelToken, watch.address], [work, work, 'google-ticket', origin + '/v1/google/opaque-stream']);
  const state = await clients[0].read('/api/state');
  assert.equal(state.settings.calendarMode, 'availability');
  assert.equal(state.calendarPush.covered, 1);
  assert.equal(state.tasks[0].start, at('09:30'));
  const [original] = (await clients[0].read('/api/meetings' + week)).events;
  assert.equal(original.start, at('09:00'));
  await delay(20); // Registration itself coalesces an initial five-millisecond catch-up.
  await until(() => clients[0].revisions.at(-1) === clients[1].revisions.at(-1), 'both registration revisions');
  const registeredRevision = clients[0].revisions.at(-1);

  // Silence the provider change until a packet is sent. An unknown channel
  // cannot wake the planner or invalidate the already-loaded meeting cache.
  const probes = calls.changes.length, busyProbes = calls.detailedBusy.length;
  const start = performance.now();
  moved();
  socket.receive({ type: 'calendar', channelId: 'unregistered', messageNumber: '70', state: 'exists' });
  await delay(25);
  assert.equal((await clients[0].read('/api/state')).tasks[0].start, at('09:30'));
  assert.equal((await clients[1].read('/api/meetings' + week)).events[0].start, at('09:00'));
  assert.ok(clients.every(c => c.revisions.at(-1) === registeredRevision));
  const notifications = clients.map(async client => {
    await until(() => client.revisions.at(-1) > registeredRevision, 'a new push revision');
    const [state, { events, warnings }] = await Promise.all([client.read('/api/state'), client.read('/api/meetings' + week)]);
    assert.deepEqual(state.tasks.map(task => [task.id, task.start, task.end]), [[taskId, at('09:00'), at('09:30')]]);
    assert.deepEqual(state.busy, [{ start: at('10:30'), end: at('11:00') }]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(events.map(e => [e.id, e.title, e.start, e.location, e.attendees[0].response]),
      [[original.id, 'Revised studio review', at('10:30'), 'South room', 'accepted']]);
    assert.deepEqual(client.errors, []);
    return client.revisions.at(-1);
  });
  socket.receive({ type: 'calendar', channelId: watch.channelId, messageNumber: '71', state: 'exists' });
  const revisions = await Promise.all(notifications);
  assert.equal(revisions[0], revisions[1]);
  assert.ok(performance.now() - start < fallbackMs);
  assert.deepEqual([calls.changes.length, calls.detailedBusy.length], [probes, busyProbes]);
  assert.ok(calls.changes.every(probe => !probe.syncToken), 'the fallback can only have bootstrapped before push coverage');
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(stops, []);

  assert.deepEqual(relay, [{ url: origin + '/v1/session', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + proof },
    body: { deviceId: service.data.calendarPush.deviceId } }, { url: 'wss://receiver.example.test/v1/stream/opaque-stream',
    protocols: ['dayline.v1', 'ticket.receiver-ticket'] }]);
  assert.match(service.data.calendarPush.deviceId, /^[A-Za-z0-9_-]{43}$/);
  abort.abort();
  await Promise.all(clients.map(c => c.listening));
});
