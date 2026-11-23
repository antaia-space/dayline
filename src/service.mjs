import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DateTime, IANAZone } from 'luxon';
import * as googleCalendar from './google.mjs';
import { CATEGORIES, estimateTask, findSlot, planningRange } from './planner.mjs';

const id = () => randomUUID().replaceAll('-', '');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const owns = (value, key) => Object.hasOwn(value, key);
const messageOf = error => error?.message || 'Google Calendar could not be reached.';
const recordKey = (sub, calendarId) => Buffer.from(JSON.stringify([sub, calendarId])).toString('base64url');
const publicCalendar = ({ providerId, sub, ...visible }) => visible;

export function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function taskText(text) {
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 1000) {
    throw invalid('Enter a task between 1 and 1,000 characters.');
  }
  return text.trim();
}

function requestedDay(day) {
  if (day == null || day === '') return null;
  if (typeof day !== 'string' || !DAY.test(day) || !DateTime.fromISO(day).isValid) throw invalid('Choose a valid date.');
  return day;
}

function safeTask(task) {
  const { remote, dirty, intent, held, deleting, ...visible } = task;
  return visible;
}

export class DaylineService {
  constructor({ store, vault, google = googleCalendar, estimate = estimateTask, clock = () => new Date(), bundledClient = null }) {
    this.store = store;
    this.data = store.state;
    this.vault = vault;
    this.google = google;
    this.estimate = estimate;
    this.clock = clock;
    this.bundledClient = bundledClient;
    this.origin = '';
    this.calendars = [];
    this.busy = [];
    this.busyRange = null;
    this.error = null;
    this.syncing = false;
    this.tail = Promise.resolve();
    this.pendingSync = null;
    this.auth = new Map();
    this.tokens = new Map();
  }

  // All disk and calendar writers run in order, including timer, browser and desktop requests.
  run(work) {
    const operation = this.tail.then(work);
    this.tail = operation.catch(() => {});
    return operation;
  }

  snapshot() {
    const accounts = this.data.accounts.map(({ sub, email }) => ({ sub, email }));
    return {
      tasks: this.data.tasks.map(safeTask),
      settings: structuredClone(this.data.settings),
      categories: CATEGORIES,
      calendars: this.calendars.map(publicCalendar),
      connection: {
        configured: Boolean(this.data.client || this.bundledClient),
        connected: accounts.length > 0,
        email: accounts[0]?.email || null, accounts,
        syncing: this.syncing, lastSync: this.data.lastSync, error: this.error
      },
      busy: this.busy, busyStart: this.busyRange?.start || null, busyEnd: this.busyRange?.end || null,
      now: this.clock().toISOString(),
      appVersion: '1.0.0'
    };
  }

  queueSync() {
    if (this.pendingSync) return this.pendingSync;
    this.syncing = true;
    this.pendingSync = this.run(() => this.reconcile()).finally(() => {
      this.pendingSync = null;
      this.syncing = false;
    });
    // Background failures remain visible in the next snapshot.
    this.pendingSync.catch(error => { this.error = messageOf(error); });
    return this.pendingSync;
  }

  findTask(taskId) {
    const task = this.data.tasks.find(item => item.id === taskId);
    if (!task) throw invalid('This task is no longer in this planner.', 404);
    return task;
  }

  localBusy(except) {
    return this.data.tasks.filter(t => t.id !== except && t.start && t.end && !t.deleting)
      .map(({ start, end }) => ({ start, end }));
  }

  planLocal(task) {
    const slot = findSlot({ task, settings: this.data.settings, busy: this.localBusy(task.id), now: this.clock() });
    Object.assign(task, slot || { start: null, end: null });
    task.syncStatus = slot ? 'local' : 'attention';
    task.issue = slot ? null : 'No open work period fits. Change the day, duration, or working hours.';
  }

