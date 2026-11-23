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

function planner({ tasks = [], mode = 'local', now = '08:30', busy = [], estimate, settings = {} } = {}) {
  const store = { state: { version: 1, settings: { ...defaultSettings(), timeZone: 'UTC', ...settings }, tasks: structuredClone(tasks),
    accounts: mode === 'local' ? [] : [{ sub: 'work', mode: 'availability', email: 'work@example.test', secret: 'fixture' }] },
  save() { this.saved = structuredClone(this.state); } };
  store.save();
  const google = { reads: 0, busy, refreshToken: () => ({ access_token: 'fixture', expires_in: 3600 }),
    listCalendars: () => [{ id: 'work', primary: true, name: 'Work', writable: false }],
    getBusy() { this.reads++; return structuredClone(this.busy); } };
  const service = new DaylineService({ store, google, ...(estimate && { estimate }), clock: typeof now === 'function' ? now : () => new Date(now.includes('T') ? now : at(now)),
    vault: { open: value => value }, bundledClient: { clientId: 'fixture' } });
  return { service, store, google };
}

test('an exact capture in the paired no-account app closes gaps in the flexible list and recovers a same-time waitlist', async t => {
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
  assert.deepEqual([breakfast, first, second].map(id => service.findTask(id).start), [at('09:00'), at('09:15'), at('09:45')]);
  const duplicateTime = await capture('Call the studio at 9am for 15 minutes');
  assert.equal(service.findTask(duplicateTime).start, null);
  assert.match(service.findTask(duplicateTime).issue, /Another fixed-time task/);
  const removed = await fetch(server.origin + '/api/tasks/' + breakfast, { method: 'DELETE', headers, body: '{}' });
  assert.equal(removed.status, 200);
  assert.deepEqual([duplicateTime, first, second].map(id => service.findTask(id).start), [at('09:00'), at('09:15'), at('09:45')]);
});

test('an already-saved breakfast recovers after its start without another model call, honoring other tasks and Google busy time', async () => {
  for (const mode of ['local', 'availability']) {
    const tasks = [row('flex', 'File the receipts', 20, '10:15', '10:35'),
      row('later', 'Review the agenda at 11am', 20, '11:00', '11:20'),
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
    { ...row('completed', 'File the report', 30, '10:15', '10:45'), done: true, completedAt: at('10:17') }]) {
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
    const h = planner({ mode, tasks, now: '10:59' });
    await h.service.queueSync();
    await h.service.run(() => h.service.adjustDuration('exact', { delta: 5, requestId: 'a'.repeat(32) }));
    await h.service.queueSync();
    assert.deepEqual(['exact', 'flexible', 'stable'].map(id => h.service.findTask(id).start), [at('11:00'), at('11:20'), at('11:40')]);
    assert.equal(h.service.findTask('exact').end, at('11:20'));
  }
});

const slotTimes = (service, ...ids) => ids.map(id => {
  const { start, end } = service.findTask(id);
  return [start, end];
});
const interval = (start, end) => [at(start), at(end)];

test('a saved planner fills the 10:45 gap between breakfast and lunch in task list order, including after restart', async () => {
  for (const mode of ['local', 'availability']) {
    const breakfast = row('breakfast', 'Have breakfast at 10:15am', 30, '10:15', '10:45');
    const cleanup = row('cleanup', 'Clean up manual entries', 45, '11:15', '12:00');
    const deploy = row('deploy', 'Deploy the preview', 30, '13:00', '13:30');
    const history = { ...row('history', 'Read the handover', 20, '09:18', '09:38'), done: true };
    const noon = row('noon', 'Team meeting at noon', 60, '12:00', '13:00');
    const busy = mode === 'availability' ? [noon] : [];
    const tasks = [history, breakfast, deploy, cleanup, ...(mode === 'local' ? [noon] : [])];
    let calls = 0;
    const options = { mode, tasks, now: '10:18', busy, estimate: () => { calls++; throw Error('Unexpected estimate'); } };
    const h = planner(options);
    await h.service.queueSync();
    assert.deepEqual(slotTimes(h.service, 'deploy', 'cleanup'), [interval('10:45', '11:15'), interval('11:15', '12:00')]);
    assert.deepEqual(slotTimes(h.service, 'history', 'breakfast'), [interval('09:18', '09:38'), interval('10:15', '10:45')]);

    // The stored task array is the priority order used by a drag or keyboard move.
    const list = h.store.state.tasks;
    list.splice(list.indexOf(h.service.findTask('deploy')), 1);
    list.splice(list.indexOf(h.service.findTask('cleanup')) + 1, 0, deploy);
    await h.service.queueSync();
    const reordered = [interval('10:45', '11:30'), interval('11:30', '12:00')];
    assert.deepEqual(slotTimes(h.service, 'cleanup', 'deploy'), reordered);

    const restarted = planner({ ...options, tasks: h.store.saved.tasks, now: '10:19' });
    await restarted.service.queueSync();
    assert.deepEqual(slotTimes(restarted.service, 'cleanup', 'deploy'), reordered);
    assert.equal(calls, 0);
  }
});

