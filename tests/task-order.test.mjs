import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DaylineService } from '../src/service.mjs';
import { defaultSettings } from '../src/store.mjs';
import { startServer } from '../src/http.mjs';

const day = '2026-11-23';
const tomorrow = '2026-11-24';
const at = (clock, date = day) => date + 'T' + clock + ':00.000Z';
const task = (letter, extra) => ({ id: letter.repeat(32), text: 'Prepare ' + letter, category: 'admin',
  minutes: 30, earliestDay: day, latestDay: day, done: false, held: false, dirty: {},
  createdAt: at('07:00'), start: null, end: null, ...extra });
const ids = rows => rows.map(row => row.id[0]);
const options = (target, placement = 'before', group = day) => ({ targetId: target.repeat(32), placement, day: group });

function fixture(tasks, { now = '08:00', connected = false } = {}) {
  const state = { version: 1, settings: { ...defaultSettings(), timeZone: 'UTC' },
    accounts: connected ? [{ sub: 'work', mode: 'availability', secret: 'fixture' }] : [],
    tasks: structuredClone(tasks), lastSync: null };
  const store = { state, save() { this.saved = structuredClone(state); } };
  const google = { refreshToken: async () => ({ access_token: 'fixture' }),
    listCalendars: async () => [{ id: 'primary', primary: true, name: 'Work', accessRole: 'owner' }],
    getBusy: async () => [{ start: at('10:00'), end: at('11:00') }] };
  const config = { store, google, vault: { open: async s => s }, bundledClient: { clientId: 'fixture' }, clock: () => new Date(at(now)),
    estimate() { throw new Error('Reordering must use the existing estimates.'); } };
  const service = new DaylineService(config);
  return { service, store, config };
}

test('relative task order reflows actual slots, preserves other days, and survives retry and restart', () => {
  const a = task('a'), b = task('b'), c = task('c'), d = task('d', { earliestDay: tomorrow, latestDay: tomorrow });
  const { service, store, config } = fixture([a, d, b, c]);
  const originalB = service.findTask(b.id);
  service.reorderTask(c.id, options('a'));
  assert.deepEqual(ids(service.data.tasks), ['c','d','a','b']);
  assert.equal(service.findTask(b.id), originalB);
  assert.deepEqual([c,a,b].map(t => service.findTask(t.id).start), [at('09:00'), at('09:30'), at('10:00')]);
  const saved = structuredClone(store.saved);
  service.reorderTask(c.id, options('a'));
  assert.deepEqual(store.state, saved);
  const reopened = new DaylineService(config);
  assert.deepEqual(ids(reopened.snapshot().tasks), ['c','d','a','b']);
  assert.equal(reopened.findTask(d.id).start, at('09:00',tomorrow));
  assert.throws(() => reopened.reorderTask(c.id, options('d')), { status: 409 });
});

test('a deliberate move can defer an ongoing local task while a normal refresh keeps its start', async () => {
  const a = task('a', { start: at('09:00'), end: at('09:30') }), b = task('b', { start: at('09:30'), end: at('10:00') });
  const { service } = fixture([a,b], { now: '09:10' });
  await service.queueSync();
  assert.equal(service.findTask(a.id).start, at('09:00'));
  assert.ok(service.snapshot().tasks.every(t => t.canReorder));
  service.reorderTask(b.id, options('a'));
  assert.equal(service.findTask(b.id).start, at('09:10'));
  assert.equal(service.findTask(a.id).start, at('09:40'));
  assert.equal(service.findTask(a.id).minutes, 30);
  assert.equal(service.findTask(a.id).done, false);
});

test('fixed times, completed work, expired blocks and pending estimates cannot be reordered', () => {
  const a = task('a', { text:'Prepare a at 11:00', start: at('11:00'), end: at('11:30') });
  const b = task('b');
  const c = task('c', { done: true, start: at('08:00'), end: at('08:30') });
  const d = task('d', { start: at('09:00'), end: at('09:30') });
  const e = task('e', { pendingEstimate: true });
  const { service } = fixture([a,b,c,d,e], { now:'10:15' });
  assert.deepEqual(service.snapshot().tasks.filter(t => t.canReorder).map(t => t.id), [b.id]);
  for (const fixed of [a,c,d,e]) assert.throws(() => service.reorderTask(fixed.id, options('b')), {status:409});
});

test('Unscheduled retains a separate editable order and a failed disk write preserves object identity and slots', () => {
  const a = task('a', { minutes:900 }), b = task('b', { minutes:900 }), c = task('c');
  const { service, store } = fixture([a,b,c]);
  const initial = structuredClone(service.data.tasks);
  const held = [...service.data.tasks];
  const save = store.save;
  store.save = () => { throw new Error('Disk unavailable'); };
  assert.throws(() => service.reorderTask(b.id, options('a','before','unscheduled')), /Disk unavailable/);
  assert.deepEqual(service.data.tasks,initial);
  assert.ok(held.every((row,i) => row === service.data.tasks[i]));
  store.save = save;
  service.reorderTask(b.id, options('a','before','unscheduled'));
  assert.deepEqual(ids(store.saved.tasks),['b','a','c']);
  assert.equal(service.findTask(c.id).start, at('09:00'));
});

