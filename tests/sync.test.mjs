import test from 'node:test';
import assert from 'node:assert/strict';
import { DaylineService } from '../src/service.mjs';
import { defaultSettings } from '../src/store.mjs';

const day = '2026-11-23';
const at = time => day + 'T' + time + ':00.000Z';
const clock = () => new Date(at('08:59'));
const failure = (status, message) => Object.assign(new Error(message), { status });

class MemoryStore {
  constructor(saved) {
    this.state = structuredClone(saved);
    this.save();
  }
  save() { this.saved = structuredClone(this.state); }
}

// The adapter contract is tested separately. This double models Google's separate
// account permissions, occupied periods, persistent IDs, and optimistic versions.
class GoogleCalendars {
  catalogs = {
    work: [
      { id: 'work-primary', name: 'Work', primary: true, writable: true },
      { id: 'shared-room', name: 'Shared room', primary: false, writable: false },
    ],
    home: [{ id: 'home-primary', name: 'Home', primary: true, writable: true }],
  };
  events = new Map();
  meetings = [];
  inaccessible = new Set();
  insertRequests = 0;
  loseInsertResponse = false;
  nextPatchRace = null;
  eventCalls = [];
  authModes = [];
  exchangeModes = [];
  refreshModes = [];
  busyQueries = [];
  omitRefresh = false;

  authorizationUrl({ state, mode }) {
    this.authModes.push(mode);
    return 'https://example.test/authorize?state=' + state;
  }

  exchangeCode({ code, mode }) {
    this.exchangeModes.push(mode);
    return { access_token: code, expires_in: 3600, ...(!this.omitRefresh && { refresh_token: code }) };
  }

  getProfile(account) {
    assert.ok(this.catalogs[account]);
    return { sub: account, email: account + '@example.test' };
  }

  refreshToken({ refreshToken, mode }) {
    this.refreshModes.push({ account: refreshToken, mode });
    assert.ok(this.catalogs[refreshToken], 'unrecognized test account');
    return { access_token: refreshToken, expires_in: 3600 };
  }

  listCalendars(account) {
    return structuredClone(this.catalogs[account]);
  }

  checkAccess(account, calendarId, write = false) {
    const calendar = this.catalogs[account]?.find(c => c.id === calendarId);
    if (!calendar || this.inaccessible.has(calendarId) || (write && !calendar.writable)) {
      throw failure(403, 'No access to ' + calendarId);
    }
  }

  getBusy(account, { calendarIds, start, end }) {
    this.busyQueries.push({ account, calendarIds });
    for (const id of calendarIds) this.checkAccess(account, id);
    return [...this.meetings, ...this.events.values()]
      .filter(e => calendarIds.includes(e.calendarId) && Date.parse(e.end) > Date.parse(start) && Date.parse(e.start) < Date.parse(end))
      .map(e => ({ start: e.start, end: e.end }));
  }

  listTaskEvents(account, { calendarId }) {
    this.eventCalls.push({ method: 'listTaskEvents', account });
    this.checkAccess(account, calendarId);
    return structuredClone([...this.events.values()].filter(e => e.calendarId === calendarId));
  }

  getTaskEvent(account, { calendarId, eventId }) {
    this.eventCalls.push({ method: 'getTaskEvent', account });
    this.checkAccess(account, calendarId);
    const found = this.events.get(eventId);
    return found?.calendarId === calendarId ? structuredClone(found) : null;
  }

  putTaskEvent(account, { calendarId, eventId, task, expectedEtag, actionUrl }) {
    this.eventCalls.push({ method: 'putTaskEvent', account });
    this.checkAccess(account, calendarId, true);
    let existing = this.events.get(eventId);
    if (expectedEtag == null) {
      this.insertRequests++;
      if (existing?.taskId !== undefined) {
        if (existing.taskId !== task.id) throw failure(409, 'Different task');
        return structuredClone(existing);
      }
    } else {
      if (this.nextPatchRace) {
        this.change(eventId, this.nextPatchRace);
        this.nextPatchRace = null;
        existing = this.events.get(eventId);
      }
      if (!existing || existing.etag !== expectedEtag) throw failure(412, 'The event version changed');
    }
    const result = {
      eventId, taskId: task.id, owned: true, calendarId, etag: (existing?.etag ?? 0) + 1,
      text: task.text, done: task.done, start: task.start, end: task.end, category: task.category, actionUrl,
    };
    this.events.set(eventId, result);
    if (this.loseInsertResponse && expectedEtag == null) {
      this.loseInsertResponse = false;
      throw failure(503, 'Connection lost after Google saved the event');
    }
    return structuredClone(result);
  }

