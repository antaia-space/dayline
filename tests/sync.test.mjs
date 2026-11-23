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
    return this.catalogs[account].map(c => ({ canInspectReservations: c.writable === true, ...c }));
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
      .filter(e => !e.transparent && calendarIds.includes(e.calendarId) && Date.parse(e.end) > Date.parse(start) && Date.parse(e.start) < Date.parse(end))
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

  hasOtherBusyEvent(account, { calendarId, eventId, eventIds = [eventId], start, end }) {
    this.eventCalls.push({ method: 'hasOtherBusyEvent', account });
    this.checkAccess(account, calendarId, true);
    const live = [...this.meetings, ...this.events.values()].filter(e => e.calendarId === calendarId &&
      Date.parse(e.end) > Date.parse(start) && Date.parse(e.start) < Date.parse(end));
    return eventIds.some(id => !live.some(e => e.eventId === id)) || live.some(e => !e.transparent && !eventIds.includes(e.eventId));
  }

  busyWithoutReservations(account, { calendarId, start, end, reservations }) {
    this.checkAccess(account,calendarId,true);
    const ignored = new Set();
    for (const ref of reservations) {
      const event = this.events.get(ref.eventId);
      if (!event?.owned || event.calendarId !== calendarId || event.taskId !== ref.taskId || event.etag !== ref.etag) throw failure(412,'The event version changed');
      ignored.add(ref.eventId);
    }
    return [...this.meetings,...this.events.values()].filter(e => !e.transparent && e.calendarId === calendarId && !ignored.has(e.eventId) &&
      Date.parse(e.end) > Date.parse(start) && Date.parse(e.start) < Date.parse(end)).map(e => ({start:e.start,end:e.end}));
  }

  putTaskEvent(account, { calendarId, eventId, task, expectedEtag, actionUrl, completionAction }) {
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
      ...existing,
      eventId, taskId: task.id, owned: true, calendarId, etag: (existing?.etag ?? 0) + 1,
      text: task.text, done: task.done, start: task.start, end: task.end, category: task.category, actionUrl,
    };
    if (completionAction === 'free') result.transparent = true;
    if (completionAction === 'book') result.transparent = false;
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

test('an explicitly moved elapsed reservation retains one Google event ID and a separate local history marker, and a newly shared appointment stays untouched', async () => {
  const h=fixture(), created=await create(h), service=h.service;
  const task=service.findTask(created.id), eventId=task.remote.eventId;
  service.clock=()=>new Date(at('11:00'));
  const input={day:'2026-11-24',sourceStart:task.start,sourceEnd:task.end,requestId:'1'.repeat(32)};
  const moved=service.moveTaskLater(task.id,input);
  assert.equal(service.snapshot().tasks[0].start,null);
  assert.deepEqual(h.google.events.get(eventId).start,input.sourceStart);
  await successfulSync(service);
  assert.equal(h.google.events.size,1); assert.equal(task.remote.eventId,eventId);
  assert.equal(h.google.events.get(eventId).start,'2026-11-24T09:00:00.000Z');
  assert.deepEqual(service.snapshot().tasks[0].movedSlots,[moved.movedSlot]);
  service.clock=()=>new Date('2026-11-24T11:00:00Z');
  service.moveTaskLater(task.id,{day:'2026-11-25',sourceStart:task.start,sourceEnd:task.end,requestId:'2'.repeat(32)});
  h.google.change(eventId,{calendarAppointment:true});
  const writes=h.google.eventCalls.filter(call=>call.method==='putTaskEvent').length;
  await service.queueSync();
  assert.equal(h.google.events.get(eventId).start,'2026-11-24T09:00:00.000Z');
  assert.equal(h.google.eventCalls.filter(call=>call.method==='putTaskEvent').length,writes);
  assert.equal(h.google.events.size,1); assert.equal(service.snapshot().tasks[0].canMoveLater,false);
});

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
  assert.equal(recovered.start, null);
  assert.equal(event.start, at('11:00'));
  assert.equal(event.transparent,true);
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
  assert.equal(merged.start, null);
  assert.equal(remote.start, at('13:00'));
  assert.equal(remote.transparent,true);
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

test('shortening a flexible reservation avoids meetings that now overlap its old time', async () => {
  for (const calendarId of ['home-primary', 'work-primary']) {
    const h = fixture();
    const task = await create(h);
    h.google.meetings.push({ calendarId, start: at('09:00'), end: at('09:15') });
    await h.service.editTask(task.id, { minutes: 15 });
    await successfulSync(h.service);
    const changed = h.google.events.get(task.remote.eventId);
    assert.ok(Date.parse(changed.start) >= Date.parse(at('09:15')), calendarId);
    assert.equal(Date.parse(changed.end) - Date.parse(changed.start), 15 * 60000);
    assert.equal(h.google.insertRequests, 1);
  }
});