test('a later short task fills a real gap which a higher-priority task cannot use', async () => {
  for (const mode of ['local', 'availability']) {
    const long = row('long', 'Review the release', 70, '14:00', '15:10');
    const short = row('short', 'File the expense', 30, '15:10', '15:40');
    const bounded = { ...row('bounded', 'Review the manuscript', 15, null, null), windowStart: '10:45', windowEnd: '11:00' };
    const surgery = row('surgery', 'Office hours at 11:15am', 105, '11:15', '13:00');
    const h = planner({ mode, now: '10:45', tasks: [long, short, bounded, ...(mode === 'local' ? [surgery] : [])],
      busy: mode === 'availability' ? [surgery] : [] });
    await h.service.queueSync();
    assert.deepEqual(slotTimes(h.service, 'long', 'short', 'bounded'), [interval('13:00', '14:10'), interval('10:45', '11:15'), [null, null]]);
    assert.equal(h.service.findTask('bounded').latestDay, day);
  }
});

test('a partially elapsed gap starts at the next whole minute and the next task immediately follows an odd finish', async () => {
  for (const mode of ['local', 'availability']) {
    const breakfast = row('breakfast', 'Breakfast at 10:15', 30, '10:15', '10:45');
    const cleanup = row('cleanup', 'Tidy the filing cabinet', 23, '11:15', '11:38', '10:48');
    const deploy = row('deploy', 'Deploy release', 30, '13:00', '13:30', '10:48');
    const h = planner({ mode, tasks: [breakfast, cleanup, deploy], now: day + 'T10:48:35.000Z' });
    await h.service.queueSync();
    assert.deepEqual(slotTimes(h.service, 'breakfast', 'cleanup', 'deploy'),
      [interval('10:15', '10:45'), interval('10:49', '11:12'), interval('11:12', '11:42')]);
  }
});

test('changing duration, deleting and reopening a higher-priority task compact subsequent tasks', async () => {
  for (const mode of ['local', 'availability']) {
    const lead = row('lead', 'Outline a talk', 37, '14:00', '14:37');
    const next = row('next', 'Prepare slides', 18, '14:37', '14:55');
    const completed = { ...row('completed', 'Update the agenda', 15, '12:30', '12:45'), done: true };
    const h = planner({ mode, tasks: [completed, lead, next] });
    await h.service.queueSync();
    assert.deepEqual(slotTimes(h.service, 'lead', 'next'), [interval('09:00', '09:37'), interval('09:37', '09:55')]);
    await h.service.editTask('lead', { minutes: 23 });
    await h.service.queueSync();
    assert.deepEqual(slotTimes(h.service, 'lead', 'next'), [interval('09:00', '09:23'), interval('09:23', '09:41')]);
    h.service.deleteTask('lead');
    await h.service.queueSync();
    assert.deepEqual(slotTimes(h.service, 'next', 'completed'), [interval('09:00', '09:18'), [null, null]]);
    assert.equal(h.service.findTask('completed').completedDay, day);
    await h.service.editTask('completed', { done: false });
    await h.service.queueSync();
    assert.deepEqual(slotTimes(h.service, 'completed', 'next'), [interval('09:00', '09:15'), interval('09:15', '09:33')]);
  }
});

