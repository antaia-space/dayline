import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DateTime, IANAZone } from 'luxon';
import { migrateCalendarModes } from './store.mjs';
import metadata from '../package.json' with { type: 'json' };
import * as googleCalendar from './google.mjs';
import { CATEGORIES, estimateTask, findSlot, planningRange } from './planner.mjs';

const id = () => randomUUID().replaceAll('-', '');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const owns = (value, key) => Object.hasOwn(value, key);
const messageOf = error => error?.message || 'Google Calendar could not be reached.';
const recordKey = (sub, calendarId) => Buffer.from(JSON.stringify([sub, calendarId])).toString('base64url');
const scheduleFields = ['minutes', 'earliestDay', 'latestDay', 'windowStart', 'windowEnd', 'deadlineTime'];
const noSlot = 'No open work period fits. Change the day, duration, or working hours.';
const publicCalendar = ({ providerId, sub, canInspectReservations, ...visible }) => visible;

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
  const { remote, dirty, intent, pausedSync, lastLocalSlot, held, deleting, estimateOverrides, estimateRequestedAt, ...visible } = task;
  return { ...visible, allDay: Boolean(remote?.allDay) };
}

function isRemoteFallback(task) {
  return task.agent?.outcome === 'fallback' && task.agent.provider && task.agent.provider !== 'local';
}

// Older fallback records predate explicit overrides. Retain their known date
// constraints and any manual category/duration we can distinguish from the old rules.
function estimateOverrides(task, timeZone) {
  if (task.estimateOverrides) return { ...task.estimateOverrides };
  const overrides = {};
  if (!isRemoteFallback(task)) return overrides;
  if (task.earliestDay || task.latestDay) {
    overrides.dates = { earliestDay: task.earliestDay, latestDay: task.latestDay, deadlineTime: task.deadlineTime || null };
  }
  if (task.reason === 'Duration set by you.') overrides.minutes = task.minutes;
  const oldRules = estimateTask(task.text, { now: new Date(task.createdAt), timeZone });
  if (task.category !== oldRules.category) overrides.category = task.category;
  return overrides;
}

function applyEstimate(task, estimate, overrides) {
  Object.assign(task, {
    category: overrides.category || estimate.category,
    minutes: overrides.minutes ?? estimate.minutes,
    reason: estimate.pendingEstimate || !overrides.minutes ? estimate.reason : 'Duration set by you.',
    agent: estimate.agent, pendingEstimate: estimate.pendingEstimate === true, estimateOverrides: overrides,
    earliestDay: estimate.earliestDay, latestDay: estimate.latestDay, deadlineTime: estimate.deadlineTime || null,
    windowStart: estimate.windowStart, windowEnd: estimate.windowEnd,
  });
  if (overrides.dates) Object.assign(task, overrides.dates);
  if (owns(overrides, 'day')) {
    Object.assign(task, { earliestDay: overrides.day, latestDay: overrides.day, deadlineTime: null });
  } else if (overrides.viewDay && !task.earliestDay && !task.latestDay) {
    task.earliestDay = task.latestDay = overrides.viewDay;
  }
}

function waitForEstimate(task) {
  task.start = null;
  task.end = null;
  task.dirty = {};
  delete task.lastLocalSlot;
  task.syncStatus = task.done ? 'local' : 'attention';
  task.issue = task.done ? null : (task.agent?.notice || 'Waiting for a model estimate.');
}

function captureTask(task) {
  return Object.fromEntries(['text', 'category', 'done', 'start', 'end', ...scheduleFields].map(key => [key, task[key]]));
}