test('rescheduling checks the original destination even when it is unchecked for new tasks', async () => {
  const h = fixture();
  const task = await create(h);
  const calendars = h.service.snapshot().calendars;
  const home = calendars.find(c => c.name === 'Home');
  const work = calendars.find(c => c.name === 'Work');
  h.service.updateSettings({ targetCalendarId: home.id, excludedCalendarIds: [work.id] });
  h.google.meetings.push({ calendarId: 'work-primary', start: at('09:30'), end: at('10:00') });
  await h.service.editTask(task.id, { minutes: 60 });
  await successfulSync(h.service);
  const changed = h.google.events.get(task.remote.eventId);
  assert.deepEqual([changed.calendarId, changed.start, changed.end], ['work-primary', at('10:00'), at('11:00')]);
});

test('an all-day Google edit stays on its calendar date in a western planning time zone', async () => {
  const h = fixture();
  h.service.updateSettings({ timeZone: 'America/Los_Angeles' });
  const task = await create(h);
  h.google.change(task.remote.eventId, { start: day, end: '2026-11-24' });
  await successfulSync(h.service);
  const changed = h.store.saved.tasks[0];
  assert.deepEqual([changed.start, changed.end], ['2026-11-23T08:00:00.000Z', '2026-11-24T08:00:00.000Z']);
  assert.equal(changed.minutes, 30);
  assert.equal(h.service.snapshot().tasks[0].allDay, true);
  h.service.updateSettings({ timeZone: 'Pacific/Honolulu' });
  await successfulSync(h.service);
  assert.equal(h.store.saved.tasks[0].start, '2026-11-23T10:00:00.000Z');
  assert.equal(h.google.events.get(task.remote.eventId).start, day);
  await h.service.editTask(task.id, { done: true });
  await successfulSync(h.service);
  const remote = h.google.events.get(task.remote.eventId);
  assert.deepEqual([remote.start, remote.end, remote.done], [day, '2026-11-24', true]);
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

test('adding and removing a meeting compacts flexible tasks in list order and exposes an impossible appointment', async () => {
  const h = availabilityFixture();
  await connect(h, 'work');
  const first = await createLocal(h, 'Read the brief for 30 minutes');
  const second = await createLocal(h, 'Write notes for 30 minutes');
  const appointment = await createLocal(h, 'Call a supplier today at 10am for 30 minutes');
  assert.deepEqual([first, second, appointment].map(id => savedTask(h, id).start), [at('09:00'), at('09:30'), at('10:00')]);

  h.google.meetings.push({ calendarId: 'work-primary', start: at('09:00'), end: at('09:30') });
  await successfulSync(h.service);
  assert.deepEqual([first, second, appointment].map(id => savedTask(h, id).start), [at('09:30'), at('10:30'), at('10:00')]);
  h.google.meetings = [];
  await successfulSync(h.service);
  assert.deepEqual([first, second, appointment].map(id => savedTask(h, id).start), [at('09:00'), at('09:30'), at('10:00')]);
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

test('completed and started fixed-time blocks keep their history through conflicts and read outages', async () => {
  const h = availabilityFixture();
  const started = await h.service.createTask({ text: 'Write minutes at 9am for 30 minutes' });
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
  assert.equal(savedTask(h, completed).start, null);
  assert.equal(savedTask(h, completed).completedDay, day);
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
  assert.equal(h.google.events.get(completed.remote.eventId).start, completed.start);
  assert.equal(h.google.events.get(completed.remote.eventId).transparent,true);
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

test('a model estimate skips a read-only all-day block in local time and retains its slot after restart', async () => {
  const h = availabilityFixture();
  h.service.updateSettings({ timeZone: 'America/Los_Angeles' });
  h.google.catalogs.home[0].writable = false;
  h.google.catalogs.work = [{ id: 'weeks', name: 'Week Numbers', canCheckAvailability: false, writable: false }];
  h.google.meetings.push({ calendarId: 'home-primary', start: at('08:00'), end: '2026-11-24T08:00:00.000Z' });
  await connect(h, 'work');
  await connect(h, 'home');
  h.service.estimate = () => modelEstimate();
  const id = await createLocal(h, 'Review the project outline');
  const expected = ['2026-11-24T17:00:00.000Z', '2026-11-24T17:45:00.000Z'];
  const check = context => {
    const task = savedTask(context, id);
    assert.equal(task.agent.outcome, 'model');
    assert.deepEqual([task.start, task.end], expected);
  };
  check(h);
  const restarted = fixture(h.google, h.store.saved);
  restarted.service.estimate = () => { throw new Error('Reopening must not re-estimate'); };
  await successfulSync(restarted.service);
  check(restarted);
  assert.ok(h.google.busyQueries.length);
  assert.ok(h.google.busyQueries.every(q => q.account === 'home'));
  assert.deepEqual(h.google.eventCalls, []);
});

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

test('a later exact-time request shifts flexible Google reservations in their saved order and preserves every event ID', async () => {
  const h = fixture();
  const first = await create(h, 'Write the summary for 30 minutes today');
  const second = await create(h, 'File receipts for 30 minutes today');
  const untouched = await create(h, 'Review the brief for 30 minutes today');
  const id = await h.service.createTask({ text: 'Interview at 9am today for 60 minutes' });
  await successfulSync(h.service);
  assert.equal(savedTask(h, id).start, at('09:00'));
  assert.equal(h.google.events.get(first.remote.eventId).start, at('10:00'));
  assert.equal(h.google.events.get(second.remote.eventId).start, at('10:30'));
  assert.equal(h.google.events.get(untouched.remote.eventId).start, at('11:00'));
  assert.equal(h.google.insertRequests, 4);
  assert.ok(!h.google.eventCalls.some(call => call.method === 'deleteTaskEvent'));
});

test('real meetings overlapping an owned reservation remain occupied across every selected account and calendar', async () => {
  for (const calendarId of ['work-primary', 'shared-room', 'home-primary']) {
    const h = fixture();
    const flex = await create(h);
    const meeting = { calendarId, start: at('09:10'), end: at('09:20') };
    h.google.meetings = [structuredClone(meeting)];
    h.google.eventCalls = [];
    const id = await h.service.createTask({ text: 'Interview today at 9am for 30 minutes' });
    await successfulSync(h.service);
    assert.equal(savedTask(h, id).start, null);
    assert.match(savedTask(h, id).issue, /09:00/);
    assert.equal(h.google.events.get(flex.remote.eventId).start, at('09:20'));
    assert.deepEqual(h.google.meetings, [meeting]);
    assert.equal(h.google.insertRequests,1);
    assert.ok(!h.google.eventCalls.some(call => call.method === 'deleteTaskEvent'));
  }
});

test('a flexible Google event with no replacement is retained in its original slot', async () => {
  const h = fixture();
  h.service.updateSettings({ endTime: '09:30' });
  const flex = await create(h, 'Prepare the brief today for 30 minutes');
  const id = await h.service.createTask({ text: 'Review today at 9am for 30 minutes' });
  await successfulSync(h.service);
  assert.equal(savedTask(h, id).start, null);
  assert.match(savedTask(h, id).issue, /no other open slot/);
  assert.equal(h.google.events.get(flex.remote.eventId).start, at('09:00'));
  assert.equal(h.google.insertRequests, 1);
});

test('a time chosen manually in Google remains fixed after restarting the planner', async () => {
  const h = fixture();
  const flex = await create(h);
  h.google.change(flex.remote.eventId, { start: at('11:00'), end: at('11:30') });
  await successfulSync(h.service);
  const restarted = fixture(h.google, h.store.saved);
  const id = await restarted.service.createTask({ text: 'Call today at 11am for 15 minutes' });
  await successfulSync(restarted.service);
  assert.equal(savedTask(restarted, id).start, null);
  assert.equal(restarted.google.events.get(flex.remote.eventId).start, at('11:00'));
  assert.equal(restarted.google.insertRequests, 1);
});

test('a Dayline block converted into a shared meeting in Google keeps its time',async () => {
  const h = fixture();
  const flex = await create(h);
  h.google.change(flex.remote.eventId,{calendarAppointment:true});
  const id = await h.service.createTask({text:'Interview today at 9am for 15 minutes'});
  await successfulSync(h.service);
  assert.equal(savedTask(h,id).start,null);
  assert.equal(h.google.events.get(flex.remote.eventId).start,at('09:00'));
  assert.equal(h.google.insertRequests,1);
});

test('a lost relocation response recovers after restart without duplicates or lost reservations', async () => {
  const h = fixture();
  const first = await create(h, 'Write the summary for 30 minutes today');
  const second = await create(h, 'File receipts for 30 minutes today');
  const put = h.google.putTaskEvent.bind(h.google);
  let drop = true;
  h.google.putTaskEvent = (account, input) => {
    const result = put(account, input);
    if (input.expectedEtag != null && drop) { drop = false; throw failure(503, 'Lost the relocation response'); }
    return result;
  };
  const id = await h.service.createTask({ text: 'Interview at 9am today for 60 minutes' });
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error, /relocation response/);
  assert.equal(h.google.events.size, 2);
  assert.equal(savedTask(h, first.id).start, at('09:00'));
  assert.equal(h.google.events.get(first.remote.eventId).start, at('10:00'));
  assert.equal(h.google.events.get(second.remote.eventId).start, at('09:30'));

  const restarted = fixture(h.google, h.store.saved);
  await successfulSync(restarted.service);
  assert.equal(savedTask(restarted, id).start, at('09:00'));
  assert.equal(savedTask(restarted, first.id).remote.manualTime, undefined);
  assert.equal(h.google.events.get(first.remote.eventId).start, at('10:00'));
  assert.equal(h.google.events.get(second.remote.eventId).start, at('10:30'));
  assert.equal(h.google.insertRequests, 3);
  await successfulSync(restarted.service);
  assert.equal(h.google.events.size, 3);
});

test('a meeting that appears during relocation blocks the exact insertion on the final check', async () => {
  const h = fixture();
  const flexible = await create(h);
  const put = h.google.putTaskEvent.bind(h.google);
  h.google.putTaskEvent = (account, input) => {
    const result = put(account, input);
    if (input.expectedEtag != null) h.google.meetings.push({ calendarId: 'shared-room', start: at('09:00'), end: at('09:15') });
    return result;
  };
  const id = await h.service.createTask({ text: 'Call today at 9am for 15 minutes' });
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error, /occupies the requested time/);
  assert.equal(savedTask(h, id).remote, null);
  assert.equal(h.google.events.get(flexible.remote.eventId).start, at('09:15'));
  await successfulSync(h.service);
  assert.equal(savedTask(h, id).start, null);
  assert.equal(h.google.insertRequests, 1);
});

test('updated free/busy pulls owned flexible events to the first open minute in order and leaves repeated syncs write-free',async () => {
  const h = fixture();
  h.google.meetings = [{calendarId:'home-primary',start:at('09:00'),end:at('10:15')}];
  const a = await create(h,'Write the brief today for 25 minutes');
  const b = await create(h,'Review the notes today for 35 minutes');
  assert.equal(a.start,at('10:15'));
  assert.equal(b.start,at('10:40'));
  h.google.meetings[0].end = at('09:07');
  h.google.eventCalls = [];
  await successfulSync(h.service);
  assert.equal(h.google.events.get(a.remote.eventId).start,at('09:07'));
  assert.equal(h.google.events.get(b.remote.eventId).start,at('09:32'));
  assert.equal(h.google.eventCalls.filter(call => call.method === 'putTaskEvent').length,2);
  h.google.eventCalls = [];
  await successfulSync(h.service); await successfulSync(h.service);
  assert.equal(h.google.eventCalls.filter(call => call.method === 'putTaskEvent').length,0);
  assert.equal(h.google.insertRequests,2);
});

test('earliest available requests move ahead of owned flexible Google reservations without moving an external meeting',async () => {
  const h = fixture();
  const appointment = {calendarId:'home-primary',start:at('09:00'),end:at('09:15')};
  h.google.meetings=[appointment];
  const deck = await create(h,'Prepare the presentation today for 60 minutes');
  assert.equal(deck.start,at('09:15'));
  const call = await create(h,'Call hotel today for 10 minutes, as early in the day as possible');
  assert.deepEqual([call.start,h.google.events.get(deck.remote.eventId).start],[at('09:15'),at('09:25')]);
  assert.equal(h.google.events.get(call.remote.eventId).end,at('09:25'));
  assert.deepEqual(h.google.meetings,[appointment]);
  h.google.eventCalls=[]; await successfulSync(h.service);
  assert.equal(h.google.eventCalls.filter(e=>e.method==='putTaskEvent').length,0); assert.equal(h.google.insertRequests,2);
});

async function fullDaySwap() {
  const h = fixture();
  h.service.updateSettings({endTime:'10:00'});
  const a = await create(h,'Write notes today for 30 minutes');
  const b = await create(h,'Review the brief today for 30 minutes');
  h.service.data.tasks.reverse();
  h.store.save();
  h.google.eventCalls = [];
  return {h,a,b};
}

test('manual order swaps equal-length Google events in a fully booked window with stable IDs and no writes on the next sync',async () => {
  const {h,a,b} = await fullDaySwap();
  await successfulSync(h.service);
  assert.equal(h.google.events.get(b.remote.eventId).start,at('09:00'));
  assert.equal(h.google.events.get(a.remote.eventId).start,at('09:30'));
  assert.equal(h.google.eventCalls.filter(e => e.method === 'putTaskEvent').length,2);
  assert.equal(h.store.saved.eventMoveGroup,undefined);
  await successfulSync(h.service);
  assert.equal(h.google.eventCalls.filter(e => e.method === 'putTaskEvent').length,2);
  assert.equal(h.google.insertRequests,2);
});

test('restarting after a successful first half of a full-window swap finishes the saved pair without duplicate writes',async () => {
  const {h,a,b} = await fullDaySwap();
  const put = h.google.putTaskEvent.bind(h.google);
  let disconnect = true, patches = 0;
  h.google.putTaskEvent = (account,input) => {
    const result = put(account,input); patches++;
    if (disconnect) { disconnect = false; throw failure(503,'Connection lost after the first half of the swap'); }
    return result;
  };
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error,/first half/);
  assert.deepEqual(h.store.saved.eventMoveGroup.map(step => step.id),[b.id,a.id]);
  assert.equal(h.google.events.get(a.remote.eventId).start,at('09:00'));
  assert.equal(h.google.events.get(b.remote.eventId).start,at('09:00'));
  const resumed = fixture(h.google,h.store.saved);
  await successfulSync(resumed.service);
  assert.equal(h.google.events.get(b.remote.eventId).start,at('09:00'));
  assert.equal(h.google.events.get(a.remote.eventId).start,at('09:30'));
  assert.equal(resumed.store.saved.eventMoveGroup,undefined);
  await successfulSync(resumed.service);
  assert.equal(h.google.insertRequests,2);
  assert.equal(patches,2);
});

test('a fresh meeting that appears during the preflight of a fully booked swap prevents writes to either participant',async () => {
  const {h,a,b} = await fullDaySwap();
  const original = h.google.busyWithoutReservations.bind(h.google);
  h.google.busyWithoutReservations = (account,query) => {
    if (h.store.saved.eventMoveGroup && !h.google.meetings.length) {
      h.google.meetings.push({calendarId:'work-primary',start:at('09:15'),end:at('09:30')});
    }
    return original(account,query);
  };
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error,/reservation changed/);
  assert.equal(h.google.events.get(a.remote.eventId).start,at('09:00'));
  assert.equal(h.google.events.get(b.remote.eventId).start,at('09:30'));
  assert.equal(h.google.eventCalls.filter(e => e.method === 'putTaskEvent').length,0);
  assert.deepEqual(h.google.meetings,[{calendarId:'work-primary',start:at('09:15'),end:at('09:30')}]);
});

test('a conditional version race cannot turn a shared Google invitation into an automatically moved reservation',async () => {
  const {h,a,b} = await fullDaySwap();
  h.google.nextPatchRace = {calendarAppointment:true};
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error,/version changed/);
  assert.equal(h.google.events.get(a.remote.eventId).start,at('09:00'));
  assert.equal(h.google.events.get(b.remote.eventId).start,at('09:30'));
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error,/reservation changed/);
  await successfulSync(h.service);
  assert.equal(h.google.events.get(b.remote.eventId).start,at('09:30'));
  assert.equal(h.google.events.get(b.remote.eventId).calendarAppointment,true);
  assert.equal(h.google.insertRequests,2);
});