  deleteTaskEvent(account, { calendarId, eventId, taskId, expectedEtag }) {
    this.eventCalls.push({ method: 'deleteTaskEvent', account });
    this.checkAccess(account, calendarId, true);
    const event = this.events.get(eventId);
    if (!event) return;
    if (event.taskId !== taskId) throw failure(409, 'Different task');
    if (expectedEtag != null && event.etag !== expectedEtag) throw failure(412, 'The event version changed');
    this.events.delete(eventId);
  }

  change(eventId, edits) {
    const event = this.events.get(eventId);
    assert.ok(event, 'the Google event must already exist');
    Object.assign(event, edits, { etag: event.etag + 1 });
  }
}

function fixture(google = new GoogleCalendars(), saved) {
  const store = new MemoryStore(saved ?? {
    version: 1, tasks: [], settings: { ...defaultSettings(), timeZone: 'UTC', calendarMode: 'sync' },
    accounts: ['work', 'home'].map(sub => ({ sub, email: sub + '@example.test', secret: sub, mode: 'sync' })),
    client: null, lastSync: null,
  });
  const service = new DaylineService({
    store, google, clock, bundledClient: { clientId: 'test-client' },
    vault: { seal: value => value, open: value => value },
  });
  service.origin = 'http://127.0.0.1:43127';
  return { store, google, service };
}

async function successfulSync(service) {
  await service.queueSync();
  assert.equal(service.snapshot().connection.error, null);
  assert.equal(service.snapshot().connection.lastSync, service.clock().toISOString());
}

async function create(h, text = 'Write notes for 30 minutes') {
  const taskId = await h.service.run(() => h.service.createTask({ text }));
  await successfulSync(h.service);
  const task = h.store.saved.tasks.find(t => t.id === taskId);
  assert.equal(task.syncStatus, 'synced');
  assert.ok(h.google.events.has(task.remote.eventId));
  return task;
}

test('scheduling combines both accounts and a read-only calendar, then writes to the chosen account', async () => {
  const h = fixture();
  h.google.meetings = [
    { calendarId: 'work-primary', start: at('09:00'), end: at('09:30') },
    { calendarId: 'shared-room', start: at('09:30'), end: at('10:00') },
    { calendarId: 'home-primary', start: at('10:00'), end: at('11:00') },
  ];
  await successfulSync(h.service);
  const home = h.service.snapshot().calendars.find(c => c.name === 'Home');
  h.service.updateSettings({ targetCalendarId: home.id });
  const task = await create(h);
  assert.deepEqual([task.start, task.end, task.minutes], [at('11:00'), at('11:30'), 30]);
  assert.equal(task.remote.sub, 'home');
  const remote = h.google.events.get(task.remote.eventId);
  assert.equal(remote.calendarId, 'home-primary');
  assert.equal(remote.taskId, task.id);
  assert.equal(remote.category, task.category);
  const second = await create(h, 'Write the agenda for 30 minutes');
  assert.equal(second.start, at('11:30'));
  assert.equal(second.category, task.category);
  assert.equal(h.google.events.size, 2);
});

test('completing and reopening in either surface update the other surface and the event action', async () => {
  const h = fixture();
  const task = await create(h);
  const eventId = task.remote.eventId;
  const provider = () => h.google.events.get(eventId);
  const persisted = () => h.store.saved.tasks[0];

  await h.service.editTask(task.id, { done: true });
  await successfulSync(h.service);
  assert.equal(provider().done, true);
  assert.equal(new URL(provider().actionUrl).searchParams.get('done'), '0');
  h.google.change(eventId, { done: false, text: 'Revised in Calendar' });
  await successfulSync(h.service);
  assert.equal(persisted().done, false);
  assert.equal(persisted().text, 'Revised in Calendar');
  assert.equal(new URL(provider().actionUrl).searchParams.get('done'), '1');

  h.google.change(eventId, { done: true });
  await successfulSync(h.service);
  assert.equal(persisted().done, true);
  assert.equal(new URL(provider().actionUrl).searchParams.get('done'), '0');
  await h.service.editTask(task.id, { done: false });
  await successfulSync(h.service);
  assert.equal(provider().done, false);
  assert.equal(h.google.events.size, 1);
  assert.equal(h.google.insertRequests, 1);
});