function combinedRanges(ranges) {
  const sorted = ranges.filter(Boolean).map(({ start, end }) => ({ start: Date.parse(start), end: Date.parse(end) }))
    .filter(range => Number.isFinite(range.start) && range.start < range.end).sort((a, b) => a.start - b.start);
  const combined = [];
  for (const range of sorted) {
    const previous = combined.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else combined.push(range);
  }
  return combined.map(({ start, end }) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() }));
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
    this.authVersion = 0;
    this.tokens = new Map();
    const migrated = migrateCalendarModes(this.data);
    if (this.data.settings.calendarMode === 'availability' && this.data.tasks.some(t =>
      t.remote || t.intent || t.deleting || Object.keys(t.dirty || {}).length)) {
      this.pauseEventSync();
      this.store.save();
    } else if (migrated) this.store.save();
  }

  // Preserve the identity and last known reservation when pausing. A lost insert
  // response can describe an existing event too, so its original ID must survive.
  pauseEventSync() {
    this.data.tasks = this.data.tasks.filter(task => !task.deleting);
    for (const task of this.data.tasks) {
      if (task.remote || task.intent) {
        task.pausedSync = {
          remote: task.remote, intent: task.intent, original: captureTask(task), priorChanges: task.dirty || {}
        };
      }
      task.remote = null;
      task.intent = null;
      task.dirty = {};
      if (!task.held && !task.pendingEstimate) {
        task.syncStatus = task.start || task.done ? 'local' : 'pending';
        task.issue = null;
      }
    }
  }

  resumeEventSync() {
    for (const task of this.data.tasks) {
      delete task.lastLocalSlot;
      const paused = task.pausedSync;
      if (paused) {
        task.remote = paused.remote;
        task.intent = paused.intent;
        task.dirty = { ...paused.priorChanges };
        for (const key of ['text', 'category', 'done']) {
          if (task[key] !== paused.original[key]) task.dirty[key] = true;
        }
        if (scheduleFields.some(key => task[key] !== paused.original[key]) ||
            (task.start && task.start !== paused.original.start)) task.dirty.schedule = true;
        delete task.pausedSync;
      }
      if (!task.pendingEstimate && !task.held && !(task.done && !task.remote && !task.intent)) {
        task.syncStatus = 'pending';
        task.issue = null;
      }
    }
  }

  // All disk and calendar writers run in order, including timer, browser and desktop requests.
  run(work) {
    const operation = this.tail.then(work);
    this.tail = operation.catch(() => {});
    return operation;
  }

  snapshot() {
    const accounts = this.data.accounts.map(({ sub, email, mode }) => ({ sub, email, mode }));
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
      appVersion: metadata.version
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
    return this.data.tasks.filter(t => t.id !== except && t.start && t.end && !t.deleting && !t.pendingEstimate)
      .map(({ start, end }) => ({ start, end }));
  }

  planLocal(task) {
    if (task.pendingEstimate) return;
    const slot = findSlot({ task, settings: this.data.settings, busy: this.localBusy(task.id), now: this.clock() });
    Object.assign(task, slot || { start: null, end: null });
    task.syncStatus = slot ? 'local' : 'attention';
    task.issue = slot ? null : noSlot;
  }

  async createTask(input) {
    const text = taskText(input.text);
    if (input.requestId != null && (typeof input.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(input.requestId))) throw invalid('Invalid task request identifier.');
    if (input.requestId && this.data.tasks.some(t => t.id === input.requestId)) return input.requestId;
    const day = requestedDay(input.day);
    const viewDay = requestedDay(input.viewDay);
    const now = this.clock();
    const estimate = await this.estimate(text, { now, timeZone: this.data.settings.timeZone });
    const task = {
      id: input.requestId || id(), text,
      start: null, end: null, done: false, syncStatus: 'pending', issue: null,
      createdAt: now.toISOString(), dirty: this.data.settings.calendarMode === 'sync' ? { schedule: true } : {}, remote: null, intent: null, held: false
    };
    const overrides = {};
    if (day) overrides.day = day;
    else if (viewDay) overrides.viewDay = viewDay;
    applyEstimate(task, estimate, overrides);
    if (task.pendingEstimate) waitForEstimate(task);
    else if (!this.data.accounts.length) this.planLocal(task);
    this.data.tasks.push(task);
    this.store.save();
    return task.id;
  }

  async reviseEstimate(task, text, retry = false) {
    const zone = this.data.settings.timeZone;
    const now = this.clock();
    // Relative dates in the saved text refer to the original capture or rename.
    const previousTime = Date.parse(task.estimateRequestedAt || task.createdAt);
    const requested = retry && Number.isFinite(previousTime) ? new Date(previousTime) : now;
    const estimate = await this.estimate(text, { now: requested, timeZone: zone });
    if (estimate.pendingEstimate && (task.remote || task.intent || task.pausedSync || task.done ||
        (task.start && Date.parse(task.start) < now.getTime()))) {
      throw invalid((estimate.agent?.notice || 'The selected model could not estimate this change.') +
        ' Retry the edit when the model is available.', 409);
    }
    const overrides = estimateOverrides(task, zone);
    const previous = captureTask(task);
    const wasPending = task.pendingEstimate;
    applyEstimate(task, estimate, overrides);
    task.text = text;
    task.estimateRequestedAt = requested.toISOString();
    if (previous.text !== text) task.dirty.text = true;
    if (previous.category !== task.category) task.dirty.category = true;
    if (wasPending || !task.start || previous.text !== text || scheduleFields.some(k => previous[k] !== task[k])) {
      task.dirty.schedule = true;
    }
  }

  // Mutations are serialized by run(), including a retry from either local UI.
  // Calendar timers and planning passes never call the estimator.
  async retryEstimate(taskId) {
    const task = this.findTask(taskId);
    if (task.done || task.deleting) throw invalid('Reopen this task before retrying its estimate.', 409);
    if (!task.pendingEstimate && !isRemoteFallback(task)) throw invalid('This task already has an estimate.', 409);
    const changed = structuredClone(task);
    await this.reviseEstimate(changed, task.text, true);
    this.saveEdit(task, changed);
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
      if (text !== task.text) await this.reviseEstimate(changed, text);
    }
    const overrides = estimateOverrides(changed, this.data.settings.timeZone);
    changed.estimateOverrides = overrides;
    if (owns(input, 'category')) {
      if (!CATEGORIES.some(c => c.id === input.category)) throw invalid('Choose a task type from the list.');
      overrides.category = input.category;
      if (changed.category !== input.category) { changed.category = input.category; changed.dirty.category = true; }
    }
    if (owns(input, 'minutes')) {
      if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 1440) throw invalid('Choose a duration of 1 to 1,440 minutes.');
      overrides.minutes = input.minutes;
      if (changed.minutes !== input.minutes) {
        changed.minutes = input.minutes;
        changed.reason = 'Duration set by you.';
        changed.dirty.schedule = true;
      }
    }
    if (owns(input, 'day')) {
      const day = requestedDay(input.day);
      overrides.day = day;
      delete overrides.dates;
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
    this.saveEdit(task, changed);
  }

  saveEdit(task, changed) {
    if (changed.pendingEstimate) {
      waitForEstimate(changed);
      Object.assign(task, changed);
      delete task.lastLocalSlot;
      this.store.save();
      return;
    }
    if (changed.dirty.schedule) changed.held = false;
    changed.issue = null;
    changed.syncStatus = Object.keys(changed.dirty).length ? 'pending' : changed.syncStatus;
    if (this.data.settings.calendarMode === 'availability') {
      const needsPlacement = Boolean(changed.dirty.schedule);
      changed.dirty = {};
      if (needsPlacement && !changed.done) {
        if (changed.start) changed.lastLocalSlot = { start: changed.start, end: changed.end };
        changed.start = null;
        changed.end = null;
        changed.syncStatus = 'pending';
        if (!this.data.accounts.length) this.planLocal(changed);
      } else if (changed.done || changed.start) {
        changed.syncStatus = 'local';
      }
    } else if (!this.data.accounts.length && !changed.remote && !changed.intent) {
      if (changed.dirty.schedule && !changed.done) this.planLocal(changed);
      else changed.syncStatus = 'local';
    }
    Object.assign(task, changed);
    this.store.save();
  }

  deleteTask(taskId) {
    const task = this.findTask(taskId);
    if (this.data.settings.calendarMode === 'sync' && (task.remote || task.intent)) {
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
    if (next.calendarMode !== 'availability' && next.calendarMode !== 'sync') throw invalid('Choose a valid calendar mode.');
    if (typeof next.timeZone !== 'string' || !(IANAZone.isValidZone(next.timeZone) || next.timeZone === 'UTC')) throw invalid('Choose an IANA time zone.');
    if (!Array.isArray(next.workDays) || !next.workDays.length || !next.workDays.every(d => Number.isInteger(d) && d >= 1 && d <= 7)) throw invalid('Choose at least one working day.');
    if (!CLOCK.test(next.startTime) || !CLOCK.test(next.endTime) || next.startTime >= next.endTime) throw invalid('Work must end after it starts on the same day.');
    if (!Array.isArray(next.excludedCalendarIds) || !next.excludedCalendarIds.every(k => typeof k === 'string')) throw invalid('Choose valid calendars.');
    if (typeof next.targetCalendarId !== 'string' || (next.targetCalendarId !== old.targetCalendarId && next.targetCalendarId !== 'primary' && !this.calendars.some(c => c.id === next.targetCalendarId && c.writable))) throw invalid('Choose a writable destination calendar.');
    next.workDays = [...new Set(next.workDays)].sort();
    this.data.settings = next;
    if (next.calendarMode !== old.calendarMode) {
      this.auth.clear();
      this.authVersion++;
      this.tokens.clear();
      this.error = null;
      if (next.calendarMode === 'availability') this.pauseEventSync();
      else this.resumeEventSync();
    }
    const hoursChanged = ['timeZone', 'workDays', 'startTime', 'endTime'].some(k => JSON.stringify(old[k]) !== JSON.stringify(next[k]));
    if (hoursChanged) {
      for (const task of this.data.tasks) {
        if (task.pendingEstimate || task.done || task.held || task.deleting || task.remote?.allDay ||
            (task.end && Date.parse(task.end) <= this.clock().getTime())) continue;
        if (task.start && this.fitsHours(task.start, task.end)) continue;
        if (next.calendarMode === 'availability') {
          if (task.start) task.lastLocalSlot = { start: task.start, end: task.end };
          task.start = null;
          task.end = null;
        } else task.dirty.schedule = true;
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

  async beginConnection({ expectedMode } = {}) {
    const mode = this.data.settings.calendarMode;
    if (expectedMode !== undefined && expectedMode !== mode) throw invalid('The calendar mode changed. Refresh Settings before connecting.', 409);
    const { clientId } = await this.client();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = this.origin + '/oauth/callback';
    for (const [key, request] of this.auth) if (request.expires < Date.now()) this.auth.delete(key);
    this.auth.set(state, { verifier, redirectUri, mode, version: this.authVersion, expires: Date.now() + 600000 });
    return { url: this.google.authorizationUrl({ clientId, redirectUri, state, codeChallenge, mode }).toString() };
  }

  async finishConnection({ state, code, error }) {
    const request = this.auth.get(state);
    this.auth.delete(state);
    if (!request || request.expires < Date.now()) throw invalid('This sign-in request expired. Start again in Dayline.');
    if (error || !code) throw invalid('Google sign-in was cancelled. You can return to Dayline.');
    const checkMode = () => {
      if (request.mode !== this.data.settings.calendarMode || request.version !== this.authVersion) {
        throw invalid('Calendar access changed during sign-in. Start again with the current mode.', 409);
      }
    };
    const client = await this.client();
    checkMode();
    const tokens = await this.google.exchangeCode({ ...client, ...request, code });
    checkMode();
    const profile = await this.google.getProfile(tokens.access_token);
    const existing = this.data.accounts.find(a => a.sub === profile.sub);
    if (!tokens.refresh_token && (!existing?.secret || existing.mode !== request.mode)) throw invalid('Google did not grant offline access. Reconnect and allow the requested calendar permissions.');
    const secret = tokens.refresh_token ? await this.vault.seal(tokens.refresh_token) : existing.secret;
    checkMode();
    if (existing) Object.assign(existing, { email: profile.email, secret, mode: request.mode });
    else this.data.accounts.push({ ...profile, secret, mode: request.mode });
    this.cacheToken(profile.sub, tokens, request.mode);
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
    this.authVersion++;
    for (const t of this.data.tasks) {
      if ((t.remote || t.intent) && !this.data.accounts.some(a => a.sub === (t.remote || t.intent).sub)) {
        t.syncStatus = t.deleting ? 'deleting' : 'pending';
        t.issue = 'Reconnect the original Google account to sync this event.';
      }
    }
    this.store.save();
  }

  cacheToken(sub, tokens, mode) {
    this.tokens.set(sub, { mode, access: tokens.access_token, expires: Date.now() + (tokens.expires_in || 3600) * 1000 });
  }

  async token(sub) {
    const account = this.data.accounts.find(a => a.sub === sub);
    if (!account) throw invalid('Reconnect the original Google account to sync this event.', 409);
    const mode = this.data.settings.calendarMode === 'availability' ? 'availability' : account.mode;
    const cached = this.tokens.get(sub);
    if (cached?.mode === mode && cached.expires > Date.now() + 60000) return cached.access;
    const tokens = await this.google.refreshToken({ ...await this.client(), mode, refreshToken: await this.vault.open(account.secret) });
    this.cacheToken(sub, tokens, mode);
    if (tokens.refresh_token) { account.secret = await this.vault.seal(tokens.refresh_token); this.store.save(); }
    return tokens.access_token;
  }

  async discover() {
    const groups = await Promise.all(this.data.accounts.map(async account => {
      const calendars = await this.google.listCalendars(await this.token(account.sub));
      return calendars.map(c => ({ ...c, sub: account.sub, accountEmail: account.email, accountMode: account.mode,
        providerId: c.id, id: recordKey(account.sub, c.id) }));
    }));
    this.calendars = groups.flat();
  }

  syncPermission(sub) {
    if (this.data.settings.calendarMode !== 'sync') throw invalid('Calendar event sync is switched off.', 409);
    const account = this.data.accounts.find(a => a.sub === sub);
    if (account?.mode !== 'sync') {
      const name = account?.email || 'your Google account';
      throw invalid('Reconnect ' + name + ' in Settings to allow calendar event sync.', 409);
    }
  }

  async eventToken(sub) {
    this.syncPermission(sub);
    return this.token(sub);
  }

  selectedTarget() {
    const key = this.data.settings.targetCalendarId;
    const primaryAccount = this.data.accounts.find(account => account.mode === 'sync');
    return key === 'primary'
      ? this.calendars.find(c => c.sub === primaryAccount?.sub && c.primary)
      : this.calendars.find(c => c.id === key);
  }

  target() {
    const result = this.selectedTarget();
    if (!this.data.accounts.some(account => account.mode === 'sync') || result) {
      this.syncPermission(result?.sub || this.data.accounts[0]?.sub);
    }
    if (!result?.writable) throw invalid('Select a writable task calendar in Settings.', 409);
    return result;
  }

  async availability(range, destinationId, reservation) {
    if (reservation) this.syncPermission(reservation.sub);
    const excluded = new Set(this.data.settings.excludedCalendarIds);
    const target = this.data.settings.calendarMode === 'sync' ? this.selectedTarget() : null;
    const chosen = this.calendars.filter(c => c.canCheckAvailability !== false &&
      (c.id === target?.id || c.id === destinationId || !excluded.has(c.id)));
    if (!chosen.length) throw invalid('Select at least one calendar to check availability.', 409);
    const groups = await Promise.all(this.data.accounts.map(async account => {
      const calendars = chosen.filter(c => c.sub === account.sub);
      if (!calendars.length) return [];
      try {
        const access = await this.token(account.sub);
        const ownCalendar = reservation && account.sub === reservation.sub &&
          calendars.find(c => c.providerId === reservation.calendarId && c.canInspectReservations === true);
        const calendarIds = calendars.filter(c => c !== ownCalendar).map(c => c.providerId);
        const busy = calendarIds.length ? await this.google.getBusy(access, { ...range, calendarIds }) : [];
        if (ownCalendar && await this.google.hasOtherBusyEvent(access, { ...range, calendarId: ownCalendar.providerId, eventId: reservation.eventId })) {
          busy.push(range);
        }
        return busy;
      } catch (error) {
        const source = calendars.find(c => c.providerId === error.calendarId);
        if (!source) throw error;
        const label = source.name && source.name !== source.providerId ? '“' + source.name + '”' : 'one selected calendar';
        let action = 'Retry, or uncheck this calendar under “Check for conflicts on” in Settings.';
        if (source.id === target?.id) action = 'Choose another calendar for new tasks in Settings, then uncheck this one under “Check for conflicts on”.';
        else if (source.id === destinationId) action = 'Restore access to the calendar containing this task, then retry.';
        error.message = 'Google could not read availability for ' + label + '. ' + action;
        throw error;
      }
    }));
    return groups.flat();
  }

  acceptRemote(task, event, ref) {
    if (!event.owned || event.taskId !== task.id) throw invalid('Google could not verify ownership of the linked event.', 409);
    if (!event.start || !event.end) throw invalid('The linked event needs a timed start and end in Google Calendar.', 409);
    if (!task.dirty.text) task.text = event.text;
    if (!task.dirty.done) task.done = event.done;
    // Google all-day dates float with the calendar day. The board groups by local
    // instants, and a day-long reservation should preserve the task’s estimated effort.
    const allDay = DAY.test(event.start) && DAY.test(event.end);
    const instant = value => allDay ? DateTime.fromISO(value, { zone: this.data.settings.timeZone }).toUTC().toISO() : value;
    task.start = instant(event.start);
    task.end = instant(event.end);
    if (!allDay && !task.dirty.schedule) {
      const length = Math.round((Date.parse(task.end) - Date.parse(task.start)) / 60000);
      if (length > 0) task.minutes = length;
    }
    if (task.remote && task.remote.done !== event.done && !task.dirty.done) task.dirty.link = true;
    task.remote = { sub: ref.sub, calendarId: ref.calendarId, eventId: event.eventId, etag: event.etag, done: event.done };
    if (allDay) task.remote.allDay = { start: event.start, end: event.end };
    task.intent = null;
    task.issue = null;
    task.syncStatus = Object.keys(task.dirty).length ? 'pending' : 'synced';
  }

  async pullChanges() {
    if (this.data.settings.calendarMode !== 'sync') return;
    const groups = new Map();
    for (const task of this.data.tasks) {
      if (!task.remote || (task.pendingEstimate && !task.deleting)) continue;
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
      if (calendar.accountMode !== 'sync') {
        for (const task of tasks) {
          task.issue = 'Reconnect ' + calendar.accountEmail + ' in Settings to allow calendar event sync.';
          task.syncStatus = task.deleting ? 'deleting' : 'attention';
        }
        continue;
      }
      const access = await this.eventToken(calendar.sub);
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
    await this.google.deleteTaskEvent(await this.eventToken(ref.sub), { ...ref, expectedEtag: ref.etag || null, taskId: task.id });
    this.data.tasks = this.data.tasks.filter(t => t !== task);
    this.store.save();
  }

  async pushTask(task, rangeCache) {
    if (this.data.settings.calendarMode !== 'sync') return;
    if (task.deleting) return this.removeRemote(task);
    if (task.pendingEstimate || task.held) return;
    if (!task.remote && !task.intent && (task.done || (task.start && Date.parse(task.start) < this.clock().getTime() && !task.dirty.schedule))) {
      task.syncStatus = 'local';
      task.issue = null;
      return;
    }
    const { settings } = this.data;
    let ref = task.remote || task.intent;
    if (ref) this.syncPermission(ref.sub);
    else this.target();
    if (task.remote && !Object.keys(task.dirty).length) return;
    if (ref && !this.calendars.some(c => c.sub === ref.sub && c.providerId === ref.calendarId && c.writable)) {
      throw invalid('Reconnect the original writable calendar to sync this task.', 409);
    }

    // A previous insertion may already have reached Google even if the app lost its response.
    if (!task.remote && task.intent) {
      const found = await this.google.getTaskEvent(await this.eventToken(ref.sub), { ...ref, taskId: task.id });
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

    let slot = task.remote?.allDay || { start: task.start, end: task.end };
    let waitingForSlot = false;
    if (task.dirty.schedule || !ref) {
      const now = this.clock();
      const range = planningRange({ task, settings, now });
      let placement = null;
      if (range) {
        const destinationId = ref ? recordKey(ref.sub, ref.calendarId) : this.target().id;
        const cacheKey = destinationId + '|' + range.start + '|' + range.end;
        if (!rangeCache.has(cacheKey)) rangeCache.set(cacheKey, await this.availability(range, destinationId));
        // Free/busy merges simultaneous meetings. Reuse the original time only
        // after excluding this one verified event and checking every other source.
        if (task.remote && !task.remote.allDay && Date.parse(task.start) >= now.getTime()) {
          const candidate = findSlot({ task, settings, now: new Date(task.start), busy: this.localBusy(task.id) });
          if (candidate && Date.parse(candidate.start) === Date.parse(task.start) &&
              !(await this.availability(candidate, destinationId, task.remote)).length) placement = candidate;
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
    const event = await this.google.putTaskEvent(await this.eventToken(ref.sub), { ...ref, task: outgoing,
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

  futureLocalTask(task, now) {
    return !task.pendingEstimate && !task.done && !task.held && (!task.start || Date.parse(task.start) >= now.getTime());
  }

  async planAgainstCalendars(boardRange) {
    const now = this.clock();
    const settings = this.data.settings;
    const movable = this.data.tasks.filter(t => this.futureLocalTask(t, now));
    const ranges = [boardRange];
    for (const task of movable) {
      ranges.push(planningRange({ task, settings, now }));
      if (task.start) ranges.push(task);
      else if (task.lastLocalSlot) ranges.push(task.lastLocalSlot);
    }
    const busy = [];
    for (const range of combinedRanges(ranges)) busy.push(...await this.availability(range));

    // Reserve existing valid slots first. A newly conflicting task should never
    // displace a second task whose original time still works.
    const fixed = this.data.tasks.filter(t => !t.pendingEstimate && t.start && !this.futureLocalTask(t, now))
      .map(t => ({ start: t.start, end: t.end }));
    const unplaced = [];
    const place = (task, slot) => {
      Object.assign(task, slot || { start: null, end: null });
      task.syncStatus = slot ? 'local' : 'attention';
      task.issue = slot ? null : noSlot;
      delete task.lastLocalSlot;
      if (slot) fixed.push(slot);
    };
    for (const task of movable) {
      const prior = task.start ? task : task.lastLocalSlot;
      let sameSlot = null;
      if (prior && Date.parse(prior.start) >= now.getTime()) {
        // Free/busy omits event IDs. An old reservation can share a busy interval
        // with a separate meeting, so every Google block participates in this check.
        const candidate = findSlot({ task, settings, now: new Date(prior.start), busy: [...busy, ...fixed] });
        if (candidate && Date.parse(candidate.start) === Date.parse(prior.start)) sameSlot = candidate;
      }
      if (sameSlot) place(task, sameSlot);
      else unplaced.push(task);
    }
    for (const task of unplaced) place(task, findSlot({ task, settings, now, busy: [...busy, ...fixed] }));
    this.busy = busy.filter(e => Date.parse(e.end) > Date.parse(boardRange.start) && Date.parse(e.start) < Date.parse(boardRange.end));
    this.busyRange = boardRange;
  }

  unavailableLocalPlans(error) {
    const now = this.clock();
    for (const task of this.data.tasks) {
      if (!this.futureLocalTask(task, now)) continue;
      if (task.start) task.lastLocalSlot = { start: task.start, end: task.end };
      Object.assign(task, { start: null, end: null, syncStatus: 'attention', issue: error });
    }
    this.busy = [];
    this.busyRange = null;
  }

  async reconcile() {
    this.error = null;
    if (!this.data.accounts.length) return;
    try {
      await this.discover();
      const monday = DateTime.fromJSDate(this.clock(), { zone: this.data.settings.timeZone }).startOf('week');
      const range = { start: monday.toUTC().toISO(), end: monday.plus({ weeks: 5 }).toUTC().toISO() };
      if (this.data.settings.calendarMode === 'availability') {
        await this.planAgainstCalendars(range);
        this.data.lastSync = this.clock().toISOString();
        return;
      }
      await this.pullChanges();
      this.store.save();
      const rangeCache = new Map();
      let firstError = null;
      try { this.target(); }
      catch (error) { firstError = messageOf(error); }
      for (const task of [...this.data.tasks]) {
        try { await this.pushTask(task, rangeCache); }
        catch (error) {
          task.issue = messageOf(error);
          task.syncStatus = task.deleting ? 'deleting' : 'attention';
          firstError ||= task.issue;
          if (error.status === 401) this.tokens.clear();
        }
      }
      this.busy = await this.availability(range);
      this.busyRange = range;
      if (firstError) this.error = firstError;
      else this.data.lastSync = this.clock().toISOString();
    } catch (error) {
      this.error = messageOf(error);
      if (error.status === 401) this.tokens.clear();
      if (this.data.settings.calendarMode === 'availability') {
        this.unavailableLocalPlans(this.error);
        return;
      }
      for (const task of this.data.tasks) {
        if (!task.pendingEstimate && !(task.done && !task.remote) && (!task.remote || Object.keys(task.dirty).length) && !task.held) {
          task.syncStatus = task.deleting ? 'deleting' : 'attention';
          task.issue = this.error;
        }
      }
    } finally { this.store.save(); }
  }
}
