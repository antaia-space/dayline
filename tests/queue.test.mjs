import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DaylineService } from '../src/service.mjs';
import { openStore } from '../src/store.mjs';
import { estimateTask } from '../src/planner.mjs';

const now = '2026-11-23T08:00:00.000Z';
const n = number => number.toString(16).padStart(32, '0');
const deferred = () => Promise.withResolvers();
const estimate = (title, minutes = 30) => ({ title, category: 'writing', minutes, baseMinutes: minutes + 5,
  estimatedMinutes: minutes, reason: 'Draft and revise.', earliestDay: null, latestDay: null,
  windowStart: null, windowEnd: null, deadlineTime: null,
  agent: { outcome: 'success', provider: 'codex', model: 'fixture' } });
const failed = { ...estimate('Unused'), pendingEstimate: true, agent: { outcome: 'pending', provider: 'codex', notice: 'Model unavailable.' } };

function calendar() {
  const events = new Map();
  return { events, reads: 0, puts: 0, busy: [],
    refreshToken: () => ({ access_token: 'fixture', expires_in: 3600 }),
    listCalendars: () => [{ id: 'primary', primary: true, name: 'Team', writable: true, canInspectReservations: true }],
    getBusy(_, {start,end}) { this.reads++; return [...this.busy, ...events.values()].filter(e => !e.transparent && Date.parse(e.start) < Date.parse(end) && Date.parse(start) < Date.parse(e.end)).map(({ start, end }) => ({ start, end })); },
    listTaskEvents: () => structuredClone([...events.values()]),
    getTaskEvent: (_, { eventId }) => structuredClone(events.get(eventId)) || null,
    hasOtherBusyEvent: () => false,
    busyWithoutReservations(_, {reservations}) {
      const ignored = new Set(reservations.map(ref => ref.eventId));
      return [...this.busy,...[...events.values()].filter(e => !e.transparent && !ignored.has(e.eventId))];
    },
    putTaskEvent(_, { eventId, task, expectedEtag,completionAction }) {
      const previous = events.get(eventId);
      assert.equal(previous?.etag || null, expectedEtag);
      const event = { eventId, taskId: task.id, etag: ++this.puts, owned: true, text: task.text,
        done: task.done, start: task.start, end: task.end,transparent: completionAction === 'free' || (completionAction !== 'book' && Boolean(previous?.transparent)) };
      events.set(eventId, event);
      return structuredClone(event);
    },
  };
}

async function fixture(t, generate, mode = null) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dayline-queue-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  store.state.settings.timeZone = 'UTC';
  store.state.agent = { provider: 'codex', model: 'fixture', effort: 'low' };
  if (mode) {
    store.state.settings.calendarMode = mode;
    store.state.accounts = [{ sub: 'someone', email: 'someone@example.test', mode, secret: 'fixture' }];
  }
  store.save();
  const google = calendar();
  const open = (data, estimator) => {
    const service = new DaylineService({ store: data, google, vault: { open: value => value }, estimate: estimator,
      clock: () => new Date(now), bundledClient: { clientId: 'test' } });
    service.origin = 'http://127.0.0.1:43127';
    return service;
  };
  return { service: open(store, generate), google, dir, restart: estimator => open(openStore(dir), estimator) };
}

const capture = (service, text, requestId, more = {}) => service.run(() => service.enqueueTask({ text, requestId, ...more }));
const edit = (service, id, input) => service.run(() => service.enqueueEdit(id, input));
const retry = (service, id, requestId) => service.run(() => service.enqueueRetry(id, { requestId }));
const row = (service, id) => service.snapshot().tasks.find(t => t.id === id);