test('after a lost insert response, a restart recovers the same event and merges later edits', async () => {
  const h = fixture();
  h.google.loseInsertResponse = true;
  const taskId = await h.service.createTask({ text: 'Write minutes for 30 minutes' });
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error, /Connection lost/);
  const uncertain = h.store.saved.tasks[0];
  assert.equal(uncertain.remote, null);
  assert.ok(uncertain.intent.eventId);
  assert.equal(uncertain.syncStatus, 'attention');
  assert.equal(h.google.events.size, 1);

  h.google.change(uncertain.intent.eventId, { text: 'Title edited in Calendar', start: at('11:00'), end: at('11:30') });
  const restarted = fixture(h.google, h.store.saved);
  await restarted.service.editTask(taskId, { done: true });
  await successfulSync(restarted.service);
  const recovered = restarted.store.saved.tasks[0];
  const event = h.google.events.get(recovered.remote.eventId);
  assert.equal(event.eventId, uncertain.intent.eventId);
  assert.equal(recovered.intent, null);
  assert.equal(recovered.start, at('11:00'));
  assert.equal(recovered.text, 'Title edited in Calendar');
  assert.equal(event.text, recovered.text);
  assert.equal(event.done, true);
  assert.equal(recovered.done, true);
  assert.equal(recovered.syncStatus, 'synced');
  assert.equal(h.google.insertRequests, 1);
});

test('an unavailable calendar leaves the task unbooked until availability is known', async () => {
  const h = fixture();
  h.google.inaccessible.add('shared-room');
  await h.service.createTask({ text: 'Review notes for 20 minutes' });
  await h.service.queueSync();
  const blocked = h.store.saved.tasks[0];
  assert.equal(h.google.events.size, 0);
  assert.equal(blocked.start, null);
  assert.equal(blocked.remote, null);
  assert.equal(blocked.intent, null);
  assert.match(blocked.issue, /shared-room/);
  assert.match(h.service.snapshot().connection.error, /shared-room/);

  h.google.inaccessible.clear();
  h.google.meetings.push({ calendarId: 'shared-room', start: at('09:00'), end: at('10:00') });
  await successfulSync(h.service);
  const recovered = h.store.saved.tasks[0];
  assert.equal(recovered.syncStatus, 'synced');
  assert.equal(recovered.start, at('10:00'));
  assert.equal(h.google.events.get(recovered.remote.eventId).start, at('10:00'));
});

test('an exact deadline survives estimation and cannot be scheduled later on the same day', async () => {
  const h = fixture();
  h.google.meetings = [{ calendarId: 'work-primary', start: at('09:00'), end: at('12:30') }];
  await h.service.createTask({ text: 'Review the budget for 30 minutes by today at noon' });
  await successfulSync(h.service);
  const task = h.store.saved.tasks[0];
  assert.equal(h.google.events.size, 0);
  assert.equal(task.start, null);
  assert.equal(task.syncStatus, 'attention');
  assert.ok(task.issue);
});

test('a calendar edit racing an app completion survives the conditional-write retry', async () => {
  const h = fixture();
  const task = await create(h);
  const eventId = task.remote.eventId;
  h.google.nextPatchRace = { text: 'Retitled before the patch', start: at('13:00'), end: at('13:30') };
  await h.service.editTask(task.id, { done: true });
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error, /version changed/);
  assert.equal(h.google.events.get(eventId).done, false);
  assert.equal(h.store.saved.tasks[0].dirty.done, true);

  await successfulSync(h.service);
  const merged = h.store.saved.tasks[0];
  const remote = h.google.events.get(eventId);
  assert.equal(merged.text, 'Retitled before the patch');
  assert.equal(merged.start, at('13:00'));
  assert.equal(remote.start, merged.start);
  assert.equal(remote.done, true);
  assert.equal(merged.done, remote.done);
  assert.deepEqual(merged.dirty, {});
  assert.equal(h.google.insertRequests, 1);
});