async function fittingGoogleDay() {
  const h = fixture();
  h.service.updateSettings({ endTime: '09:40' });
  h.service.estimate = () => ({ ...modelEstimate(), minutes: 40, baseMinutes: 40, estimatedMinutes: 40 });
  const taskId = await h.service.createTask({ text: 'Draft the release summary', day });
  await successfulSync(h.service);
  const task = savedTask(h,taskId);
  assert.deepEqual([task.start,task.end],[at('09:00'),at('09:40')]);
  h.google.meetings = [{ calendarId: 'work-primary', start: at('09:00'), end: at('09:07') }];
  return {h,task};
}

test('a new meeting fits the estimated Google task to its planned day and the original length survives a lost PATCH and restores',async () => {
  const {h,task} = await fittingGoogleDay();
  const put = h.google.putTaskEvent.bind(h.google);
  let drop = true;
  h.google.putTaskEvent = (account,input) => {
    const result = put(account,input);
    if (drop) { drop = false; throw failure(503,'Lost the automatic calendar resize'); }
    return result;
  };
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error,/automatic calendar resize/);
  assert.equal(h.google.events.get(task.remote.eventId).start,at('09:07'));
  const resumed = fixture(h.google,h.store.saved);
  await successfulSync(resumed.service);
  const shortened = savedTask(resumed,task.id);
  assert.deepEqual([shortened.start,shortened.end,shortened.minutes,shortened.calendarFit.originalMinutes],
    [at('09:07'),at('09:40'),33,40]);
  assert.equal(shortened.estimatedMinutes,40);
  h.google.meetings = [];
  await successfulSync(resumed.service);
  const restored = savedTask(resumed,task.id);
  assert.deepEqual([restored.start,restored.end,restored.minutes],[at('09:00'),at('09:40'),40]);
  assert.equal(restored.calendarFit,undefined);
  assert.equal(h.google.insertRequests,1);
});