test('paired desktop and browser sessions share the new order and the confirmed Google-aware plan', async t => {
  const a = task('a'), b = task('b');
  const { service } = fixture([a,b], { connected:true, now:'09:30' });
  const app = await startServer({ service, webRoot: fileURLToPath(new URL('../web/', import.meta.url)), port:0, intervalMs:0 });
  t.after(() => app.close());
  await service.queueSync();
  const pair = async () => (await fetch(app.launchUrl(), { redirect:'manual' })).headers.get('set-cookie').split(';')[0];
  const desktop = await pair(), browser = await pair();
  const url = app.origin + '/api/tasks/' + b.id + '/order';
  const move = cookie => fetch(url,{ method:'POST', headers:{cookie,origin:app.origin,'content-type':'application/json'},body:JSON.stringify(options('a')) });
  assert.equal((await move('')).status,401);
  assert.equal((await move(desktop)).status,200);
  const shared = await (await fetch(app.origin + '/api/state',{headers:{cookie:browser}})).json();
  assert.deepEqual(ids(shared.tasks),['b','a']);
  assert.deepEqual(shared.tasks.map(t=>t.start),[at('09:30'),at('11:00')]);
});

test('a Google booking and cancellation replan the paired agenda on the timer without manual refresh or new estimates', async t => {
  const a = task('a'), b = task('b');
  const { service } = fixture([a,b], { connected: true });
  service.data.settings.endTime = '10:00';
  let busy = [];
  service.google.getBusy = async () => structuredClone(busy);
  const app = await startServer({ service, webRoot: fileURLToPath(new URL('../web/', import.meta.url)), port: 0, intervalMs: 25 });
  t.after(() => app.close());
  const cookie = (await fetch(app.launchUrl(), { redirect:'manual' })).headers.get('set-cookie').split(';')[0];
  async function waitForPlan(predicate) {
    const limit = Date.now() + 4000;
    while (Date.now() < limit) {
      const { tasks } = await (await fetch(app.origin+'/api/state',{headers:{cookie}})).json();
      if (predicate(tasks)) return tasks;
      await new Promise(resolve => setTimeout(resolve,25));
    }
    assert.fail('Automatic calendar reconciliation did not produce the expected schedule.');
  }
  const full = rows => rows[0].start === at('09:00') && rows[1].start === at('09:30') && rows.every(t => t.minutes === 30 && !t.calendarFit);
  await waitForPlan(full);
  busy = [{ start: at('09:25'), end: at('09:30') }];
  const compressed = await waitForPlan(rows => rows.every(t => t.start && t.end && (t.end <= busy[0].start || t.start >= busy[0].end)) &&
    rows.some(t => t.calendarFit?.originalMinutes === 30) && rows.reduce((sum,t) => sum+t.minutes,0) === 55);
  assert.ok(compressed.every(t => !t.done));
  assert.equal(service.data.durationLearning,undefined);
  busy = [];
  await waitForPlan(full);
});

test('the local planner extends unfinished work on the timer, without a calendar, a new estimate or a refresh', async t => {
  const a = task('a',{minutes:10}), b = task('b',{minutes:10});
  let now = new Date(at('09:00'));
  const {config} = fixture([]);
  config.store.state.tasks = [a,b];
  const service = new DaylineService({...config,clock:()=>now});
  const app = await startServer({service,webRoot:fileURLToPath(new URL('../web/',import.meta.url)),port:0,intervalMs:20});
  t.after(()=>app.close());
  const cookie = (await fetch(app.launchUrl(),{redirect:'manual'})).headers.get('set-cookie').split(';')[0];
  async function waitEnd(clock,extra) {
    const timeout = Date.now()+4000;
    do {
      const response = await fetch(app.origin+'/api/state',{headers:{cookie}});
      const {tasks} = await response.json();
      if (tasks[0].end === at(clock) && tasks[1].start === at(clock) && tasks[0].overrunMinutes === extra) return;
      await new Promise(resolve=>setTimeout(resolve,25));
    } while (Date.now()<timeout);
    assert.fail('The unattended local timer did not extend the task and move its successor.');
  }
  assert.equal(service.findTask(a.id).end,at('09:10'));
  now = new Date(at('09:10'));
  await waitEnd('09:15',5);
  now = new Date(at('09:15'));
  await waitEnd('09:20',10);
  assert.equal(service.data.durationLearning,undefined);
});