test('the clock after each Google check governs placement, and a changed week receives fresh coverage', async () => {
  let now = day + 'T10:48:00.000Z';
  const cleanup = row('cleanup', 'Clean the workspace', 20, '13:00', '13:20');
  const h = planner({ mode: 'availability', tasks: [cleanup], now: () => new Date(now) });
  h.google.getBusy = () => { now = day + 'T10:49:32.000Z'; return []; };
  await h.service.queueSync();
  assert.deepEqual(slotTimes(h.service, 'cleanup'), [interval('10:50', '11:10')]);

  now = '2026-11-22T23:59:50.000Z';
  const nextWeek = planner({ mode: 'availability', tasks: [cleanup], now: () => new Date(now) });
  const reads = [];
  nextWeek.google.getBusy = (_token, query) => {
    reads.push(query);
    now = day + 'T09:00:08.000Z';
    return reads.length === 1 ? [{ start: at('09:00'), end: at('09:15') }] : [];
  };
  await nextWeek.service.queueSync();
  assert.deepEqual(slotTimes(nextWeek.service, 'cleanup'), [interval('09:15', '09:35')]);
  assert.equal(nextWeek.service.busyRange.start, at('00:00'));
  assert.equal(reads.length, 2);
  assert.equal(reads[1].start, reads[0].end);
  assert.equal(reads[1].end, nextWeek.service.busyRange.end);
});

test('changing connected working hours protects a task already in progress', async () => {
  const h = planner({ mode: 'availability', now: '10:15', tasks: [row('active', 'Build the dashboard', 40, '10:00', '10:40'),
    row('future', 'Review the dashboard', 30, '10:40', '11:10')] });
  await h.service.queueSync();
  h.service.updateSettings({ startTime: '11:13' });
  await h.service.queueSync();
  assert.deepEqual(slotTimes(h.service, 'active', 'future'), [interval('10:00', '10:40'), interval('11:13', '11:43')]);
});

test('tasks captured before breakfast ends recover the 10:45 handoff, even just after their previous 11:00 start', async () => {
  for (const now of ['10:58', '11:01']) {
    for (const mode of ['availability', 'local']) {
      const breakfast = { ...row('breakfast', 'Breakfast at 10:15', 30, '10:15', '10:45'), done: true };
      const cleanup = row('cleanup', 'Clean up manual entries', 30, '11:00', '11:30', '09:12');
      const deploy = row('deploy', 'Deploy the preview', 30, '11:30', '12:00', '09:15');
      const lunch = row('meeting', 'Call the team at noon', 60, '12:00', '13:00');
      const h = planner({ mode, now, tasks: [cleanup, deploy, breakfast, ...(mode === 'local' ? [lunch] : [])],
        busy: mode === 'availability' ? [lunch] : [] });
      await h.service.queueSync();
      assert.deepEqual(slotTimes(h.service, 'breakfast', 'cleanup', 'deploy'),
        [interval('10:15', '10:45'), interval('10:45', '11:15'), interval('11:15', '11:45')]);
      assert.equal(h.service.findTask('cleanup').minutes, 30);
    }
  }
});

test('catch-up needs a checked boundary and the original capture or most recent reorder before that boundary', async () => {
  const booked = { start: at('10:15'), end: at('10:45') };
  const run = async (tasks, busy = [booked]) => {
    const h = planner({ mode: 'availability', now: '10:58', tasks, busy });
    await h.service.queueSync();
    return h.service.findTask('task').start;
  };
  const early = row('task', 'Review materials', 30, '13:00', '13:30', '08:30');
  assert.equal(await run([early]), at('10:45'));
  assert.equal(await run([early], []), at('10:58'));
  assert.equal(await run([{ ...early, createdAt: at('10:58') }]), at('10:58'));
  assert.equal(await run([{ ...early, orderRequestedAt: at('10:56') }]), at('10:58'));
  assert.equal(await run([{ ...early, minutes: 10 }]), at('10:58'));
  assert.equal(await run([early], [booked, { start: at('10:50'), end: at('11:10') }]), at('11:10'));
});