test('manually resizing an auto-fitted task in Google clears the forecast adjustment and preserves that reservation',async () => {
  const {h,task} = await fittingGoogleDay();
  await successfulSync(h.service);
  assert.equal(savedTask(h,task.id).calendarFit.originalMinutes,40);
  h.google.change(task.remote.eventId,{end:at('09:32')});
  h.google.meetings = [];
  await successfulSync(h.service);
  const manual = savedTask(h,task.id);
  assert.deepEqual([manual.start,manual.end,manual.minutes],[at('09:07'),at('09:32'),25]);
  assert.equal(manual.remote.manualTime,true);
  assert.equal(manual.calendarFit,undefined);
});

test('a repeated listing of the same Google calendar through a read-only account does not make its own flexible event look like an outside meeting',async () => {
  const h = fixture();
  h.google.catalogs.home.push({id:'work-primary',name:'Shared work calendar',writable:false});
  h.service.data.accounts.find(a => a.sub === 'home').mode = 'availability';
  h.google.meetings = [{calendarId:'shared-room',start:at('09:00'),end:at('09:10')}];
  const t = await create(h,'Review the brief today for 30 minutes');
  assert.equal(t.start,at('09:10'));
  h.google.meetings = [];
  await successfulSync(h.service);
  assert.equal(h.google.events.get(t.remote.eventId).start,at('09:00'));
  assert.ok(!h.google.eventCalls.some(call => call.account === 'home'));
  assert.equal(h.google.insertRequests,1);
});