test('deleting one task removes its event, and calendar deletions stay unscheduled until requested', async () => {
  const h = fixture();
  const removed = await create(h);
  const remaining = await create(h, 'Email an update for 10 minutes');
  h.service.deleteTask(removed.id);
  await successfulSync(h.service);
  assert.deepEqual(h.store.saved.tasks.map(t => t.id), [remaining.id]);
  assert.deepEqual([...h.google.events.keys()], [remaining.remote.eventId]);

  h.google.events.delete(remaining.remote.eventId);
  await successfulSync(h.service);
  let saved = h.store.saved.tasks[0];
  assert.equal(saved.remote, null);
  assert.equal(saved.held, true);
  assert.equal(saved.start, null);
  assert.ok(saved.issue);
  await successfulSync(h.service);
  assert.equal(h.google.events.size, 0);
  assert.equal(h.google.insertRequests, 2);

  await h.service.editTask(remaining.id, { day });
  await successfulSync(h.service);
  saved = h.store.saved.tasks[0];
  assert.equal(saved.syncStatus, 'synced');
  assert.notEqual(saved.remote.eventId, remaining.remote.eventId);
  assert.equal(h.google.events.get(saved.remote.eventId).taskId, remaining.id);
});

test('shortening a reserved block can keep its exact time even when Google reports it busy', async () => {
  const h = fixture();
  const task = await create(h, 'Write notes for 30 minutes today at 9am');
  await h.service.editTask(task.id, { minutes: 15 });
  await successfulSync(h.service);
  const shortened = h.google.events.get(task.remote.eventId);
  assert.equal(shortened.start, at('09:00'));
  assert.equal(shortened.end, at('09:15'));
  assert.equal(h.store.saved.tasks[0].syncStatus, 'synced');
  assert.equal(h.google.insertRequests, 1);
});

function availabilityFixture() {
  return fixture(new GoogleCalendars(), {
    version: 1, tasks: [], settings: { ...defaultSettings(), timeZone: 'UTC' },
    accounts: [], client: null, lastSync: null,
  });
}

async function connect(h, account, expectedMode = h.service.snapshot().settings.calendarMode) {
  const { url } = await h.service.beginConnection({ expectedMode });
  const state = new URL(url).searchParams.get('state');
  await h.service.finishConnection({ state, code: account });
}

async function createLocal(h, text) {
  const id = await h.service.createTask({ text });
  await successfulSync(h.service);
  return id;
}

const savedTask = (h, id) => h.store.saved.tasks.find(t => t.id === id);

test('default connections plan around two read-only accounts and make zero event calls through a task’s lifecycle', async () => {
  const h = availabilityFixture();
  for (const calendars of Object.values(h.google.catalogs)) {
    for (const calendar of calendars) calendar.writable = false;
  }
  const id = await h.service.createTask({ text: 'Write notes for 30 minutes' });
  assert.equal(savedTask(h, id).start, at('09:00'));
  h.google.meetings = [
    { calendarId: 'work-primary', start: at('09:00'), end: at('10:00') },
    { calendarId: 'shared-room', start: at('10:00'), end: at('10:30') },
    { calendarId: 'home-primary', start: at('10:30'), end: at('11:00') },
  ];
  await connect(h, 'work');
  await connect(h, 'home');
  await successfulSync(h.service);
  assert.deepEqual(h.google.authModes, ['availability', 'availability']);
  assert.deepEqual(h.google.exchangeModes, h.google.authModes);
  assert.deepEqual(h.service.snapshot().connection.accounts.map(a => a.mode), h.google.authModes);
  const placed = savedTask(h, id);
  assert.equal(placed.start, at('11:00'));
  assert.equal(placed.syncStatus, 'local');
  assert.equal(placed.remote, null);
  assert.equal(placed.intent, null);
  assert.deepEqual(placed.dirty, {});

  await h.service.editTask(id, { text: 'Write a short recap for 15 minutes' });
  await successfulSync(h.service);
  assert.equal(savedTask(h, id).end, at('11:15'));
  await h.service.editTask(id, { done: true });
  await successfulSync(h.service);
  assert.equal(savedTask(h, id).done, true);
  assert.deepEqual(savedTask(h, id).dirty, {});
  await h.service.editTask(id, { done: false });
  h.service.deleteTask(id);
  await successfulSync(h.service);
  assert.deepEqual(h.store.saved.tasks, []);
  assert.deepEqual(h.google.eventCalls, []);
});