test('a new Google meeting can minimally shorten and later fully restore a same-day estimate', async () => {
  const task = row('prep', 'Prepare the briefing', 60, '09:00', '10:00');
  const h = planner({ mode: 'availability', tasks: [task], settings: { endTime: '10:00' } });
  const prep = () => h.service.findTask('prep');
  for (const [end, remaining] of [['09:07', 53], ['09:11', 49], ['09:20', 60]]) {
    h.google.busy = [{ start: at('09:00'), end: at(end) }];
    await h.service.queueSync();
    assert.equal(prep().minutes, remaining);
    assert.deepEqual(prep().calendarFit, remaining < 60 ? { originalMinutes: 60 } : undefined);
    assert.equal(prep().start, remaining < 60 ? at(end) : null);
  }
  h.google.busy = [];
  await h.service.queueSync();
  assert.deepEqual(slotTimes(h.service, 'prep'), [interval('09:00', '10:00')]);
  assert.equal(prep().minutes, 60);
  assert.equal(prep().calendarFit, undefined);
  assert.equal(h.store.state.durationLearning, undefined);
});

test('a day with multiple estimated tasks uses only the combined reduction needed for the calendar', async () => {
  const tasks = [row('notes', 'Review the notes', 30, '09:00', '09:30'), row('brief', 'Prepare the brief', 30, '09:30', '10:00')];
  const h = planner({ mode: 'availability', tasks, settings: { endTime: '10:00' }, busy: [{ start: at('09:00'), end: at('09:10') }] });
  await h.service.queueSync();
  assert.deepEqual(slotTimes(h.service, 'notes', 'brief'), [interval('09:10', '09:33'), interval('09:33', '10:00')]);
  assert.deepEqual(h.store.saved.tasks.map(t => [t.minutes, t.calendarFit?.originalMinutes]), [[23, 30], [27, 30]]);
  h.google.busy = [];
  await h.service.queueSync();
  assert.deepEqual(h.store.saved.tasks.map(t => [t.minutes, t.calendarFit]), [[30, undefined], [30, undefined]]);
});

test('equally small duration changes put the first task in list order into the first gap', async () => {
  const tasks = [row('a', 'Prepare the notes', 30, '09:00', '09:30'), row('b', 'Review the notes', 30, '09:30', '10:00')];
  const h = planner({ mode: 'availability', tasks, settings: { endTime: '10:00' },
    busy: [{ start: at('09:25'), end: at('09:30') }] });
  await h.service.queueSync();
  assert.deepEqual(slotTimes(h.service, 'a', 'b'), [interval('09:00', '09:25'), interval('09:30', '10:00')]);
  assert.deepEqual(h.store.saved.tasks.map(t => [t.minutes, t.calendarFit?.originalMinutes]), [[25, 30], [30, undefined]]);
});

test('the planner preserves full estimates that fit later on the same day and all user-set durations', async () => {
  const blocked = [{ start: at('09:00'), end: at('09:08') }];
  const task = row('brief', 'Prepare the brief', 60, '09:00', '10:00');
  const ample = planner({ mode: 'availability', tasks: [task], busy: blocked });
  await ample.service.queueSync();
  assert.deepEqual(slotTimes(ample.service, 'brief'), [interval('09:08', '10:08')]);
  assert.equal(ample.service.findTask('brief').calendarFit, undefined);
  for (const protectedTask of [{ ...task, text: 'Prepare the brief for an hour' }, { ...task, estimateOverrides: { minutes: 60 } }]) {
    const h = planner({ mode: 'availability', tasks: [protectedTask], settings: { endTime: '10:00' }, busy: blocked });
    await h.service.queueSync();
    assert.equal(h.service.findTask('brief').start, null);
    assert.equal(h.service.findTask('brief').minutes, 60);
  }
  const bounded = ['one', 'two'].map(id => ({ ...row(id, 'Review materials', 30, null, null), windowEnd: '09:55' }));
  const unrelated = planner({ mode: 'availability', tasks: bounded, busy: [{ start: at('14:00'), end: at('15:00') }] });
  await unrelated.service.queueSync();
  assert.deepEqual(slotTimes(unrelated.service, 'one', 'two'), [interval('09:00', '09:30'), [null, null]]);
  assert.equal(unrelated.service.findTask('one').minutes, 30);
});