test('durable FIFO capture frees the planner during inference and keeps the capture context and later user overrides', { timeout: 5000 }, async t => {
  const started = deferred(), finish = deferred();
  const calls = [];
  const { service, google, dir } = await fixture(t, async (text, context) => {
    calls.push({ text, context });
    if (calls.length === 1) { started.resolve(); await finish.promise; }
    return estimate('Model title ' + calls.length);
  }, 'availability');
  const input = 'I need to prepare a thorough summary of the project.';
  const first = await capture(service, input, n(1), { day: '2026-11-24' });
  assert.equal(openStore(dir).state.tasks[0].estimateState, 'queued');
  assert.equal(row(service, first).start, null);
  service.startEstimateWorker();
  await started.promise;
  assert.equal(openStore(dir).state.tasks[0].estimateState, 'estimating');
  assert.deepEqual(row(service, first).estimateAgent, { provider: 'codex', model: 'fixture', effort: 'low' });
  assert.equal(row(service, first).estimateJob, undefined);
  await edit(service, first, { day: '2026-11-25', title: 'My project summary', minutes: 50 });
  google.busy = [{ start: '2026-11-25T09:00:00.000Z', end: '2026-11-25T10:00:00.000Z' }];
  await service.queueSync();
  assert.ok(google.reads > 0);
  service.data.agent = { provider: 'claude', model: 'later' };
  service.updateSettings({ endTime: '16:00' });
  const second = await capture(service, 'Prepare the follow-up', n(2));
  assert.equal(await capture(service, input, n(1)), first);
  assert.equal(calls.length, 1);
  assert.equal(row(service, second).estimateState, 'queued');
  finish.resolve();
  await service.whenEstimatesIdle();
  assert.deepEqual(calls.map(c => c.text), [input, 'Prepare the follow-up']);
  assert.equal(calls[0].context.now.toISOString(), now);
  assert.deepEqual([calls[0].context.taskId, calls[0].context.selection.model, calls[0].context.workHours.endTime], [first, 'fixture', '17:00']);
  assert.deepEqual([calls[1].context.selection.model, calls[1].context.workHours.endTime], ['later', '16:00']);
  const task = row(service, first);
  assert.deepEqual([task.text, task.title, task.minutes, task.baseMinutes, task.estimatedMinutes], [input, 'My project summary', 50, 35, 30]);
  assert.deepEqual([task.start, task.end], ['2026-11-25T10:00:00.000Z', '2026-11-25T10:50:00.000Z']);
  assert.equal(task.estimateState, null);
  assert.equal(task.pendingEstimate, false);
  assert.equal(service.data.agent.model, 'later');
  assert.equal(google.puts, 0);
  assert.ok(row(service, second).start);
});

test('a superseded model result cannot replace a rename, a completed task, or a deleted capture', { timeout: 5000 }, async t => {
  const started = deferred(), finish = deferred(), next = deferred(), finishNext = deferred();
  const calls = [];
  const { service, restart } = await fixture(t, async text => {
    calls.push(text);
    if (calls.length === 1) { started.resolve(); await finish.promise; }
    if (calls.length === 2) { next.resolve(); await finishNext.promise; }
    return estimate('Title for ' + text);
  });
  service.startEstimateWorker();
  const first = await capture(service, 'Original A', n(11));
  await started.promise;
  const second = await capture(service, 'Second B', n(12));
  await edit(service, first, { text: 'Revised A' });
  const completed = await capture(service, 'Already done', n(13));
  await edit(service, completed, { done: true });
  const deleted = await capture(service, 'Remove this', n(14));
  await service.run(() => service.deleteTask(deleted));
  finish.resolve();
  await next.promise;
  assert.equal(row(service, first).text, 'Revised A');
  assert.equal(row(service, first).estimateState, 'queued');
  assert.equal(row(service, first).start, null);
  await service.run(() => service.deleteTask(second));
  finishNext.resolve();
  await service.whenEstimatesIdle();
  assert.deepEqual(calls, ['Original A', 'Second B', 'Revised A']);
  assert.equal(row(service, first).title, 'Title for Revised A');
  assert.equal(row(service, completed).done, true);
  assert.equal(row(service, completed).start, null);
  const reopened = restart(() => { throw new Error('A deleted request must not spend another estimate'); });
  reopened.startEstimateWorker();
  for (const id of [second, deleted]) {
    assert.equal(await capture(reopened, 'Delayed replay', id), id);
    assert.equal(row(reopened, id), undefined);
  }
  await reopened.whenEstimatesIdle();
});