test('a newly conflicting meeting moves only affected local tasks and exposes an impossible appointment', async () => {
  const h = availabilityFixture();
  await connect(h, 'work');
  const first = await createLocal(h, 'Read the brief for 30 minutes');
  const second = await createLocal(h, 'Write notes for 30 minutes');
  const appointment = await createLocal(h, 'Call a supplier today at 10am for 30 minutes');
  assert.deepEqual([first, second, appointment].map(id => savedTask(h, id).start), [at('09:00'), at('09:30'), at('10:00')]);

  h.google.meetings.push({ calendarId: 'work-primary', start: at('09:00'), end: at('09:30') });
  await successfulSync(h.service);
  assert.deepEqual([first, second, appointment].map(id => savedTask(h, id).start), [at('10:30'), at('09:30'), at('10:00')]);
  h.google.meetings = [];
  await successfulSync(h.service);
  assert.equal(savedTask(h, first).start, at('10:30'));
  h.google.meetings.push({ calendarId: 'shared-room', start: at('10:00'), end: at('10:30') });
  await successfulSync(h.service);
  assert.equal(savedTask(h, appointment).start, null);
  assert.equal(savedTask(h, appointment).syncStatus, 'attention');
  assert.ok(savedTask(h, appointment).issue);
  assert.deepEqual(h.google.eventCalls, []);
});

test('availability fails closed and recovers in the same slot, respecting exclusions including the primary calendar', async () => {
  const h = availabilityFixture();
  await connect(h, 'work');
  await connect(h, 'home');
  h.google.meetings.push({ calendarId: 'home-primary', start: at('09:00'), end: at('10:00') });
  const id = await createLocal(h, 'Review notes for 30 minutes');
  assert.equal(savedTask(h, id).start, at('10:00'));

  h.google.inaccessible.add('work-primary');
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error, /work-primary/);
  assert.equal(savedTask(h, id).start, null);
  assert.equal(savedTask(h, id).syncStatus, 'attention');
  assert.equal(h.service.snapshot().busyStart, null);

  const calendars = h.service.snapshot().calendars;
  const primary = calendars.find(c => c.name === 'Work');
  h.service.updateSettings({ excludedCalendarIds: [primary.id] });
  h.google.busyQueries = [];
  await successfulSync(h.service);
  assert.ok(h.google.busyQueries.length);
  assert.equal(h.google.busyQueries.some(q => q.calendarIds.includes('work-primary')), false);
  assert.equal(savedTask(h, id).start, at('10:00'));

  h.service.updateSettings({ excludedCalendarIds: calendars.map(c => c.id) });
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error, /Select at least one calendar/);
  assert.equal(savedTask(h, id).start, null);
  h.service.updateSettings({ excludedCalendarIds: [primary.id] });
  await successfulSync(h.service);
  assert.equal(savedTask(h, id).start, at('10:00'));
  assert.deepEqual(h.google.eventCalls, []);
});

test('completed and started local blocks keep their history through conflicts and read outages', async () => {
  const h = availabilityFixture();
  const started = await h.service.createTask({ text: 'Write minutes for 30 minutes' });
  const completed = await h.service.createTask({ text: 'Read notes for 30 minutes' });
  await h.service.editTask(completed, { done: true });
  h.service.clock = () => new Date(at('09:15'));
  h.google.meetings = [{ calendarId: 'work-primary', start: at('09:00'), end: at('15:00') }];
  await connect(h, 'work');
  await successfulSync(h.service);
  h.google.inaccessible.add('work-primary');
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error, /work-primary/);
  assert.equal(savedTask(h, started).start, at('09:00'));
  assert.equal(savedTask(h, completed).start, at('09:30'));
  assert.equal(savedTask(h, completed).done, true);
  assert.deepEqual(h.google.eventCalls, []);
});

test('switching to event sync requires explicit reauthorization; read-only accounts still supply busy intervals', async () => {
  const h = availabilityFixture();
  await connect(h, 'home');
  await connect(h, 'work');
  const id = await createLocal(h, 'Write the report for 30 minutes');
  const stale = await h.service.beginConnection({ expectedMode: 'availability' });
  h.service.updateSettings({ calendarMode: 'sync' });
  await assert.rejects(h.service.beginConnection({ expectedMode: 'availability' }), { status: 409 });
  await assert.rejects(h.service.finishConnection({ state: new URL(stale.url).searchParams.get('state'), code: 'home' }), /expired/);
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error, /Reconnect/);
  assert.deepEqual(h.google.eventCalls, []);
  assert.deepEqual(h.google.refreshModes.map(r => r.mode), ['availability', 'availability']);

  h.google.omitRefresh = true;
  await assert.rejects(connect(h, 'work', 'sync'), /offline access/);
  assert.equal(h.store.saved.accounts.find(a => a.sub === 'work').mode, 'availability');
  h.google.omitRefresh = false;
  await connect(h, 'work', 'sync');
  assert.deepEqual(h.store.saved.accounts.map(a => a.mode), ['availability', 'sync']);
  h.google.meetings = [{ calendarId: 'home-primary', start: at('09:00'), end: at('10:00') }];
  await successfulSync(h.service);
  assert.equal(savedTask(h, id).start, at('10:00'));
  assert.equal(h.google.events.get(savedTask(h, id).remote.eventId).calendarId, 'work-primary');
  assert.ok(h.google.eventCalls.length);
  assert.equal(h.google.eventCalls.some(op => op.account === 'home'), false);
  assert.deepEqual(h.google.authModes, ['availability', 'availability', 'availability', 'sync', 'sync']);
});