  async createTask(input) {
    const text = taskText(input.text);
    if (input.requestId != null && (typeof input.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(input.requestId))) throw invalid('Invalid task request identifier.');
    if (input.requestId && this.data.tasks.some(t => t.id === input.requestId)) return input.requestId;
    const day = requestedDay(input.day);
    const now = this.clock();
    const estimate = await this.estimate(text, { now, timeZone: this.data.settings.timeZone });
    const task = {
      id: input.requestId || id(), text, category: estimate.category, minutes: estimate.minutes, reason: estimate.reason,
      earliestDay: day || estimate.earliestDay, latestDay: day || estimate.latestDay,
      windowStart: estimate.windowStart, windowEnd: estimate.windowEnd, deadlineTime: day ? null : (estimate.deadlineTime || null),
      start: null, end: null, done: false, syncStatus: 'pending', issue: null,
      createdAt: now.toISOString(), dirty: { schedule: true }, remote: null, intent: null, held: false
    };
    if (!this.data.accounts.length) this.planLocal(task);
    this.data.tasks.push(task);
    this.store.save();
    return task.id;
  }

  async editTask(taskId, input) {
    const task = this.findTask(taskId);
    if (task.deleting) throw invalid('This task is waiting for its calendar entry to be removed.', 409);
    if (!Object.keys(input).length || Object.keys(input).some(k => !['done', 'text', 'minutes', 'category', 'day'].includes(k))) {
      throw invalid('Unknown task change.');
    }
    const changed = structuredClone(task);
    if (owns(input, 'text')) {
      const text = taskText(input.text);
      if (text !== task.text) {
        const guess = await this.estimate(text, { now: this.clock(), timeZone: this.data.settings.timeZone });
        Object.assign(changed, { text, category: guess.category, minutes: guess.minutes, reason: guess.reason,
          earliestDay: guess.earliestDay, latestDay: guess.latestDay, windowStart: guess.windowStart, windowEnd: guess.windowEnd, deadlineTime: guess.deadlineTime || null });
        Object.assign(changed.dirty, { text: true, category: true, schedule: true });
      }
    }
    if (owns(input, 'category')) {
      if (!CATEGORIES.some(c => c.id === input.category)) throw invalid('Choose a task type from the list.');
      if (changed.category !== input.category) { changed.category = input.category; changed.dirty.category = true; }
    }
    if (owns(input, 'minutes')) {
      if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 1440) throw invalid('Choose a duration of 1 to 1,440 minutes.');
      if (changed.minutes !== input.minutes) {
        changed.minutes = input.minutes;
        changed.reason = 'Duration set by you.';
        changed.dirty.schedule = true;
      }
    }
    if (owns(input, 'day')) {
      const day = requestedDay(input.day);
      if (changed.held || changed.earliestDay !== day || changed.latestDay !== day) {
        changed.earliestDay = day;
        changed.latestDay = day;
        changed.deadlineTime = null;
        changed.dirty.schedule = true;
      }
    }
    if (owns(input, 'done')) {
      if (typeof input.done !== 'boolean') throw invalid('Choose complete or open.');
      if (changed.done !== input.done) { changed.done = input.done; changed.dirty.done = true; }
    }
    if (changed.dirty.schedule) changed.held = false;
    changed.issue = null;
    changed.syncStatus = Object.keys(changed.dirty).length ? 'pending' : changed.syncStatus;
    if (!this.data.accounts.length && !changed.remote && !changed.intent) {
      if (changed.dirty.schedule && !changed.done) this.planLocal(changed);
      else changed.syncStatus = 'local';
    }
    Object.assign(task, changed);
    this.store.save();
  }

  deleteTask(taskId) {
    const task = this.findTask(taskId);
    if (task.remote || task.intent) {
      task.deleting = true;
      task.syncStatus = 'deleting';
      task.issue = 'Waiting to remove the linked Google event.';
    } else {
      this.data.tasks = this.data.tasks.filter(t => t.id !== taskId);
    }
    this.store.save();
  }

  updateSettings(input) {
    const old = this.data.settings;
    if (Object.keys(input).some(key => !owns(old, key))) throw invalid('Unknown planner setting.');
    const next = { ...old, ...input };
    if (typeof next.timeZone !== 'string' || !(IANAZone.isValidZone(next.timeZone) || next.timeZone === 'UTC')) throw invalid('Choose an IANA time zone.');
    if (!Array.isArray(next.workDays) || !next.workDays.length || !next.workDays.every(d => Number.isInteger(d) && d >= 1 && d <= 7)) throw invalid('Choose at least one working day.');
    if (!CLOCK.test(next.startTime) || !CLOCK.test(next.endTime) || next.startTime >= next.endTime) throw invalid('Work must end after it starts on the same day.');
    if (!Array.isArray(next.excludedCalendarIds) || !next.excludedCalendarIds.every(k => typeof k === 'string')) throw invalid('Choose valid calendars.');
    if (typeof next.targetCalendarId !== 'string' || (next.targetCalendarId !== old.targetCalendarId && next.targetCalendarId !== 'primary' && !this.calendars.some(c => c.id === next.targetCalendarId && c.writable))) throw invalid('Choose a writable destination calendar.');
    next.workDays = [...new Set(next.workDays)].sort();
    this.data.settings = next;
    const hoursChanged = ['timeZone', 'workDays', 'startTime', 'endTime'].some(k => JSON.stringify(old[k]) !== JSON.stringify(next[k]));
    if (hoursChanged) {
      for (const task of this.data.tasks) {
        if (task.done || task.held || task.deleting || (task.end && Date.parse(task.end) <= this.clock().getTime())) continue;
        if (task.start && this.fitsHours(task.start, task.end)) continue;
        task.dirty.schedule = true;
        task.syncStatus = 'pending';
        if (!this.data.accounts.length && !task.remote && !task.intent) this.planLocal(task);
      }
    }
    this.store.save();
  }

  fitsHours(start, end) {
    const s = this.data.settings;
    const from = DateTime.fromISO(start, { zone: s.timeZone });
    const to = DateTime.fromISO(end, { zone: s.timeZone });
    return from.toISODate() === to.toISODate() && s.workDays.includes(from.weekday) &&
      from.toFormat('HH:mm') >= s.startTime && to.toFormat('HH:mm') <= s.endTime;
  }

  async configure({ clientId, clientSecret }) {
    if (typeof clientId !== 'string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientId.length > 300) throw invalid('Import the JSON for a Google Desktop OAuth client.');
    if (clientSecret != null && (typeof clientSecret !== 'string' || clientSecret.length > 500)) throw invalid('Invalid desktop client secret.');
    if (this.data.accounts.length && (await this.client()).clientId !== clientId) throw invalid('Disconnect your Google accounts before changing OAuth clients.');
    this.data.client = await this.vault.seal(JSON.stringify({ clientId, clientSecret: clientSecret || '' }));
    this.store.save();
  }

  async client() {
    if (this.data.client) return JSON.parse(await this.vault.open(this.data.client));
    if (this.bundledClient) return this.bundledClient;
    throw invalid('Import the Antaia Google Desktop OAuth client in Settings first.', 409);
  }

  async beginConnection() {
    const { clientId } = await this.client();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = this.origin + '/oauth/callback';
    for (const [key, request] of this.auth) if (request.expires < Date.now()) this.auth.delete(key);
    this.auth.set(state, { verifier, redirectUri, expires: Date.now() + 600000 });
    return { url: this.google.authorizationUrl({ clientId, redirectUri, state, codeChallenge }).toString() };
  }

  async finishConnection({ state, code, error }) {
    const request = this.auth.get(state);
    this.auth.delete(state);
    if (!request || request.expires < Date.now()) throw invalid('This sign-in request expired. Start again in Dayline.');
    if (error || !code) throw invalid('Google sign-in was cancelled. You can return to Dayline.');
    const tokens = await this.google.exchangeCode({ ...await this.client(), ...request, code });
    const profile = await this.google.getProfile(tokens.access_token);
    const existing = this.data.accounts.find(a => a.sub === profile.sub);
    if (!tokens.refresh_token && !existing?.secret) throw invalid('Google did not grant offline access. Reconnect and allow the requested calendar permissions.');
    const secret = tokens.refresh_token ? await this.vault.seal(tokens.refresh_token) : existing.secret;
    if (existing) Object.assign(existing, { email: profile.email, secret });
    else this.data.accounts.push({ ...profile, secret });
    this.cacheToken(profile.sub, tokens);
    this.error = null;
    this.store.save();
  }

  disconnect(sub) {
    if (sub != null && (typeof sub !== 'string' || !this.data.accounts.some(a => a.sub === sub))) throw invalid('Unknown Google account.');
    this.data.accounts = this.data.accounts.filter(a => sub && a.sub !== sub);
    this.calendars = this.calendars.filter(c => sub && c.sub !== sub);
    if (sub) this.tokens.delete(sub); else this.tokens.clear();
    this.busy = [];
    this.busyRange = null;
    this.error = null;
    this.auth.clear();
    for (const t of this.data.tasks) {
      if ((t.remote || t.intent) && !this.data.accounts.some(a => a.sub === (t.remote || t.intent).sub)) {
        t.syncStatus = t.deleting ? 'deleting' : 'pending';
        t.issue = 'Reconnect the original Google account to sync this event.';
      }
    }
    this.store.save();
  }

  cacheToken(sub, tokens) {
    this.tokens.set(sub, { access: tokens.access_token, expires: Date.now() + (tokens.expires_in || 3600) * 1000 });
  }

  async token(sub) {
    const cached = this.tokens.get(sub);
    if (cached && cached.expires > Date.now() + 60000) return cached.access;
    const account = this.data.accounts.find(a => a.sub === sub);
    if (!account) throw invalid('Reconnect the original Google account to sync this event.', 409);
    const tokens = await this.google.refreshToken({ ...await this.client(), refreshToken: await this.vault.open(account.secret) });
    this.cacheToken(sub, tokens);
    if (tokens.refresh_token) { account.secret = await this.vault.seal(tokens.refresh_token); this.store.save(); }
    return tokens.access_token;
  }

  async discover() {
    const groups = await Promise.all(this.data.accounts.map(async account => {
      const calendars = await this.google.listCalendars(await this.token(account.sub));
      return calendars.map(c => ({ ...c, sub: account.sub, accountEmail: account.email,
        providerId: c.id, id: recordKey(account.sub, c.id) }));
    }));
    this.calendars = groups.flat();
  }

  target() {
    const key = this.data.settings.targetCalendarId;
    const result = key === 'primary'
      ? this.calendars.find(c => c.sub === this.data.accounts[0]?.sub && c.primary)
      : this.calendars.find(c => c.id === key);
    if (!result?.writable) throw invalid('Select a writable task calendar in Settings.', 409);
    return result;
  }

  async availability(range) {
    const excluded = new Set(this.data.settings.excludedCalendarIds);
    const target = this.target();
    const chosen = this.calendars.filter(c => c.id === target.id || !excluded.has(c.id));
    const groups = await Promise.all(this.data.accounts.map(async account => {
      const calendarIds = chosen.filter(c => c.sub === account.sub).map(c => c.providerId);
      if (!calendarIds.length) return [];
      return this.google.getBusy(await this.token(account.sub), { ...range, calendarIds });
    }));
    return groups.flat();
  }

  acceptRemote(task, event, ref) {
    if (!event.owned || event.taskId !== task.id) throw invalid('Google could not verify ownership of the linked event.', 409);
    if (!event.start || !event.end) throw invalid('The linked event needs a timed start and end in Google Calendar.', 409);
    if (!task.dirty.text) task.text = event.text;
    if (!task.dirty.done) task.done = event.done;
    if (!task.dirty.schedule) {
      const length = Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60000);
      if (length > 0) task.minutes = length;
    }
    if (task.remote && task.remote.done !== event.done && !task.dirty.done) task.dirty.link = true;
    task.start = event.start;
    task.end = event.end;
    task.remote = { sub: ref.sub, calendarId: ref.calendarId, eventId: event.eventId, etag: event.etag, done: event.done };
    task.intent = null;
    task.issue = null;
    task.syncStatus = Object.keys(task.dirty).length ? 'pending' : 'synced';
  }

  async pullChanges() {
    const groups = new Map();
    for (const task of this.data.tasks) {
      if (!task.remote) continue;
      const ref = task.remote;
      const key = recordKey(ref.sub, ref.calendarId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    }
    for (const [key, tasks] of groups) {
      const calendar = this.calendars.find(c => c.id === key);
      if (!calendar) {
        for (const task of tasks) {
          task.issue = 'The original calendar is unavailable. Reconnect it to sync this task.';
          task.syncStatus = task.deleting ? 'deleting' : 'attention';
        }
        continue;
      }
      const access = await this.token(calendar.sub);
      const remoteEvents = await this.google.listTaskEvents(access, { calendarId: calendar.providerId });
      const byId = new Map(remoteEvents.map(e => [e.eventId, e]));
      for (const task of tasks) {
        const ref = task.remote;
        const event = byId.get(ref.eventId) || await this.google.getTaskEvent(access, { ...ref, taskId: task.id });
        if (event) { this.acceptRemote(task, event, ref); continue; }
        if (task.deleting) { this.data.tasks = this.data.tasks.filter(t => t !== task); continue; }
        // An explicit deletion in Calendar stays deleted. A new scheduling gesture can create a fresh event.
        Object.assign(task, { remote: null, intent: null, start: null, end: null, held: true, dirty: {},
          syncStatus: 'attention', issue: 'Removed in Google Calendar. Choose a day in the task editor to book it again.' });
      }
    }
  }

  async removeRemote(task) {
    const ref = task.remote || task.intent;
    await this.google.deleteTaskEvent(await this.token(ref.sub), { ...ref, expectedEtag: ref.etag || null, taskId: task.id });
    this.data.tasks = this.data.tasks.filter(t => t !== task);
    this.store.save();
  }

  async pushTask(task, rangeCache) {
    if (task.deleting) return this.removeRemote(task);
    if (task.held) return;
    if (task.done && !task.remote && !task.intent) {
      task.syncStatus = 'local';
      task.issue = null;
      return;
    }
    if (task.remote && !Object.keys(task.dirty).length) return;
    const { settings } = this.data;
    let ref = task.remote || task.intent;
    if (ref && !this.calendars.some(c => c.sub === ref.sub && c.providerId === ref.calendarId && c.writable)) {
      throw invalid('Reconnect the original writable calendar to sync this task.', 409);
    }

    // A previous insertion may already have reached Google even if the app lost its response.
    if (!task.remote && task.intent) {
      const found = await this.google.getTaskEvent(await this.token(ref.sub), { ...ref, taskId: task.id });
      if (found) {
        const later = { ...task.dirty };
        for (const field of ['text', 'category', 'done']) if (task[field] === task.intent.snapshot[field]) delete later[field];
        if (task.minutes === task.intent.snapshot.minutes && task.earliestDay === task.intent.snapshot.earliestDay &&
            task.latestDay === task.intent.snapshot.latestDay && task.windowStart === task.intent.snapshot.windowStart &&
            task.windowEnd === task.intent.snapshot.windowEnd && task.deadlineTime === task.intent.snapshot.deadlineTime) delete later.schedule;
        task.dirty = later;
        this.acceptRemote(task, found, ref);
        if (!Object.keys(later).length) { this.store.save(); return; }
        ref = task.remote;
      }
    }

    let slot = { start: task.start, end: task.end };
    let waitingForSlot = false;
    if (task.dirty.schedule || !ref) {
      const now = this.clock();
      const range = planningRange({ task, settings, now });
      let placement = null;
      if (range) {
        const cacheKey = range.start + '|' + range.end;
        if (!rangeCache.has(cacheKey)) rangeCache.set(cacheKey, await this.availability(range));
        // A shorter edit can reuse time this event already holds. Test the proposed
        // slice against every work/day constraint; it cannot introduce a new conflict.
        if (task.remote && Date.parse(task.start) >= now.getTime()) {
          const end = Date.parse(task.start) + task.minutes * 60000;
          if (end <= Date.parse(task.end)) {
            const candidate = findSlot({ task, settings, now: new Date(task.start), busy: this.localBusy(task.id) });
            if (candidate && Date.parse(candidate.start) === Date.parse(task.start)) placement = candidate;
          }
        }
        placement ||= findSlot({ task, settings, now, busy: [...rangeCache.get(cacheKey), ...this.localBusy(task.id)] });
      }
      if (!placement) {
        if (!task.remote) { task.start = null; task.end = null; }
        task.issue = task.remote
          ? 'No slot fits the new constraints. Google still holds the previous time.'
          : 'No open work period fits. Change the day, duration, or working hours.';
        task.syncStatus = 'attention';
        // A completion gesture still reaches an existing reservation when rescheduling cannot fit.
        if (!task.remote || !task.dirty.done) return;
        waitingForSlot = true;
      } else slot = placement;
    }
    if (!ref) {
      const dest = this.target();
      ref = { sub: dest.sub, calendarId: dest.providerId, eventId: id() };
    }
    const outgoing = { ...task, ...slot };
    if (!task.remote) {
      task.intent = { ...ref, snapshot: {
        text: task.text, category: task.category, done: task.done, minutes: task.minutes, earliestDay: task.earliestDay,
        latestDay: task.latestDay, windowStart: task.windowStart, windowEnd: task.windowEnd, deadlineTime: task.deadlineTime
      } };
      this.store.save();
    }
    const event = await this.google.putTaskEvent(await this.token(ref.sub), { ...ref, task: outgoing,
      actionUrl: this.origin + '/action/' + task.id + '?done=' + (task.done ? '0' : '1'),
      expectedEtag: task.remote?.etag || null });
    const issue = task.issue;
    task.dirty = waitingForSlot ? { schedule: true } : {};
    this.acceptRemote(task, event, ref);
    // The response is authoritative, including recovery from an idempotent duplicate insert.
    delete task.dirty.link;
    if (waitingForSlot) { task.issue = issue; task.syncStatus = 'attention'; }
    else task.syncStatus = 'synced';
    this.store.save();
  }

  async reconcile() {
    this.error = null;
    if (!this.data.accounts.length) return;
    try {
      await this.discover();
      await this.pullChanges();
      this.store.save();
      const rangeCache = new Map();
      let firstError = null;
      for (const task of [...this.data.tasks]) {
        try { await this.pushTask(task, rangeCache); }
        catch (error) {
          task.issue = messageOf(error);
          task.syncStatus = task.deleting ? 'deleting' : 'attention';
          firstError ||= task.issue;
          if (error.status === 401) this.tokens.clear();
        }
      }
      const monday = DateTime.fromJSDate(this.clock(), { zone: this.data.settings.timeZone }).startOf('week');
      const range = { start: monday.toUTC().toISO(), end: monday.plus({ weeks: 5 }).toUTC().toISO() };
      this.busy = await this.availability(range);
      this.busyRange = range;
      if (firstError) this.error = firstError;
      else this.data.lastSync = this.clock().toISOString();
    } catch (error) {
      this.error = messageOf(error);
      if (error.status === 401) this.tokens.clear();
      for (const task of this.data.tasks) {
        if (!(task.done && !task.remote) && (!task.remote || Object.keys(task.dirty).length) && !task.held) {
          task.syncStatus = task.deleting ? 'deleting' : 'attention';
          task.issue = this.error;
        }
      }
    } finally { this.store.save(); }
  }
}