test('a late sync places a still-future Google reservation from the current minute, preserving the previously elapsed time',async () => {
  const h = fixture();
  h.google.meetings = [{calendarId:'shared-room',start:at('09:00'),end:at('10:00')}];
  const task = await create(h,'File receipts today for 20 minutes');
  assert.equal(task.start,at('10:00'));
  h.google.meetings[0].end = at('09:08');
  h.service.clock = () => new Date('2026-11-23T09:12:17.000Z');
  await successfulSync(h.service);
  assert.equal(h.google.events.get(task.remote.eventId).start,at('09:13'));
  h.service.clock = () => new Date(at('09:18'));
  h.google.meetings[0].end = at('09:05');
  await successfulSync(h.service);
  assert.equal(h.google.events.get(task.remote.eventId).start,at('09:13'));
  assert.equal(h.google.insertRequests,1);
});

test('early completion releases the Google slot for the next task and reopening checks every calendar before reserving again',async () => {
  const h = fixture();
  const first = await create(h,'Write notes today for 30 minutes');
  const second = await create(h,'Collect receipts today for 15 minutes');
  await h.service.editTask(first.id,{done:true});
  await successfulSync(h.service);
  const done = savedTask(h,first.id);
  assert.deepEqual([done.start,done.end,done.completedDay],[null,null,day]);
  assert.equal(h.google.events.get(first.remote.eventId).transparent,true);
  assert.equal(h.google.events.get(second.remote.eventId).start,at('09:00'));
  h.google.meetings.push({calendarId:'shared-room',start:at('09:00'),end:at('09:20')});
  h.google.change(first.remote.eventId,{done:false});
  await successfulSync(h.service);
  const opened = savedTask(h,first.id);
  assert.equal(opened.remote.eventId,first.remote.eventId);
  assert.equal(opened.start,at('09:20'));
  assert.equal(opened.done,false);
  assert.equal(opened.completedDay,undefined);
  assert.equal(h.google.events.get(first.remote.eventId).transparent,false);
  assert.equal(h.google.insertRequests,2);
});