test('an incoming meeting moves unfinished flexible work, credits uninterrupted effort once and protects just-started effort', async () => {
  for (const [now, expected, credited] of [['09:20', 45, 15], ['09:02', 60, 0]]) {
    const work = row('work', 'Draft the article', 60, '09:00', '10:00');
    const h = planner({ mode: 'availability', now, tasks: [work], busy: [{ start: at('09:15'), end: at('09:50') }] });
    await h.service.queueSync();
    let moved = h.service.findTask('work');
    assert.equal(moved.start, at('09:50'));
    assert.equal(moved.minutes, expected);
    assert.equal(moved.calendarProgressMinutes || 0, credited);
    const restarted = planner({ mode: 'availability', now, tasks: h.store.saved.tasks, busy: h.google.busy });
    await restarted.service.queueSync();
    moved = restarted.service.findTask('work');
    assert.equal(moved.minutes, expected);
    assert.equal(moved.calendarProgressMinutes || 0, credited);
    assert.equal(moved.start, at('09:50'));
  }
});

test('checking a future task frees its minutes immediately in both paired clients and reopening plans it afresh', async t => {
  for (const mode of ['local', 'availability']) {
    const first = 'a'.repeat(32), second = 'b'.repeat(32);
    const h = planner({ mode, now: '08:30', tasks: [
      { ...row(first, 'Review the invoice', 5, '09:00', '09:05'), estimatedMinutes: 5 },
      row(second, 'Prepare a briefing', 30, '09:05', '09:35')] });
    await h.service.queueSync();
    const server = await startServer({ service: h.service, port: 0, intervalMs: 0, webRoot: fileURLToPath(new URL('../web/', import.meta.url)) });
    t.after(() => server.close());
    const pair = async () => {
      const launch = await fetch(server.launchUrl(), { redirect: 'manual' });
      return { cookie: launch.headers.get('set-cookie').split(';')[0], origin: server.origin, 'content-type': 'application/json' };
    };
    const desktop = await pair(), browser = await pair();
    const check = async (done, headers) => {
      const res = await fetch(server.origin + '/api/tasks/' + first, { method: 'PATCH', headers, body: JSON.stringify({ done }) });
      assert.equal(res.status, 200);
    };
    await check(true, desktop);
    const { tasks } = await (await fetch(server.origin + '/api/state', { headers: browser })).json();
    const completed = tasks.find(task => task.id === first);
    assert.deepEqual([completed.done, completed.completedAt, completed.completedDay, completed.start, completed.end, completed.minutes],
      [true, at('08:30'), day, null, null, 5]);
    assert.equal(tasks.find(task => task.id === second).start, at('09:00'));
    await check(false, browser);
    assert.deepEqual(slotTimes(h.service, first, second), [interval('09:00', '09:05'), interval('09:05', '09:35')]);
    assert.equal(h.service.findTask(first).completedDay, undefined);
    assert.equal(h.service.findTask(first).completedAt, undefined);
    assert.equal(h.store.state.durationLearning, undefined);
  }
});

test('an offline upgrade releases legacy future completions without fabricating timestamps or leftover catch-up anchors', async () => {
  let now = at('10:57');
  const finished = { ...row('finished', 'File the receipts', 5, '11:00', '11:05'), done: true,
    lastLocalSlot: { start: at('11:00'), end: at('11:05') }, durationCheckPending: true };
  const past = { ...row('past', 'Breakfast at 10:15', 30, '10:15', '10:45'), done: true };
  const next = { ...row('next', 'Write a note', 10, '13:00', '13:10', '10:55'), windowStart: '11:00' };
  const h = planner({ mode: 'availability', tasks: [finished, past, next], now: () => new Date(now) });
  const released = h.store.saved.tasks.find(task => task.id === 'finished');
  assert.deepEqual([released.start, released.end, released.completedDay, released.completedAt, released.lastLocalSlot],
    [null, null, day, undefined, undefined]);
  assert.equal(h.google.reads, 0);
  h.google.getBusy = () => { throw Error('Fixture calendar offline'); };
  await h.service.queueSync();
  assert.equal(h.service.findTask('next').start, null);
  assert.deepEqual(slotTimes(h.service, 'past', 'finished'), [interval('10:15', '10:45'), [null, null]]);
  now = at('11:08');
  h.google.getBusy = () => [];
  await h.service.queueSync();
  assert.deepEqual(slotTimes(h.service, 'next'), [interval('11:08', '11:18')]);
});