test('restart resumes queued work but requires a deliberate retry for interrupted and previously failed estimates', { timeout: 5000 }, async t => {
  const started = deferred(), finish = deferred();
  const { service, restart, dir } = await fixture(t, async text => {
    if (text === 'Legacy failure') return failed;
    started.resolve(); await finish.promise;
    return estimate('Ignored after stop');
  });
  const legacy = await service.createTask({ text: 'Legacy failure' });
  const first = await capture(service, 'Interrupted', n(21));
  const second = await capture(service, 'Still queued', n(22));
  service.startEstimateWorker(); await started.promise;
  service.stopEstimateWorker();
  const calls = [];
  const reopened = restart(async text => {
    calls.push(text);
    if (calls.length === 2) throw new Error('fixture private diagnostics');
    return estimate('Finished');
  });
  reopened.startEstimateWorker();
  await reopened.whenEstimatesIdle();
  assert.deepEqual(calls, ['Still queued']);
  assert.equal(row(reopened, second).pendingEstimate, false);
  assert.equal(row(reopened, legacy).pendingEstimate, true);
  assert.match(row(reopened, first).issue, /closed during this estimate/);
  assert.equal(row(reopened, first).start, null);
  const key = n(200);
  await Promise.all([retry(reopened, first, key), retry(reopened, first, key)]);
  await reopened.whenEstimatesIdle();
  assert.equal(row(reopened, first).estimateState, 'failed');
  assert.doesNotMatch(row(reopened, first).issue, /private diagnostics/);
  await retry(reopened, first, key);
  await reopened.whenEstimatesIdle();
  assert.deepEqual(calls, ['Still queued', 'Interrupted']);
  await retry(reopened, first, n(201));
  await reopened.whenEstimatesIdle();
  assert.equal(row(reopened, first).title, 'Finished');
  assert.ok(row(reopened, first).start);
  finish.resolve(); await service.whenEstimatesIdle();
  assert.equal(openStore(dir).state.tasks.find(t => t.id === first).title, 'Finished');
});

test('a failed initial disk commit leaves the capture eligible for a durable replay', async t => {
  let calls = 0;
  const { service, dir } = await fixture(t, () => { calls++; return estimate('Persisted'); });
  service.startEstimateWorker();
  const save = service.store.save;
  service.store.save = () => { service.store.save = save; throw new Error('Write failed'); };
  await assert.rejects(capture(service, 'Capture once', n(31)), /Write failed/);
  assert.equal(row(service, n(31)), undefined);
  assert.equal(openStore(dir).state.tasks.length, 0);
  await capture(service, 'Capture once', n(31));
  await service.whenEstimatesIdle();
  assert.equal(calls, 1);
  assert.equal(openStore(dir).state.tasks[0].title, 'Persisted');
});

test('offline replay anchors tomorrow and the selected provider to the original capture', async t => {
  const calls = [];
  const { service } = await fixture(t, (text, context) => {
    calls.push(context);
    return { ...estimateTask(text, context), title: 'Write the recap' };
  });
  service.startEstimateWorker();
  const sent = '2026-11-23T07:55:00.000Z'; // Sunday, 11:55 p.m. in Los Angeles, five minutes before receipt.
  const captureAgent = { provider: 'claude', model: 'original-choice' };
  const id = await capture(service, 'Write the recap tomorrow', n(32), {
    capturedAt: Date.parse(sent), captureTimeZone: 'America/Los_Angeles', captureAgent, viewDay: '2026-11-26',
  });
  await service.whenEstimatesIdle();
  assert.equal(calls[0].now.toISOString(), sent);
  assert.equal(calls[0].timeZone, 'America/Los_Angeles');
  assert.deepEqual(calls[0].selection, captureAgent);
  assert.equal(service.data.agent.provider, 'codex');
  assert.deepEqual([row(service, id).earliestDay, row(service, id).start], ['2026-11-23', '2026-11-23T09:00:00.000Z']);
  await capture(service, 'A clock ahead of this Mac', n(33), { capturedAt: '2026-11-23T08:05:00Z' });
  await service.whenEstimatesIdle();
  assert.equal(calls[1].now.toISOString(), now);
  await assert.rejects(capture(service, 'Invalid choice', n(34), { captureAgent: { provider: 'other' } }));
  assert.equal(row(service, n(34)), undefined);
});