test('an in-progress checkmark from Google keeps elapsed history, releases the remainder and preserves the effort estimate',async () => {
  const h = fixture();
  const first = await create(h,'Write notes today for 30 minutes');
  const second = await create(h,'Collect receipts today for 20 minutes');
  h.service.clock = () => new Date('2026-11-23T09:12:40.000Z');
  h.google.change(first.remote.eventId,{done:true,updated:at('09:11')});
  await successfulSync(h.service);
  const completed = savedTask(h,first.id);
  assert.deepEqual([completed.start,completed.end,completed.minutes,completed.completedAt],[at('09:00'),at('09:11'),30,at('09:11')]);
  assert.equal(h.google.events.get(first.remote.eventId).end,at('09:11'));
  assert.equal(h.google.events.get(second.remote.eventId).start,at('09:13'));
  h.service.clock = () => new Date(at('09:18'));
  await successfulSync(h.service);
  assert.equal(savedTask(h,first.id).minutes,30);
  assert.equal(h.google.events.get(first.remote.eventId).end,at('09:11'));
});

test('a lost Google completion PATCH is recovered without reoccupying the slot or writing twice',async () => {
  const h = fixture(), first = await create(h);
  const put = h.google.putTaskEvent.bind(h.google);
  let count = 0;
  h.google.putTaskEvent = (account,input) => {
    const result = put(account,input);
    if (++count === 1) throw failure(503,'Lost completion response');
    return result;
  };
  await h.service.editTask(first.id,{done:true}); await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error,/Lost completion/);
  const restarted = fixture(h.google,h.store.saved);
  await successfulSync(restarted.service); await successfulSync(restarted.service);
  assert.equal(savedTask(restarted,first.id).start,null);
  assert.equal(h.google.events.get(first.remote.eventId).transparent,true);
  assert.equal(count,1);
  assert.equal(h.google.insertRequests,1);
});

