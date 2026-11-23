import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/http.mjs';
import { DaylineService } from '../src/service.mjs';
import { openStore } from '../src/store.mjs';
import { durationNotes } from '../src/task-learning.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const key = () => randomUUID().replaceAll('-', '');
const at = clock => '2026-11-23T' + clock + ':00.000Z';

async function fixture(t, calendar = null) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dayline-duration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  store.state.settings.timeZone = 'UTC';
  if (calendar) store.state.accounts.push({ sub: 'work', email: 'work@example.invalid', secret: 'test', mode: 'availability' });
  let now = '09:00';
  const service = new DaylineService({ store, clock: () => new Date(at(now)), google: calendar,
    vault: { open: async value => value }, bundledClient: { clientId: 'test' } });
  const step = (id, delta, requestId = key()) => service.run(() => service.adjustDuration(id, { delta, requestId }));
  return { dir, store, service, step, setTime: value => { now = value; } };
}

test('parallel five-minute changes and delayed duplicate requests apply exactly once across sessions and restart', async t => {
  const { service, dir } = await fixture(t);
  const id = await service.createTask({ text: 'Draft a release note for 30 minutes' });
  const server = await startServer({ service, port: 0, intervalMs: 0, webRoot });
  t.after(() => server.close());
  async function pair() {
    const response = await fetch(server.launchUrl(), { redirect: 'manual' });
    return { cookie: response.headers.get('set-cookie').split(';')[0], origin: server.origin, 'Content-Type': 'application/json' };
  }
  const desktop = await pair(), browser = await pair();
  const step = (delta, requestId, headers) => fetch(server.origin + '/api/tasks/' + id + '/duration', {
    method: 'POST', headers, body: JSON.stringify({ delta, requestId })
  });
  const repeat = key();
  const changes = [step(5, repeat, desktop), step(5, repeat, browser)];
  for (let i = 0; i < 12; i++) changes.push(step(i % 3 === 0 ? -5 : 5, key(), i % 2 ? desktop : browser));
  for (const response of await Promise.all(changes)) assert.equal(response.status, 200);
  assert.equal(service.findTask(id).minutes, 55);
  assert.equal(service.findTask(id).estimatedMinutes, 30);
  assert.ok(durationNotes(service.data).length);
  assert.equal((await step(-5, repeat, browser)).status, 400);
  assert.equal((await step(7, key(), desktop)).status, 400);
  const reopened = new DaylineService({ store: openStore(dir), vault: {} });
  assert.deepEqual(reopened.adjustDuration(id, { delta: 5, requestId: repeat }), { id, minutes: 55 });
  assert.deepEqual(durationNotes(reopened.data), durationNotes(service.data));
  assert.equal(reopened.snapshot().tasks[0].durationRequests, undefined);
});

test('resize keeps an exact start and respects an independently specified availability window', async t => {
  const { service, step } = await fixture(t);
  const exact = await service.createTask({ text: 'Draft an agenda for 15 minutes at 10am' });
  await step(exact, 5);
  assert.equal(service.findTask(exact).start, at('10:00'));
  assert.equal(service.findTask(exact).end, at('10:20'));
  const bounded = await service.createTask({ text: 'Call the bakery for 20 minutes from 11am to 11:20am' });
  assert.equal(service.findTask(bounded).start, at('11:00'));
  await step(bounded, 5);
  assert.equal(service.findTask(bounded).minutes, 25);
  assert.equal(service.findTask(bounded).start, null);
  await step(bounded, -5);
  assert.equal(service.findTask(bounded).end, at('11:20'));
});

test('a failed write leaves the duration and its note untouched until the same click is retried', async t => {
  const { service, store, step } = await fixture(t);
  const id = await service.createTask({ text: 'Check the proof for 25 minutes' });
  const requestId = key();
  const save = store.save;
  store.save = () => { throw new Error('Simulated disk failure'); };
  await assert.rejects(step(id, 5, requestId), /disk failure/);
  assert.equal(service.findTask(id).minutes, 25);
  assert.deepEqual(durationNotes(store.state), []);
  store.save = save;
  await step(id, 5, requestId);
  assert.equal(service.findTask(id).minutes, 30);
  assert.equal(durationNotes(store.state).length, 1);
});

test('an active task retains its start on a short extension and moves around a newly confirmed meeting', async t => {
  let busy = [];
  const calendar = {
    refreshToken: async () => ({ access_token: 'test', expires_in: 3600 }),
    listCalendars: async () => [{ id: 'work', name: 'Work', primary: true }],
    getBusy: async () => busy
  };
  const { service, step, setTime } = await fixture(t, calendar);
  const id = await service.createTask({ text: 'Outline the update for 30 minutes' });
  await service.queueSync();
  assert.equal(service.findTask(id).start, at('09:00'));
  setTime('09:10');
  await step(id, 5);
  assert.equal(service.findTask(id).start, at('09:00'));
  assert.equal(service.findTask(id).end, at('09:35'));
  busy = [{ start: at('09:30'), end: at('09:40') }];
  await service.queueSync();
  assert.equal(service.findTask(id).start, at('09:40'));
  assert.equal(service.findTask(id).end, at('10:15'));
  assert.equal(service.findTask(id).remote, null);
});

test('manual steps can exceed a day, preserve positive durations, and record completed-task effort', async t => {
  const { service, step } = await fixture(t);
  const large = await service.createTask({ text: 'Plan a long project brief' });
  await service.editTask(large, { minutes: 1440 });
  await step(large, 5);
  assert.equal(service.findTask(large).minutes, 1445);
  assert.equal(service.findTask(large).start, null);
  const tiny = await service.createTask({ text: 'Send a quick reply for 6 minutes' });
  await step(tiny, -5);
  assert.equal(service.findTask(tiny).minutes, 1);
  await assert.rejects(step(tiny, -5), /positive/);
  assert.equal(service.findTask(tiny).end, at('09:01'));
  await service.editTask(tiny, { done: true });
  await step(tiny, 5);
  assert.equal(service.findTask(tiny).end, null);
  assert.equal(service.findTask(tiny).completedDay, '2026-11-23');
  assert.equal(service.findTask(tiny).minutes, 6);
});