test('v1 migration moves local copies out of all busy times and leaves Google events alone until sync is enabled', async () => {
  const old = fixture();
  const completed = await create(old, 'Write minutes for 30 minutes');
  const removed = await create(old, 'Review a document for 30 minutes');
  const data = structuredClone(old.store.saved);
  delete data.settings.calendarMode;
  for (const account of data.accounts) delete account.mode;
  // Free/busy alone cannot tell whether a former reservation is the only
  // event in its interval. A second checked account has a simultaneous meeting.
  old.google.meetings.push({ calendarId: 'home-primary', start: completed.start, end: completed.end });
  const h = fixture(old.google, data);
  assert.equal(h.service.snapshot().settings.calendarMode, 'availability');
  assert.deepEqual(h.service.snapshot().connection.accounts.map(a => a.mode), ['sync', 'sync']);
  h.google.eventCalls = [];
  h.google.refreshModes = [];
  await successfulSync(h.service);
  assert.ok(h.google.refreshModes.every(call => call.mode === 'availability'));
  assert.equal(savedTask(h, completed.id).start, at('10:00'));
  assert.equal(savedTask(h, removed.id).start, at('10:30'));
  assert.equal(h.google.events.get(completed.remote.eventId).start, completed.start);
  assert.equal(h.google.events.get(removed.remote.eventId).start, removed.start);
  assert.equal(savedTask(h, completed.id).syncStatus, 'local');
  await h.service.editTask(completed.id, { done: true });
  h.service.deleteTask(removed.id);
  await successfulSync(h.service);
  assert.deepEqual(h.google.eventCalls, []);
  assert.equal(h.google.events.get(completed.remote.eventId).done, false);
  assert.equal(savedTask(h, removed.id), undefined);
  assert.deepEqual(savedTask(h, completed.id).dirty, {});
  assert.equal(savedTask(h, completed.id).remote, null);
  assert.equal(savedTask(h, completed.id).intent, null);

  const restarted = fixture(h.google, h.store.saved);
  await successfulSync(restarted.service);
  assert.deepEqual(h.google.eventCalls, []);
  restarted.service.updateSettings({ calendarMode: 'sync' });
  await successfulSync(restarted.service);
  assert.equal(h.google.events.size, 2);
  assert.equal(h.google.events.has(removed.remote.eventId), true);
  assert.equal(h.google.events.get(completed.remote.eventId).done, true);
  assert.equal(h.google.events.get(completed.remote.eventId).start, at('10:00'));
  assert.equal(h.google.insertRequests, 2);
});

test('an account downgraded to availability is never asked for events, even if another account can sync', async () => {
  const h = fixture();
  const existing = await create(h);
  h.service.updateSettings({ calendarMode: 'availability' });
  await connect(h, 'work', 'availability');
  h.google.eventCalls = [];
  await h.service.editTask(existing.id, { done: true });
  await successfulSync(h.service);
  h.service.updateSettings({ calendarMode: 'sync' });
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error, /Reconnect work@example.test/);
  assert.equal(h.google.events.get(existing.remote.eventId).done, false);
  assert.equal(h.google.eventCalls.some(op => op.account === 'work'), false);
  await connect(h, 'work', 'sync');
  await successfulSync(h.service);
  assert.equal(h.google.events.get(existing.remote.eventId).done, true);
  assert.equal(h.google.insertRequests, 1);
});

test('a dropped write grant is never exchanged or stored after switching back to availability', async () => {
  const h = availabilityFixture();
  h.service.updateSettings({ calendarMode: 'sync' });
  const { url } = await h.service.beginConnection({ expectedMode: 'sync' });
  h.service.updateSettings({ calendarMode: 'availability' });
  await assert.rejects(h.service.finishConnection({ state: new URL(url).searchParams.get('state'), code: 'work' }));
  assert.deepEqual(h.google.exchangeModes, []);
  assert.deepEqual(h.store.saved.accounts, []);

  h.service.updateSettings({ calendarMode: 'sync' });
  const exchange = h.google.exchangeCode.bind(h.google);
  h.google.exchangeCode = async grant => {
    const tokens = exchange(grant);
    h.service.updateSettings({ calendarMode: 'availability' });
    h.service.updateSettings({ calendarMode: 'sync' });
    return tokens;
  };
  await assert.rejects(connect(h, 'work', 'sync'), { status: 409 });
  assert.deepEqual(h.store.saved.accounts, []);
  assert.equal(h.service.tokens.size, 0);
  assert.deepEqual(h.google.eventCalls, []);
});