test('a reopened fixed task stays free when a real Google meeting holds its requested time',async () => {
  const h = fixture();
  const task = await create(h,'Call today at 9am for 30 minutes');
  await h.service.editTask(task.id,{done:true}); await successfulSync(h.service);
  h.google.meetings = [{calendarId:'shared-room',start:at('09:00'),end:at('09:30')}];
  await h.service.editTask(task.id,{done:false}); await successfulSync(h.service);
  assert.equal(savedTask(h,task.id).start,null);
  assert.equal(savedTask(h,task.id).syncStatus,'attention');
  assert.equal(h.google.events.get(task.remote.eventId).transparent,true);
  h.google.meetings = [];
  await successfulSync(h.service);
  assert.equal(savedTask(h,task.id).start,at('09:00'));
  assert.equal(h.google.events.get(task.remote.eventId).transparent,false);
});

test('a lost reopen response preserves the confirmed opaque reservation and avoids another Google write',async () => {
  const h = fixture(), first = await create(h);
  await h.service.editTask(first.id,{done:true}); await successfulSync(h.service);
  const put = h.google.putTaskEvent.bind(h.google);
  let writes = 0;
  h.google.putTaskEvent = (account,input) => {
    const event = put(account,input);
    if (++writes === 1) throw failure(503,'Lost reopening response');
    return event;
  };
  h.google.meetings = [{calendarId:'shared-room',start:at('09:00'),end:at('09:25')}];
  await h.service.editTask(first.id,{done:false}); await h.service.queueSync();
  const reopened = h.google.events.get(first.remote.eventId);
  assert.deepEqual([reopened.done,reopened.transparent,reopened.start],[false,false,at('09:25')]);
  const restart = fixture(h.google,h.store.saved);
  await successfulSync(restart.service); await successfulSync(restart.service);
  assert.equal(savedTask(restart,first.id).start,at('09:25'));
  assert.equal(savedTask(restart,first.id).remote.releasedSlot,undefined);
  assert.equal(writes,1);
});

test('a personally owned all-day event stays all-day and free until reopening books a verified timed slot',async () => {
  const h = fixture(), first = await create(h);
  h.google.change(first.remote.eventId,{start:day,end:'2026-11-24'});
  await successfulSync(h.service);
  await h.service.editTask(first.id,{done:true}); await successfulSync(h.service);
  const completed = h.google.events.get(first.remote.eventId);
  assert.deepEqual([completed.start,completed.end,completed.transparent],[day,'2026-11-24',true]);
  assert.equal(savedTask(h,first.id).start,null);
  h.google.meetings = [{calendarId:'home-primary',start:at('09:00'),end:at('10:00')}];
  await h.service.editTask(first.id,{done:false}); await successfulSync(h.service);
  assert.deepEqual([savedTask(h,first.id).start,savedTask(h,first.id).minutes],[at('10:00'),30]);
  assert.equal(h.google.events.get(first.remote.eventId).transparent,false);
  assert.equal(h.google.insertRequests,1);
});

test('completion retains timing and busy status on a task that became a real shared appointment',async () => {
  const h = fixture(), task = await create(h);
  h.google.change(task.remote.eventId,{calendarAppointment:true});
  await successfulSync(h.service);
  await h.service.editTask(task.id,{done:true}); await successfulSync(h.service);
  const event = h.google.events.get(task.remote.eventId);
  assert.deepEqual([event.start,event.end,Boolean(event.transparent)],[at('09:00'),at('09:30'),false]);
  assert.equal(savedTask(h,task.id).remote.releasedSlot,undefined);
  const visible = h.service.snapshot().tasks.find(row=>row.id===task.id);
  assert.equal(visible.start,null);
  assert.deepEqual(visible.completedPlannedSlot,{start:at('09:00'),end:at('09:30')});
});

test('a watched Google task extends by five minutes, moves its adjacent flexible successor and stops at the next external meeting',async () => {
  const h = fixture(), running = await create(h,'Write notes today for 30 minutes');
  const next = await create(h,'File receipts today for 15 minutes');
  h.service.clock = () => new Date(at('09:29'));
  await successfulSync(h.service);
  assert.equal(savedTask(h,running.id).overrunWatchStart,running.start);
  h.service.clock = () => new Date('2026-11-23T09:30:10Z');
  await successfulSync(h.service);
  let current = savedTask(h,running.id);
  assert.deepEqual([current.end,current.minutes,current.overrunMinutes],[at('09:35'),30,5]);
  assert.equal(h.google.events.get(next.remote.eventId).start,at('09:35'));
  h.google.meetings = [{calendarId:'home-primary',start:at('09:37'),end:at('09:50')}];
  h.service.clock = () => new Date('2026-11-23T09:35:10Z');
  await successfulSync(h.service);
  current = savedTask(h,running.id);
  assert.deepEqual([current.end,current.minutes,current.overrunMinutes],[at('09:37'),30,7]);
  assert.equal(h.google.events.get(next.remote.eventId).start,at('09:50'));
  h.service.clock = () => new Date(at('09:37'));
  await successfulSync(h.service);
  assert.equal(h.google.events.get(running.remote.eventId).end,at('09:37'));
  assert.equal(h.google.insertRequests,2);
});

