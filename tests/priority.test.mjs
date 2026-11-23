import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { defaultSettings } from '../src/store.mjs';
import { DaylineService } from '../src/service.mjs';
import { startServer } from '../src/http.mjs';

const day = '2026-11-23';
const at = time => day + 'T' + time + ':00.000Z';
const row = (id, text, minutes, start, end, capture = '08:00') => ({ id, text, minutes, category: 'admin',
  createdAt: at(capture), done: false, held: false, dirty: {}, remote: null, intent: null,
  start: start ? at(start) : null, end: end ? at(end) : null, syncStatus: start ? 'local' : 'attention',
  issue: start ? null : 'No open work period fits.', earliestDay: day, latestDay: day });

function planner({ tasks = [], mode = 'local', now = '08:30', busy = [], estimate } = {}) {
  const store = { state: { version: 1, settings: { ...defaultSettings(), timeZone: 'UTC' }, tasks: structuredClone(tasks),
    accounts: mode === 'local' ? [] : [{ sub: 'work', mode: 'availability', email: 'work@example.test', secret: 'fixture' }] },
  save() { this.saved = structuredClone(this.state); } };
  store.save();
  const google = { reads: 0, busy, refreshToken: () => ({ access_token: 'fixture', expires_in: 3600 }),
    listCalendars: () => [{ id: 'work', primary: true, name: 'Work', writable: false }],
    getBusy() { this.reads++; return structuredClone(this.busy); } };
  const service = new DaylineService({ store, google, ...(estimate && { estimate }), clock: () => new Date(at(now)),
    vault: { open: value => value }, bundledClient: { clientId: 'fixture' } });
  return { service, store, google };
}

test('an exact capture in the paired no-account app reserves its time, shifts only conflicting tasks and recovers a same-time waitlist', async t => {
  const { service } = planner();
  const server = await startServer({ service, port: 0, intervalMs: 0, webRoot: fileURLToPath(new URL('../web/', import.meta.url)) });
  t.after(() => server.close());
  const pair = await fetch(server.launchUrl(), { redirect: 'manual' });
  const headers = { cookie: pair.headers.get('set-cookie').split(';')[0], origin: server.origin, 'content-type': 'application/json' };
  const capture = async text => {
    const result = await fetch(server.origin + '/api/tasks', { method: 'POST', headers, body: JSON.stringify({ text, day }) });
    assert.equal(result.status, 202);
    const { id } = await result.json();
    await service.whenEstimatesIdle();
    return id;
  };
  const first = await capture('Prepare materials for 30 minutes');
  const second = await capture('Review the handout for 30 minutes');
  assert.deepEqual([first, second].map(id => service.findTask(id).start), [at('09:00'), at('09:30')]);
  const breakfast = await capture('Breakfast at 9am for 15 minutes');
  assert.deepEqual([breakfast, second, first].map(id => service.findTask(id).start), [at('09:00'), at('09:30'), at('10:00')]);
  const duplicateTime = await capture('Call the studio at 9am for 15 minutes');
  assert.equal(service.findTask(duplicateTime).start, null);
  assert.match(service.findTask(duplicateTime).issue, /Another fixed-time task/);
  const removed = await fetch(server.origin + '/api/tasks/' + breakfast, { method: 'DELETE', headers, body: '{}' });
  assert.equal(removed.status, 200);
  assert.deepEqual([duplicateTime, second, first].map(id => service.findTask(id).start), [at('09:00'), at('09:30'), at('10:00')]);
});