test('Google syncs the editable model title and completion while retaining the capture wording', { timeout: 5000 }, async t => {
  let calls = 0;
  const { service, google } = await fixture(t, () => { calls++; return estimate('Draft supplier brief'); }, 'sync');
  service.startEstimateWorker();
  const original = 'I need to turn the notes from yesterday into a supplier brief.';
  const taskId = await capture(service, original, n(41));
  await service.whenEstimatesIdle();
  const [event] = google.events.values();
  assert.equal(event.text, 'Draft supplier brief');
  Object.assign(event, { text: 'Supplier brief for review', done: true, etag: ++google.puts });
  await service.queueSync();
  assert.deepEqual([row(service, taskId).text, row(service, taskId).title, row(service, taskId).done],
    [original, 'Supplier brief for review', true]);
  await edit(service, taskId, { title: 'Review supplier brief', done: false });
  await service.queueSync();
  const reopened = google.events.get(event.eventId);
  assert.deepEqual([reopened.text, reopened.done], ['Review supplier brief', false]);
  assert.equal(row(service, taskId).text, original);
  assert.equal(calls, 1);

  // Legacy records whose only title lived in `text` still round-trip a rename.
  const legacy = service.findTask(taskId);
  delete legacy.title;
  legacy.text = reopened.text;
  Object.assign(reopened, { text: 'Legacy renamed', etag: ++google.puts });
  await service.queueSync();
  assert.equal(row(service, taskId).text, 'Legacy renamed');
});

test('a linked model revision preserves a newer Google title and a completion cancels an in-flight revision', { timeout: 5000 }, async t => {
  const started = deferred(), finish = deferred(), startNext = deferred(), finishNext = deferred();
  const startCalendarEdit = deferred(), finishCalendarEdit = deferred();
  let calls = 0;
  const { service, google } = await fixture(t, async () => {
    calls++;
    if (calls === 2) { started.resolve(); await finish.promise; }
    if (calls === 3) { startNext.resolve(); await finishNext.promise; }
    if (calls === 4) { startCalendarEdit.resolve(); await finishCalendarEdit.promise; }
    return estimate('Proposed title ' + calls);
  }, 'sync');
  service.startEstimateWorker();
  const id = await capture(service, 'Draft an overview', n(42));
  await service.whenEstimatesIdle();
  const [remote] = google.events.values();
  await edit(service, id, { text: 'Draft a detailed budget overview' });
  await started.promise;
  const previousTime = remote.start;
  Object.assign(remote, { text: 'Finance team’s title', etag: ++google.puts });
  await service.queueSync();
  assert.equal(google.events.get(remote.eventId).start, previousTime);
  finish.resolve(); await service.whenEstimatesIdle();
  assert.equal(row(service, id).text, 'Draft a detailed budget overview');
  assert.equal(row(service, id).title, 'Finance team’s title');
  assert.equal(google.events.get(remote.eventId).text, 'Finance team’s title');
  await edit(service, id, { text: 'A later source edit still being estimated' });
  await startNext.promise;
  await edit(service, id, { done: true });
  await service.queueSync();
  assert.equal(google.events.get(remote.eventId).done, true);
  finishNext.resolve(); await service.whenEstimatesIdle();
  const done = row(service, id);
  assert.deepEqual([done.done, done.text, done.title, done.start], [true, 'A later source edit still being estimated', 'Finance team’s title', null]);

  await edit(service, id, { done: false }); await service.queueSync();
  await edit(service, id, { text: 'The final project brief' });
  await startCalendarEdit.promise;
  Object.assign(google.events.get(remote.eventId), { done: true, etag: ++google.puts });
  await service.queueSync();
  assert.equal(row(service, id).done, true);
  assert.equal(row(service, id).text, 'The final project brief');
  assert.equal(row(service, id).pendingEstimate, false);
  finishCalendarEdit.resolve(); await service.whenEstimatesIdle();
  assert.equal(row(service, id).title, 'Finance team’s title');
});