test('a lost overrun PATCH is adopted after restart with the same baseline estimate and no extra five minutes',async () => {
  const h = fixture(), running = await create(h);
  h.service.clock = () => new Date(at('09:29'));
  await successfulSync(h.service);
  const put = h.google.putTaskEvent.bind(h.google);
  let writes = 0;
  h.google.putTaskEvent = (account,input) => {
    const event = put(account,input);
    if (++writes === 1) throw failure(503,'Lost extension response');
    return event;
  };
  h.service.clock = () => new Date(at('09:30'));
  await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error,/extension response/);
  const restarted = fixture(h.google,h.store.saved);
  restarted.service.clock = h.service.clock;
  await successfulSync(restarted.service);
  const task = savedTask(restarted,running.id);
  assert.deepEqual([task.end,task.overrunMinutes,task.minutes],[at('09:35'),5,30]);
  assert.equal(h.google.events.get(running.remote.eventId).end,task.end);
  assert.equal(writes,1);
});

test('a fixed Google appointment or a long sleep prevents an automatic extension',async () => {
  for (const fixed of [true,false]) {
    const h = fixture(), running = await create(h);
    if (fixed) await create(h,'Call today at 9:30am for 15 minutes');
    h.service.clock = () => new Date(at('09:29'));
    await successfulSync(h.service);
    h.google.eventCalls = [];
    h.service.clock = () => new Date(at(fixed ? '09:30' : '10:15'));
    await successfulSync(h.service);
    assert.equal(h.google.events.get(running.remote.eventId).end,at('09:30'));
    assert.equal(savedTask(h,running.id).overrunMinutes,undefined);
    assert.equal(h.google.eventCalls.filter(call => call.method === 'putTaskEvent').length,0);
  }
});

test('a meeting booked inside a granted Google overrun takes back its minutes without changing the forecast',async () => {
  const h = fixture(), running = await create(h);
  h.service.clock = () => new Date(at('09:29')); await successfulSync(h.service);
  h.service.clock = () => new Date(at('09:30')); await successfulSync(h.service);
  assert.equal(h.google.events.get(running.remote.eventId).end,at('09:35'));
  h.google.meetings = [{calendarId:'work-primary',start:at('09:33'),end:at('10:15')}];
  h.service.clock = () => new Date(at('09:31')); await successfulSync(h.service);
  const trimmed = savedTask(h,running.id);
  assert.deepEqual([trimmed.end,trimmed.overrunMinutes,trimmed.minutes],[at('09:33'),3,30]);
  assert.deepEqual(h.google.meetings,[{calendarId:'work-primary',start:at('09:33'),end:at('10:15')}]);
});

test('an external meeting observed on the final check vetoes a proposed Google overrun',async () => {
  const h = fixture(), running = await create(h);
  h.service.clock = () => new Date(at('09:29')); await successfulSync(h.service);
  const read = h.google.busyWithoutReservations.bind(h.google);
  h.google.busyWithoutReservations = (account,q) => {
    if (q.confirm && !h.google.meetings.length) h.google.meetings.push({calendarId:'work-primary',start:at('09:30'),end:at('09:40')});
    return read(account,q);
  };
  h.service.clock = () => new Date(at('09:30')); await h.service.queueSync();
  assert.match(h.service.snapshot().connection.error,/availability changed/);
  assert.equal(h.google.events.get(running.remote.eventId).end,at('09:30'));
  assert.equal(savedTask(h,running.id).overrunMinutes,undefined);
});

test('pulling an actual Google parent checkmark updates child items while ordinary refresh preserves partial progress',async () => {
  const h = fixture(), task = await create(h);
  h.service.findTask(task.id).subtasks = [{id:'a',text:'Read',done:true},{id:'b',text:'File',done:false}];
  await successfulSync(h.service);
  assert.deepEqual(savedTask(h,task.id).subtasks.map(item => item.done),[true,false]);
  h.google.change(task.remote.eventId,{done:true}); await successfulSync(h.service);
  assert.deepEqual(savedTask(h,task.id).subtasks.map(item => item.done),[true,true]);
  h.google.change(task.remote.eventId,{done:false}); await successfulSync(h.service);
  assert.deepEqual(savedTask(h,task.id).subtasks.map(item => item.done),[false,false]);
});