test('an already-saved breakfast recovers after its start without another model call, honoring other tasks and Google busy time', async () => {
  for (const mode of ['local', 'availability']) {
    const tasks = [row('flex', 'File the receipts', 20, '10:15', '10:35'),
      row('later', 'Review the afternoon agenda', 20, '11:00', '11:20'),
      row('breakfast', 'Have breakfast at 10:15am', 15, null, null, '10:00')];
    const busy = mode === 'availability' ? [{ start: at('10:30'), end: at('10:50') }] : [];
    const h = planner({ tasks, mode, now: '10:18', busy, estimate: () => { throw Error('Must only use the saved estimate'); } });
    if (mode === 'availability') {
      assert.equal(h.service.findTask('breakfast').start, null);
      await h.service.queueSync();
      assert.ok(h.google.reads);
      assert.equal(h.service.snapshot().connection.error, null);
    }
    const expected = [at('10:15'), mode === 'availability' ? at('11:20') : at('10:30'), at('11:00')];
    const times = service => ['breakfast', 'flex', 'later'].map(id => service.findTask(id).start);
    assert.deepEqual(times(h.service), expected);
    assert.equal(h.service.findTask('breakfast').end, at('10:30'));
    const restarted = planner({ mode, tasks: h.store.saved.tasks, now: '10:19', busy });
    await restarted.service.queueSync();
    assert.deepEqual(times(restarted.service), expected);
  }
});

test('completed or already-underway work and a real Google commitment can block an exact appointment', async () => {
  const breakfast = row('requested', 'Have breakfast at 10:15 am', 15, null, null, '10:10');
  for (const protectedTask of [row('active', 'Prepare the sample', 40, '10:05', '10:45'),
    { ...row('completed', 'File the report', 30, '10:15', '10:45'), done: true }]) {
    const { service } = planner({ tasks: [protectedTask, breakfast], now: '10:18' });
    assert.equal(service.findTask('requested').start, null);
    assert.match(service.findTask('requested').issue, /reserved or already-started/);
    assert.equal(service.findTask(protectedTask.id).start, protectedTask.start);
  }
  const h = planner({ mode: 'availability', now: '10:18', tasks: [breakfast], busy: [{ start: at('10:16'), end: at('10:20') }] });
  await h.service.queueSync();
  assert.equal(h.service.findTask('requested').start, null);
  assert.match(h.service.findTask('requested').issue, /Google Calendar is busy/);
  h.google.busy = [];
  await h.service.queueSync();
  assert.equal(h.service.findTask('requested').start, at('10:15'));
  const late = planner({ now: '10:31', tasks: [breakfast] });
  assert.equal(late.service.findTask('requested').start, null);
  assert.match(late.service.findTask('requested').issue, /passed/);
});

test('a constrained flexible window yields to an explicit appointment and stays within its chosen day', async () => {
  const bounded = { ...row('bounded', 'Review the proof between 10:15 and 10:30', 15, '10:15', '10:30'), windowStart: '10:15', windowEnd: '10:30' };
  const exact = row('appointment', 'Call Anna at 10:15', 15, null, null);
  const h = planner({ tasks: [bounded, exact] });
  assert.equal(h.service.findTask('appointment').start, at('10:15'));
  assert.equal(h.service.findTask('bounded').start, null);
  assert.equal(h.service.findTask('bounded').latestDay, day);
  const impossible = await h.service.createTask({ text: 'Review the notes at 7am for 15 minutes', day });
  assert.match(h.service.findTask(impossible).issue, /working hours/);
});

test('duration edits resize an exact reservation before reallocating a flexible task to its next available time', async () => {
  for (const mode of ['local', 'availability']) {
    const tasks = [row('exact', 'Breakfast at 11am', 15, '11:00', '11:15'),
      row('flexible', 'Prepare the lab notes', 20, '11:15', '11:35'), row('stable', 'Package the sample', 30, '11:40', '12:10')];
    const h = planner({ mode, tasks });
    await h.service.queueSync();
    await h.service.run(() => h.service.adjustDuration('exact', { delta: 5, requestId: 'a'.repeat(32) }));
    await h.service.queueSync();
    assert.deepEqual(['exact', 'flexible', 'stable'].map(id => h.service.findTask(id).start), [at('11:00'), at('11:20'), at('11:40')]);
    assert.equal(h.service.findTask('exact').end, at('11:20'));
  }
});