test('Week Numbers sources stay informational, and an unsupported real calendar fails closed with its display name', async () => {
  const h = availabilityFixture();
  const weeks = 'e_2_de#weeknum@group.v.calendar.google.com';
  const real = 'opaque-provider-id@group.calendar.google.com';
  h.google.catalogs.work = [
    { id: weeks, name: 'Kalenderwochen', writable: false, canCheckAvailability: false },
    { id: real, name: 'Team shifts', writable: false, canCheckAvailability: true },
  ];
  h.google.inaccessible.add(weeks);
  h.google.meetings.push({ calendarId: real, start: at('09:00'), end: at('10:00') });
  await connect(h, 'work');
  const task = await createLocal(h, 'Review notes for 30 minutes');
  assert.equal(savedTask(h, task).start, at('10:00'));
  assert.ok(h.google.busyQueries.every(query => !query.calendarIds.includes(weeks)));

  const visibleReal = h.service.snapshot().calendars.find(c => c.name === 'Team shifts');
  h.service.updateSettings({ excludedCalendarIds: [visibleReal.id] });
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error, /Select at least one/);
  assert.equal(savedTask(h, task).start, null);

  h.service.updateSettings({ excludedCalendarIds: [] });
  h.google.getBusy = () => { throw Object.assign(new Error('Provider reported notFound'), { status: 503, calendarId: real }); };
  await h.service.queueSync();
  const message = h.service.snapshot().connection.error;
  assert.match(message, /Team shifts/);
  assert.match(message, /uncheck.*Settings/);
  assert.equal(message.includes(real), false);
  assert.equal(savedTask(h, task).start, null);
});

function modelEstimate(pending = false) {
  return { category: 'focus', minutes: 45, earliestDay: null, latestDay: null,
    windowStart: null, windowEnd: null, deadlineTime: null,
    reason: pending ? 'Waiting for a model estimate.' : 'Estimated from the scope of the review.',
    pendingEstimate: pending, agent: pending
      ? { outcome: 'pending', provider: 'codex', notice: 'The model could not finish this estimate.' }
      : { outcome: 'model', provider: 'codex', model: 'test-model' },
  };
}

test('a failed model leaves a durable unscheduled task through refresh, edits, mode changes, and completion', async () => {
  const h = availabilityFixture();
  let estimates = 0;
  h.service.estimate = () => { estimates++; return modelEstimate(true); };
  const id = await h.service.createTask({ text: 'Review the proposal', day });
  let task = savedTask(h, id);
  assert.equal(estimates, 1);
  assert.equal(task.pendingEstimate, true);
  assert.equal(task.start, null);
  assert.equal(task.end, null);
  assert.equal(task.syncStatus, 'attention');
  assert.equal(task.issue, task.agent.notice);
  assert.deepEqual(task.dirty, {});
  await connect(h, 'work');
  const restarted = fixture(h.google, h.store.saved);
  restarted.service.estimate = () => { throw new Error('A timer must not request a model estimate'); };
  restarted.service.updateSettings({ startTime: '08:00' });
  await successfulSync(restarted.service);
  restarted.service.updateSettings({ calendarMode: 'sync' });
  await connect(restarted, 'work', 'sync');
  await successfulSync(restarted.service);
  assert.equal(savedTask(restarted, id).issue, task.agent.notice);
  await restarted.service.editTask(id, { minutes: 80, category: 'writing', day: '2026-11-24' });
  await restarted.service.editTask(id, { done: true });
  await successfulSync(restarted.service);
  assert.equal(savedTask(restarted, id).done, true);
  await assert.rejects(restarted.service.retryEstimate(id), { status: 409 });
  await restarted.service.editTask(id, { done: false });
  await successfulSync(restarted.service);
  task = savedTask(restarted, id);
  assert.equal(task.start, null);
  assert.equal(task.pendingEstimate, true);
  assert.deepEqual(h.google.eventCalls, []);
  restarted.service.deleteTask(id);
  await successfulSync(restarted.service);
  assert.equal(savedTask(restarted, id), undefined);
  assert.equal(h.google.events.size, 0);
});