test('a future check-off stays on its planned date in the planner timezone', async () => {
  const h = planner({ mode: 'availability', now: '2026-11-22T05:00:00.000Z', settings: { timeZone: 'America/Los_Angeles' },
    tasks: [row('visit', 'Review the figures', 5, '05:00', '05:05')] });
  await h.service.editTask('visit', { done: true });
  const task = h.service.findTask('visit');
  assert.equal(task.completedDay, '2026-11-22');
  assert.equal(task.completedAt, '2026-11-22T05:00:00.000Z');
  assert.equal(task.start, null);
});

test('completing active work preserves only actual elapsed time and its planned day and duration', async () => {
  for (const mode of ['local', 'availability']) {
    const h = planner({ mode, now: day + 'T10:15:42.000Z', tasks: [
      { ...row('active', 'Prepare a presentation', 60, '10:00', '11:00'), estimatedMinutes: 60 },
      row('next', 'Review notes', 20, '11:00', '11:20')] });
    await h.service.queueSync();
    await h.service.editTask('active', { done: true });
    const completed = h.service.findTask('active');
    assert.deepEqual([completed.start, completed.end, completed.completedAt, completed.completedDay, completed.minutes],
      [at('10:00'), day + 'T10:15:42.000Z', day + 'T10:15:42.000Z', day, 60]);
    assert.deepEqual(slotTimes(h.service, 'next'), [interval('10:16', '10:36')]);
    assert.equal(h.store.state.durationLearning, undefined);
    const restarted = planner({ mode, now: '10:20', tasks: h.store.saved.tasks });
    assert.equal(restarted.service.findTask('active').end, completed.end);
  }
});

test('time passing extends the watched manual task in five-minute steps and yields a flexible handoff even when the timer is late', async () => {
  for (const mode of ['local', 'availability']) {
    let now = at('09:28');
    const before = { ...row('first', 'Prepare the update for 30 minutes', 30, '09:00', '09:30'),
      estimatedMinutes: 30, estimateOverrides: { minutes: 30 } };
    const next = row('second', 'Review the update', 20, '09:30', '09:50');
    let calls = 0;
    const options = { mode, tasks: [before, next], now: () => new Date(now), estimate: () => { calls++; throw Error('Unexpected estimator'); } };
    const h = planner(options);
    await h.service.queueSync();
    assert.equal(h.service.findTask('first').overrunWatchStart, at('09:00'));
    now = day + 'T09:30:40.000Z';
    await h.service.queueSync();
    await h.service.queueSync();
    assert.deepEqual(slotTimes(h.service, 'first', 'second'), [interval('09:00', '09:35'), interval('09:35', '09:55')]);
    assert.equal(h.service.findTask('first').overrunMinutes, 5);
    const restarted = planner({ ...options, tasks: h.store.saved.tasks });
    await restarted.service.queueSync();
    assert.equal(restarted.service.findTask('first').overrunMinutes, 5);
    now = day + 'T09:35:05.000Z';
    await restarted.service.queueSync();
    assert.deepEqual(slotTimes(restarted.service, 'first', 'second'), [interval('09:00', '09:40'), interval('09:40', '10:00')]);
    assert.deepEqual([restarted.service.findTask('first').minutes, restarted.service.findTask('first').overrunMinutes], [30, 10]);
    now = at('09:36');
    await restarted.service.editTask('first', { done: true });
    assert.deepEqual(slotTimes(restarted.service, 'first', 'second'), [interval('09:00', '09:36'), interval('09:36', '09:56')]);
    assert.equal(restarted.service.findTask('first').overrunMinutes, 6);
    assert.equal(restarted.service.findTask('first').overrunWatchStart, undefined);
    assert.equal(restarted.store.state.durationLearning, undefined);
    assert.equal(calls, 0);
  }
});

test('a Google meeting, written appointment, workday end or written task deadline caps an overrun', async () => {
  for (const kind of ['google', 'fixed', 'hours', 'deadline']) {
    let now = at('09:28');
    const task = row('active', 'Prepare the update', 30, '09:00', '09:30');
    if (kind === 'deadline') task.deadlineTime = '09:32';
    const appointment = row('fixed', 'Call the office at 9:32am', 20, '09:32', '09:52');
    const mode = kind === 'google' ? 'availability' : 'local';
    const h = planner({ mode, now: () => new Date(now), tasks: kind === 'fixed' ? [task, appointment] : [task],
      settings: kind === 'hours' ? { endTime: '09:32' } : {}, busy: kind === 'google' ? [appointment] : [] });
    await h.service.queueSync();
    now = at('09:30');
    await h.service.queueSync();
    assert.equal(h.service.findTask('active').end, at('09:32'), kind);
    assert.equal(h.service.findTask('active').overrunMinutes, 2, kind);
    now = at('09:33');
    await h.service.queueSync();
    assert.equal(h.service.findTask('active').end, at('09:32'), kind);
    assert.equal(h.service.findTask('active').overrunWatchStart, undefined, kind);
    if (kind === 'fixed') assert.equal(h.service.findTask('fixed').start, at('09:32'));
  }
});

