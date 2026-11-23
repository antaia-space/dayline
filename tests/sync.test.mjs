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

  refreshToken({ refreshToken }) {
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
    for (const id of calendarIds) this.checkAccess(account, id);
    return [...this.meetings, ...this.events.values()]
      .filter(e => calendarIds.includes(e.calendarId) && Date.parse(e.end) > Date.parse(start) && Date.parse(e.start) < Date.parse(end))
      .map(e => ({ start: e.start, end: e.end }));
  }

  listTaskEvents(account, { calendarId }) {
    this.checkAccess(account, calendarId);
    return structuredClone([...this.events.values()].filter(e => e.calendarId === calendarId));
  }

  getTaskEvent(account, { calendarId, eventId }) {
    this.checkAccess(account, calendarId);
    const found = this.events.get(eventId);
    return found?.calendarId === calendarId ? structuredClone(found) : null;
  }

  putTaskEvent(account, { calendarId, eventId, task, expectedEtag, actionUrl }) {
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
    version: 1, tasks: [], settings: { ...defaultSettings(), timeZone: 'UTC' },
    accounts: ['work', 'home'].map(sub => ({ sub, email: sub + '@example.test', secret: sub })),
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
  assert.equal(service.snapshot().connection.lastSync, clock().toISOString());
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