test('only an explicit successful retry schedules the task, preserving its pin and manual overrides', async () => {
  const h = availabilityFixture();
  const attempts = [];
  h.service.estimate = (_, context) => {
    attempts.push(context.now.toISOString());
    return modelEstimate(attempts.length < 3);
  };
  const id = await h.service.createTask({ text: 'Review the proposal', day: '2026-11-25' });
  await h.service.editTask(id, { minutes: 80, category: 'writing' });
  h.service.clock = () => new Date('2026-11-24T08:00:00.000Z');
  await h.service.run(() => h.service.retryEstimate(id));
  assert.equal(savedTask(h, id).pendingEstimate, true);
  assert.equal(savedTask(h, id).start, null);
  await h.service.queueSync();
  assert.equal(attempts.length, 2);
  await h.service.run(() => h.service.retryEstimate(id));
  const placed = savedTask(h, id);
  assert.equal(placed.pendingEstimate, false);
  assert.equal(placed.agent.model, 'test-model');
  assert.equal(placed.category, 'writing');
  assert.equal(placed.minutes, 80);
  assert.equal(placed.start, '2026-11-25T09:00:00.000Z');
  assert.equal(placed.end, '2026-11-25T10:20:00.000Z');
  assert.equal(placed.issue, null);
  assert.deepEqual(attempts, [clock(), clock(), clock()].map(d => d.toISOString()));
  await assert.rejects(h.service.run(() => h.service.retryEstimate(id)), { status: 409 });
  assert.equal(attempts.length, 3);
});

test('a failed rename is saved for retry when local and leaves an existing Google reservation intact', async () => {
  const local = availabilityFixture();
  const id = await local.service.createTask({ text: 'An existing local review' });
  assert.ok(savedTask(local, id).start);
  local.service.estimate = () => modelEstimate(true);
  await local.service.editTask(id, { text: 'Review the detailed proposal' });
  const waiting = savedTask(local, id);
  assert.equal(waiting.text, 'Review the detailed proposal');
  assert.equal(waiting.pendingEstimate, true);
  assert.equal(waiting.start, null);
  assert.equal(waiting.end, null);

  const linked = fixture();
  const existing = await create(linked);
  linked.google.eventCalls = [];
  const original = structuredClone(linked.google.events.get(existing.remote.eventId));
  linked.service.estimate = () => modelEstimate(true);
  await assert.rejects(linked.service.editTask(existing.id, { text: 'A different reservation' }), { status: 409 });
  assert.deepEqual(savedTask(linked, existing.id), existing);
  assert.deepEqual(linked.google.events.get(existing.remote.eventId), original);
  assert.deepEqual(linked.google.eventCalls, []);
  await successfulSync(linked.service);
  assert.deepEqual(linked.google.events.get(existing.remote.eventId), original);
  assert.equal(linked.google.eventCalls.some(c => ['putTaskEvent', 'deleteTaskEvent'].includes(c.method)), false);
});

test('a saved remote fallback can retry in place with its legacy pinned date and existing event ID', async () => {
  const old = fixture();
  const id = await old.service.createTask({ text: 'Review the proposal', day: '2026-11-25' });
  await successfulSync(old.service);
  const data = structuredClone(old.store.saved);
  const previous = data.tasks[0];
  previous.agent = { provider: 'codex', outcome: 'fallback' };
  delete previous.pendingEstimate;
  delete previous.estimateOverrides;
  const h = fixture(old.google, data);
  let calls = 0;
  h.service.estimate = () => { calls++; return { ...modelEstimate(), earliestDay: '2026-11-26', latestDay: '2026-11-26' }; };
  await h.service.run(() => h.service.retryEstimate(id));
  await successfulSync(h.service);
  const upgraded = savedTask(h, id);
  assert.equal(calls, 1);
  assert.equal(h.google.insertRequests, 1);
  assert.equal(upgraded.remote.eventId, previous.remote.eventId);
  assert.equal(upgraded.earliestDay, '2026-11-25');
  assert.equal(upgraded.latestDay, '2026-11-25');
  assert.equal(upgraded.agent.model, 'test-model');
  assert.ok(upgraded.start.startsWith('2026-11-25T'));
  assert.equal(h.google.events.get(previous.remote.eventId).end, upgraded.end);
});
