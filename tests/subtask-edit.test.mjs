import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DaylineService } from '../src/service.mjs';
import { startServer } from '../src/http.mjs';
import { defaultSettings } from '../src/store.mjs';
import { estimateTask } from '../src/planner.mjs';

const first = '1'.repeat(32), second = '2'.repeat(32), third = '3'.repeat(32);
const now = () => new Date('2026-11-23T08:00:00.000Z');
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

function fixture({ saved, estimate = estimateTask } = {}) {
  const store = { state: saved ? structuredClone(saved) : { version: 1, accounts: [], tasks: [], settings: { ...defaultSettings(), timeZone: 'UTC' } },
    save() { if (this.fail) throw new Error('Disk full'); this.saved = structuredClone(this.state); } };
  const service = new DaylineService({ store, vault: {}, clock: now, estimate, google: {} });
  return { service, store };
}

test('paired clients add the first step, merge independent edits and checks, and reject stale changes or duplicate names', async t => {
  let estimates = 0;
  const { service } = fixture({ estimate: (text, context) => { estimates++; return estimateTask(text, context); } });
  const id = await service.createTask({ text: 'Review the handoff' });
  const app = await startServer({ service, webRoot, port: 0, intervalMs: 0 });
  t.after(() => app.close());
  const pair = async () => (await fetch(app.launchUrl(), { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const [a, b] = await Promise.all([pair(), pair()]);
  const edit = async (cookie, method, member, data) => {
    const res = await fetch(app.origin + '/api/tasks/' + id + '/subtasks' + (member ? '/' + member : ''), { method,
      headers: { cookie, origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: res.status, body: await res.json() };
  };
  const read = async () => (await (await fetch(app.origin + '/api/state', { headers: { cookie: b } })).json()).tasks.find(task => task.id === id);
  assert.deepEqual((await read()).subtasks, []);
  const additions = await Promise.all([
    edit(a, 'POST', null, { id: first, title: 'Check draft' }), edit(b, 'POST', null, { id: second, title: 'Send PDF' }),
    edit(b, 'POST', null, { id: first, title: 'Check draft' })
  ]);
  assert.deepEqual(additions.map(x => x.status), [200, 200, 200]); assert.equal(additions.filter(x => x.body.changed).length, 2);
  assert.deepEqual(new Set((await read()).subtasks.map(item => item.id)), new Set([first, second]));
  const rename = { title: 'Review draft', expectedTitle: 'Check draft', requestId: '4'.repeat(32) };
  const independent = await Promise.all([
    edit(a, 'PATCH', first, rename),
    edit(b, 'PATCH', first, { done: true, expectedDone: false })
  ]);
  assert.ok(independent.every(x => x.status === 200 && x.body.changed));
  assert.deepEqual((await read()).subtasks.find(s => s.id === first), { id: first, title: 'Review draft', done: true });
  assert.equal((await edit(b, 'POST', null, { id: first, title: 'Check draft' })).body.changed, false);
  const renames = await Promise.all([
    edit(a, 'PATCH', first, { title: 'Review the latest draft', expectedTitle: 'Review draft' }),
    edit(b, 'PATCH', first, { title: 'Trim the draft', expectedTitle: 'Review draft' })
  ]);
  assert.deepEqual(renames.map(x => x.status).sort(), [200, 409]);
  assert.deepEqual((await edit(a, 'PATCH', first, rename)).body, { id, subtaskId: first, done: false, changed: false, completionChanged: false });
  assert.notEqual((await read()).subtasks.find(step => step.id === first).title, 'Review draft');
  assert.equal((await edit(b, 'DELETE', first, { expectedTitle: 'Review draft' })).status, 409);
  assert.equal((await edit(a, 'POST', null, { id: third, title: ' send  PDF ' })).status, 409);
  assert.equal((await edit(a, 'PATCH', first, { title: 'Send PDF' })).status, 409);
  assert.equal((await edit(a, 'POST', null, { id: 'bad', title: 'Broken' })).status, 400);
  assert.equal((await edit(a, 'POST', null, { id: third, title: 'x'.repeat(161) })).status, 400);
  assert.equal((await edit(a, 'PATCH', first, { title: 'Mixed', done: true })).status, 400);
  assert.equal((await edit(a, 'DELETE', first, {})).body.changed, true);
  assert.equal((await edit(b, 'DELETE', first, {})).body.changed, false);
  assert.equal((await edit(b, 'POST', null, { id: first, title: 'Check draft' })).body.changed, false);
  const state = await read();
  assert.deepEqual(state.subtasks, [{ id: second, title: 'Send PDF', done: false }]);
  assert.equal(Object.hasOwn(state, 'subtaskEdits'), false); assert.equal(estimates, 1);
});

test('manual additions, renames, removed suggestions and checks survive a pending estimate, subsequent estimates and restart', async () => {
  let release, entered;
  const inFlight = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  const { service, store } = fixture({ estimate: async (text, context) => { entered(); await gate; return estimateTask(text, context); } });
  const id = service.enqueueTask({ text: 'Pack pens, paper and stamps' });
  service.startEstimateWorker();
  try {
    await inFlight;
    const [, paper, stamps] = service.findTask(id).subtasks;
    const change = (kind, subtaskId, fields) => service.changeSubtask(id, { kind, subtaskId, ...fields });
    change('rename', paper.id, { title: 'Pack the signed originals!' }); change('check', paper.id, { done: true });
    change('remove', stamps.id); change('add', first, { title: 'Check label < 25 g.' });
    release(); await service.whenEstimatesIdle();
    assert.deepEqual(service.findTask(id).subtasks.map(c => [c.title, c.done]), [
      ['pens', false], ['Pack the signed originals!', true], ['Check label < 25 g.', false]
    ]);
    const restored = fixture({ saved: store.saved });
    await restored.service.editTask(id, { text: 'Pack pens, paper, stamps, tape and labels' });
    const children = restored.service.findTask(id).subtasks;
    assert.deepEqual(children.map(s => s.title), ['pens','Pack the signed originals!','tape','labels','Check label < 25 g.']);
    assert.deepEqual(children[1], { id: paper.id, title: 'Pack the signed originals!', done: true });
    assert.equal(children.at(-1).id, first);
    await restored.service.editTask(id, { text: 'Review the envelopes' });
    assert.deepEqual(restored.service.findTask(id).subtasks.map(s => s.id), [paper.id, first]);
    restored.service.changeSubtask(id, { kind: 'remove', subtaskId: first });
    const replay = fixture({ saved: restored.store.saved });
    assert.equal(replay.service.changeSubtask(id, { kind: 'add', subtaskId: first, title: 'Check label < 25 g.' }).changed, false);
    await replay.service.editTask(id, { text: 'Pack paper, stamps and labels' });
    assert.deepEqual(replay.service.findTask(id).subtasks.map(s => s.title), ['Pack the signed originals!', 'labels']);
  } finally { release(); service.stopEstimateWorker(); }
});

test('adding unfinished work reopens a completed parent and removal completes only a nonempty list of checked steps', async () => {
  const { service } = fixture();
  const id = await service.createTask({ text: 'Review the handoff' });
  const change = (kind, subtaskId, fields) => service.changeSubtask(id, { kind, subtaskId, ...fields });
  const task = service.findTask(id), start = task.start;
  change('add', first, { title: 'Print the brief' });
  assert.deepEqual(change('check', first, { done: true }), { id, subtaskId: first, done: true, changed: true, completionChanged: true });
  assert.equal(task.start, null);
  assert.equal(change('add', second, { title: 'Collect its signature' }).completionChanged, true);
  assert.deepEqual(task.subtasks.map(s => s.done), [true, false]); assert.equal(task.done, false); assert.equal(task.start, start);
  assert.equal(change('remove', second).completionChanged, true); assert.equal(task.done, true); assert.equal(task.start, null);
  assert.equal(change('remove', first).completionChanged, false); assert.equal(task.done, true); assert.deepEqual(task.subtasks, []);
  change('add', third, { title: 'Submit the signed brief' }); change('remove', third);
  assert.equal(task.done, false); assert.equal(task.start, start); assert.deepEqual(task.subtasks, []);
});

test('a lost check or rename response cannot replay an earlier gesture after another window has reversed it', async () => {
  const { service, store } = fixture();
  const id = await service.createTask({ text: 'Prepare the brief' });
  service.changeSubtask(id, { kind: 'add', subtaskId: first, title: 'Print draft' });
  const check = { kind: 'check', subtaskId: first, done: true, expectedDone: false, requestId: second };
  const rename = { kind: 'rename', subtaskId: first, title: 'Print final', expectedTitle: 'Print draft', requestId: third };
  assert.equal(service.changeSubtask(id, check).done, true);
  service.changeSubtask(id, { kind: 'check', subtaskId: first, done: false });
  assert.equal(service.changeSubtask(id, rename).changed, true);
  service.changeSubtask(id, { kind: 'rename', subtaskId: first, title: 'Print draft' });
  const restored = fixture({ saved: store.saved }).service;
  assert.equal(restored.changeSubtask(id, check).done, false); assert.equal(restored.changeSubtask(id, rename).changed, false);
  assert.deepEqual(restored.findTask(id).subtasks, [{ id: first, title: 'Print draft', done: false }]);
  assert.throws(() => restored.changeSubtask(id, { ...rename, requestId: second }), { status: 409 });
  assert.equal(Object.hasOwn(restored.snapshot().tasks[0], 'subtaskRequests'), false);
});

test('a failed save leaves membership, completion, reservation, and retry identity unchanged, including for a linked protected appointment', async () => {
  const { service, store } = fixture();
  const id = await service.createTask({ text: 'Review the handoff' });
  const task = service.findTask(id), slot = { start: task.start, end: task.end };
  service.data.settings.calendarMode = 'sync'; service.data.accounts.push({ sub: 'work', mode: 'sync' });
  task.remote = { sub: 'work', calendarId: 'work', eventId: 'owned', etag: 'unchanged', calendarAppointment: true, providerSlot: { ...slot } };
  const change = (kind, subtaskId, fields) => service.changeSubtask(id, { kind, subtaskId, ...fields });
  change('add', first, { title: 'Confirm the date' }); change('add', second, { title: 'Check the room' }); change('check', first, { done: true });
  const before = structuredClone(task), persisted = structuredClone(store.saved);
  assert.deepEqual(before.dirty, {}); assert.equal(before.start, slot.start);
  store.fail = true; assert.throws(() => change('remove', second), /Disk full/);
  assert.deepEqual(task, before); assert.deepEqual(store.saved, persisted);
  store.fail = false; const result = change('remove', second);
  assert.equal(result.done, true); assert.equal(result.completionChanged, true);
  assert.equal(task.start, slot.start); assert.equal(task.end, slot.end); assert.equal(task.remote.etag, 'unchanged');
  assert.deepEqual(task.dirty, { done: true }); assert.equal(task.remote.releasedSlot, undefined);
  assert.equal(change('remove', second).changed, false);
  const snapshot = structuredClone(task);
  task.deleting = true;
  assert.throws(() => change('rename', first, { title: 'Try again' }), { status: 409 });
  assert.deepEqual(task.subtasks, snapshot.subtasks);
});