test('a past task, a long-sleep watch or an unverified Google calendar does not gain fictional work time', async () => {
  const holder = row('active', 'Prepare the update', 30, '09:00', '09:30');
  const unseen = planner({ now: '09:31', tasks: [holder] });
  await unseen.service.queueSync();
  assert.equal(unseen.service.findTask('active').end, at('09:30'));
  let now = at('09:28');
  const h = planner({ mode: 'availability', now: () => new Date(now), tasks: [holder] });
  await h.service.queueSync();
  h.google.getBusy = () => { throw Error('Calendar unavailable'); };
  now = at('09:30');
  await h.service.queueSync();
  assert.match(h.service.error, /unavailable/);
  assert.equal(h.service.findTask('active').end, at('09:30'));
  now = at('09:45');
  h.google.getBusy = () => [];
  await h.service.queueSync();
  assert.equal(h.service.findTask('active').overrunMinutes, undefined);
  assert.equal(h.service.findTask('active').overrunWatchStart, undefined);
});

test('a newly added meeting takes back the unworked part of an active extension', async () => {
  let now = at('09:28');
  const h = planner({ mode: 'availability', now: () => new Date(now), tasks: [
    row('running', 'Write a briefing for 30 minutes', 30, '09:00', '09:30'),
    row('next', 'Read the briefing', 20, '09:30', '09:50')] });
  await h.service.queueSync();
  now = at('09:30');
  await h.service.queueSync();
  assert.equal(h.service.findTask('running').end, at('09:35'));
  h.google.busy = [{ start: at('09:32'), end: at('10:00') }];
  now = at('09:31');
  await h.service.queueSync();
  assert.deepEqual(slotTimes(h.service, 'running', 'next'), [interval('09:00', '09:32'), interval('10:00', '10:20')]);
  assert.equal(h.service.findTask('running').overrunMinutes, 2);
  assert.equal(h.service.findTask('running').minutes, 30);
});

test('a manual duration correction replaces the earned allowance without double counting it', async () => {
  for (const mode of ['local', 'availability']) {
    let now = at('09:28');
    const h = planner({ mode, now: () => new Date(now), tasks: [row('active', 'Draft the update', 30, '09:00', '09:30')] });
    await h.service.queueSync();
    now = at('09:30');
    await h.service.queueSync();
    assert.equal(h.service.findTask('active').overrunMinutes, 5);
    now = at('09:31');
    h.service.adjustDuration('active', { delta: 5, requestId: 'd'.repeat(32) });
    await h.service.queueSync();
    const active = h.service.findTask('active');
    assert.deepEqual([active.start, active.end, active.minutes, active.overrunMinutes], [at('09:00'), at('09:35'), 35, undefined]);
    now = at('09:35');
    await h.service.queueSync();
    assert.deepEqual([active.end, active.minutes, active.overrunMinutes], [at('09:40'), 35, 5]);
  }
});

test('a fixed-start task may pass an implicit model end but stops at an explicitly written time limit', async () => {
  for (const [text, until] of [['Review the file at 9am for 30 minutes', '09:35'],
    ['Review the file at 9am for 30 minutes, finish before 9:32am', '09:32']]) {
    let now = at('09:28');
    const task = { ...row('fixed', text, 30, '09:00', '09:30'), windowStart: '09:00', windowEnd: '09:30' };
    const h = planner({ now: () => new Date(now), tasks: [task] });
    await h.service.queueSync();
    now = at('09:30');
    await h.service.queueSync();
    assert.equal(h.service.findTask('fixed').end, at(until), text);
    assert.equal(h.service.findTask('fixed').minutes, 30);
  }
});
