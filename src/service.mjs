import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DateTime, IANAZone } from 'luxon';
import { migrateCalendarModes } from './store.mjs';
import metadata from '../package.json' with { type: 'json' };
import * as googleCalendar from './google.mjs';
import { readCalendarMeetings } from './meetings.mjs';
import { MeetingAgenda, meetingRange } from './meeting-agenda.mjs';
import { CATEGORIES, estimateTask, explicitStartFor, findSlot, planningRange, resizedClockWindow } from './planner.mjs';
import { executePlannerCommand, guardCommandCapture, protectedCommandAppointment, settlePlannerClarification } from './planner-command-service.mjs';
import { canMoveLocalTask, explicitSchedulingIssue, nextFlexibleSlot, planFlexibleSlots, planTaskSlots } from './priority.mjs';
import { fullTaskMinutes } from './calendar-fit.mjs';
import { releaseCompletedTime, reopenCompletedTask } from './completion.mjs';
import { setChecklistCompletion, updateSubtasks } from './subtasks.mjs';
import { capOverrun, observeOverrun, proposeOverrun } from './overrun.mjs';
import { localTaskTitle, recordDurationFeedback } from './task-learning.mjs';
import { adjustTaskDuration, previewAdjustedSlot, setManualDuration } from './duration.mjs';
import { agentSelection } from './agents/manager.mjs';

const id = () => randomUUID().replaceAll('-', '');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const owns = (value, key) => Object.hasOwn(value, key);
const messageOf = error => error?.message || 'Google Calendar could not be reached.';
const recordKey = (sub, calendarId) => Buffer.from(JSON.stringify([sub, calendarId])).toString('base64url');
const scheduleFields = ['minutes', 'earliestDay', 'latestDay', 'windowStart', 'windowEnd', 'deadlineTime'];
const noSlot = 'No open work period fits. Change the day, duration, or working hours.';
const estimateFailed = 'The selected model could not finish this estimate. Check the agent settings and retry.';
const interrupted = 'Dayline closed during this estimate. Retry it to schedule the task.';
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

function capturedAt(value, fallback) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) && !(typeof value === 'string' && /T.+(?:Z|[+-]\d\d:\d\d)$/i.test(value))) {
    throw invalid('Choose a valid capture time.');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw invalid('Choose a valid capture time.');
  return date > fallback ? fallback : date;
}

const completedBesideMeeting = task => task.done && task.remote?.calendarAppointment && task.completedPlannedSlot;

function safeTask(task) {
  const { remote, dirty, intent, pausedSync, lastLocalSlot, held, deleting, estimateJob, estimateOverrides, orderRequestedAt,
    estimateRequestedAt, estimateRetryIds, estimateRemoteTitle, durationRequests, durationCheckPending, overrunWatchStart, commandEventPending, commandMovedAt, ...visible } = task;
  const text = estimateJob?.text ?? task.text;
  const active = task.estimateState === 'queued' || task.estimateState === 'estimating';
  return { ...visible, ...(completedBesideMeeting(task) && { start: null, end: null }),
    text, title: task.title || localTaskTitle(text), allDay: Boolean(remote?.allDay), hasCalendarEvent: Boolean(remote),
    estimateState: task.estimateState ?? (task.pendingEstimate ? 'failed' : null),
    ...(active && estimateJob && { estimateAgent: { ...estimateJob.selection } }) };
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

function applyEstimate(task, estimate, overrides, timeZone) {
  if (!estimate.pendingEstimate) updateSubtasks(task, estimate.subtasks);
  if (!estimate.pendingEstimate) {
    delete task.calendarFit;
    delete task.calendarProgressMinutes;
    delete task.calendarInterruptedAt;
    if (overrides.title || estimate.title) task.title = overrides.title || estimate.title;
    task.baseMinutes = estimate.baseMinutes ?? estimate.minutes;
    task.estimatedMinutes = estimate.estimatedMinutes ?? estimate.minutes;
  }
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
  if (overrides.time && Number.isSafeInteger(task.minutes) && task.minutes > 0) {
    task.windowStart = overrides.time;
    task.windowEnd = resizedClockWindow(task, task.minutes, timeZone);
  }
}

function waitForEstimate(task) {
  if (!task.estimateJob?.protected) {
    task.start = null;
    task.end = null;
    task.dirty = {};
    delete task.lastLocalSlot;
  }
  const active = task.estimateState === 'queued' || task.estimateState === 'estimating';
  task.syncStatus = task.done ? 'local' : active ? 'pending' : 'attention';
  task.issue = task.done || active ? null : (task.estimateJob?.notice || task.agent?.notice || 'Waiting for a model estimate.');
}

function keepRevisionWording(task) {
  task.title ||= task.text;
  task.text = task.estimateJob.text;
  task.estimateJob = null;
  task.estimateState = null;
  task.pendingEstimate = false;
}

function captureTask(task) {
  return Object.fromEntries(['text', 'title', 'category', 'done', 'start', 'end', ...scheduleFields].map(key => [key, task[key]]));
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

function uncoveredRanges(requested, checked) {
  const gaps = [];
  for (const range of combinedRanges(requested)) {
    let cursor = range.start;
    for (const known of checked) {
      if (known.end <= cursor) continue;
      if (known.start >= range.end) break;
      if (cursor < known.start) gaps.push({ start: cursor, end: known.start });
      if (cursor < known.end) cursor = known.end;
      if (cursor >= range.end) break;
    }
    if (cursor < range.end) gaps.push({ start: cursor, end: range.end });
  }
  return gaps;
}

const overlaps = (a, b) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
const sameSlot = (a, b) => a && b && Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end);
const slotOf = ({ start, end }) => ({ start, end });
const reservationOf = task => ({ ...task.remote, taskId: task.id, ...slotOf(task) });

// Produce possible gaps for the planner. Google can merge an owned reservation
// with an unrelated meeting, so a proposed gap is always verified by event ID.
function withoutSlots(intervals, slots) {
  let result = intervals;
  for (const slot of slots) {
    result = result.flatMap(block => {
      if (!overlaps(block, slot)) return [block];
      const rest = [];
      if (Date.parse(block.start) < Date.parse(slot.start)) rest.push({ start: block.start, end: slot.start });
      if (Date.parse(slot.end) < Date.parse(block.end)) rest.push({ start: slot.end, end: block.end });
      return rest;
    });
  }
  return result;
}

function copyRecord(current, next) {
  for (const key of Object.keys(current)) if (!owns(next, key)) delete current[key];
  Object.assign(current, next);
}

export class DaylineService {
  constructor({ store, vault, google = googleCalendar, readMeetings = readCalendarMeetings, estimate = estimateTask, clock = () => new Date(), bundledClient = null }) {
    this.store = store;
    this.data = store.state;
    this.vault = vault;
    this.google = google;
    this.readMeetings = readMeetings;
    this.meetingAgenda = new MeetingAgenda();
    this.estimate = estimate;
    this.clock = clock;
    this.bundledClient = bundledClient;
    this.origin = '';
    this.calendars = [];
    this.busy = [];
    this.busyRange = null;
    this.checkedPlanningRanges = [];
    this.error = null;
    this.syncing = false;
    this.tail = Promise.resolve();
    this.pendingSync = null;
    this.estimateWorker = null;
    this.estimateWorkerEnabled = false;
    this.estimateSession = 0;
    this.auth = new Map();
    this.authVersion = 0;
    this.tokens = new Map();
    this.refreshes = new Map();
    this.discovery = null;
    this.discoveryErrors = new Set();
    this.discoveredSubs = new Set();
    let migrated = migrateCalendarModes(this.data);
    if (this.data.settings.calendarMode === 'availability' && this.data.tasks.some(t =>
      t.remote || t.intent || t.deleting || Object.keys(t.dirty || {}).length)) {
      this.pauseEventSync();
      migrated = true;
    }
    // Release checked-off local blocks before the first network request or
    // Keychain prompt, including when opening an older planner offline.
    const now = this.clock();
    for (const task of this.data.tasks) {
      if (!Array.isArray(task.subtasks)) { updateSubtasks(task); migrated = true; }
      if (task.done && this.releaseCompletion(task, now)) migrated = true;
    }
    if (this.data.accounts.length && this.data.settings.calendarMode === 'availability' && !this.data.tasks.some(task => task.overrunWatchStart)) {
      const observed = observeOverrun(this.data.tasks, now);
      if (observed.some((task, i) => task !== this.data.tasks[i])) { this.data.tasks = observed; migrated = true; }
    }
    if (migrated) this.store.save();
    if (!this.data.accounts.length) this.persistLocalPlan(this.data.tasks);
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
        if (task.title !== paused.original.title) task.dirty.text = true;
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
    const now = this.clock();
    const accounts = this.data.accounts.map(account => ({
      sub: account.sub, email: account.email, mode: account.mode, meetingDetails: this.canReadMeetings(account)
    }));
    return {
      tasks: this.data.tasks.map(task => ({ ...safeTask(task), canReorder: this.canReorderTask(task, now) })),
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
      now: now.toISOString(),
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

  canReorderTask(task, now) {
    if (task.done || task.deleting || task.held || task.pendingEstimate || task.estimateJob || task.intent ||
        task.pausedSync?.intent || protectedCommandAppointment(task) || (task.end && Date.parse(task.end) <= now.getTime()) ||
        explicitStartFor(task, this.data.settings.timeZone)) return false;
    return !task.remote || this.movableFlexibleEvent(task, now);
  }

  reorderedTaskList(taskId, { targetId, placement, day }) {
    if (!['before', 'after'].includes(placement) || typeof targetId !== 'string' || !/^[a-f0-9]{32}$/.test(targetId) || taskId === targetId) {
      throw invalid('Choose another task to move this one before or after.');
    }
    const task = this.findTask(taskId);
    const target = this.findTask(targetId);
    const now = this.clock();
    const taskDay = item => item.start ? DateTime.fromISO(item.start, { zone: this.data.settings.timeZone }).toISODate() : 'unscheduled';
    const group = taskDay(task);
    if ((day != null && day !== group) || taskDay(target) !== group) throw invalid('The schedule changed. Choose two tasks in the same day or in Unscheduled.', 409);
    if (!this.canReorderTask(task, now) || !this.canReorderTask(target, now)) throw invalid('These tasks can no longer be rearranged. Refresh your plan.', 409);

    // Only reorder members of the displayed group. Requests from the desktop
    // and browser share this serialized list, including tasks captured meanwhile.
    const members = this.data.tasks.filter(item => taskDay(item) === group && this.canReorderTask(item, now));
    const reordered = members.filter(item => item !== task);
    reordered.splice(reordered.indexOf(target) + (placement === 'after' ? 1 : 0), 0, task);
    const later = placement === 'after' ? task : target;
    const displaced = later.start && Date.parse(later.start) < now.getTime() && !later.remote ? later : null;
    if (reordered.every((item, i) => members[i] === item) && !displaced) return this.data.tasks;
    const indices = new Map(members.map((item, i) => [item, i]));
    return this.data.tasks.map(original => {
      if (!indices.has(original)) return original;
      const item = reordered[indices.get(original)];
      if (item !== task && item !== displaced) return item;
      const changed = { ...item, orderRequestedAt: now.toISOString() };
      if (item === displaced) {
        // The user explicitly deferred an unfinished block. Its full remaining
        // estimate returns to the queue and will start in a new verified slot.
        changed.start = changed.end = null;
        changed.syncStatus = 'pending';
        delete changed.lastLocalSlot;
        delete changed.durationCheckPending;
        delete changed.overrunWatchStart;
        delete changed.overrunMinutes;
      }
      return changed;
    });
  }

  reorderTask(taskId, input) {
    const proposed = this.reorderedTaskList(taskId, input);
    if (proposed !== this.data.tasks) {
      if (this.data.accounts.length) this.commitTaskList(proposed);
      else this.persistLocalPlan(proposed, true);
    }
    return { id: taskId };
  }

  localBusy(except) {
    return this.data.tasks.filter(t => t.id !== except && t.start && t.end && !t.deleting && (!t.pendingEstimate || t.estimateJob?.protected))
      .map(({ start, end }) => ({ start, end }));
  }

  releaseCompletion(task, now) {
    if (task.remote && this.data.settings.calendarMode === 'sync') return this.projectCalendarCompletion(task, now);
    return releaseCompletedTime(task, now, this.data.settings.timeZone);
  }

  plannedTasks(tasks, busy, now, { canMove, overruns = false } = {}) {
    if (overruns) {
      tasks = tasks.map(task => {
        const cap = capOverrun({ task, tasks, busy, now, settings: this.data.settings });
        if (!cap) return task;
        const next = { ...task, end: cap.end, overrunMinutes: cap.overrunMinutes };
        if (!cap.overrunMinutes) delete next.overrunMinutes;
        return next;
      });
      const proposal = proposeOverrun({ tasks, busy, now, settings: this.data.settings });
      if (proposal) {
        const displaced = new Set(proposal.displaced);
        tasks = tasks.map(task => {
          if (task === proposal.task) return { ...task, end: proposal.end, overrunMinutes: proposal.overrunMinutes };
          if (displaced.has(task)) return { ...task, start: null, end: null };
          return task;
        });
      }
    }
    const context = { tasks, busy, now, settings: this.data.settings, canMove };
    const { placements, remainingWork } = planTaskSlots(context);
    const planned = tasks.map(task => {
      if (!placements.has(task.id)) return task;
      const slot = placements.get(task.id);
      const progress = remainingWork.get(task.id);
      const normal = progress?.minutes ?? fullTaskMinutes(task);
      const minutes = slot ? slot.minutes ?? task.minutes : normal;
      const start = slot?.start ?? null, end = slot?.end ?? null;
      const syncStatus = slot ? 'local' : 'attention';
      const issue = slot ? null : explicitSchedulingIssue({ ...context, task, placements }) || noSlot;
      if (!progress && task.minutes === minutes && task.start === start && task.end === end && task.syncStatus === syncStatus && task.issue === issue &&
          !task.lastLocalSlot && !(slot && task.durationCheckPending)) return task;
      const next = { ...task, start, end, minutes, syncStatus, issue };
      if (task.overrunMinutes && (start !== task.start || progress)) delete next.overrunMinutes;
      if (minutes < normal) next.calendarFit = { originalMinutes: normal };
      else delete next.calendarFit;
      if (progress) {
        next.calendarInterruptedAt = now.toISOString();
        if (progress.credited) next.calendarProgressMinutes = (task.calendarProgressMinutes || 0) + progress.credited;
      }
      delete next.lastLocalSlot;
      if (slot) delete next.durationCheckPending;
      return next;
    });
    return overruns ? observeOverrun(planned, now) : planned;
  }

  // Persist the entire local rearrangement together. Failed writes cannot move a
  // sibling while leaving the edited task (or its new duration) uncommitted.
  persistLocalPlan(tasks, forceSave = false) {
    const previous = this.data.tasks;
    const proposed = this.plannedTasks(tasks, [], this.clock(), { overruns: true });
    if (!forceSave && previous.length === proposed.length && proposed.every((task, i) => task === previous[i])) return;
    this.commitTaskList(proposed);
  }

  commitTaskList(proposed) {
    const previous = this.data.tasks;
    const byId = new Map(previous.map(task => [task.id, task]));
    this.data.tasks = proposed;
    try { this.store.save(); }
    finally { this.data.tasks = previous; }
    this.data.tasks = proposed.map(task => {
      const existing = byId.get(task.id);
      if (existing && existing !== task) copyRecord(existing, task);
      return existing || task;
    });
  }

  captureDraft(input) {
    const text = taskText(input.text);
    if (input.requestId != null && (typeof input.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(input.requestId))) throw invalid('Invalid task request identifier.');
    guardCommandCapture(this.data, input);
    if (input.requestId && (this.data.tasks.some(t => t.id === input.requestId) || this.data.deletedTaskIds?.includes(input.requestId))) return null;
    const day = requestedDay(input.day);
    const viewDay = requestedDay(input.viewDay);
    const context = this.captureContext(input);
    const task = {
      id: input.requestId || id(), text,
      start: null, end: null, done: false, syncStatus: 'pending', issue: null,
      createdAt: context.at, dirty: this.data.settings.calendarMode === 'sync' ? { schedule: true } : {}, remote: null, intent: null, held: false
    };
    const overrides = {};
    if (day) overrides.day = day;
    else if (viewDay) overrides.viewDay = viewDay;
    task.estimateOverrides = overrides;
    updateSubtasks(task);
    return task;
  }

  captureContext(input) {
    const at = capturedAt(input.capturedAt, this.clock()).toISOString();
    const timeZone = input.captureTimeZone ?? this.data.settings.timeZone;
    if (typeof timeZone !== 'string' || (timeZone !== 'UTC' && !IANAZone.isValidZone(timeZone))) throw invalid('Choose a valid capture time zone.');
    return { at, timeZone };
  }

  captureSelection(clientAgent, createdAt) {
    if (clientAgent == null) return undefined;
    const captured = agentSelection(clientAgent);
    const saved = this.data.agent;
    // An old browser tab may still display the former provider. Preserve
    // offline entries captured before the switch and use the new choice after it.
    if (Number.isSafeInteger(saved?.selectedAt) && Date.parse(createdAt) >= saved.selectedAt) return agentSelection(saved);
    return captured;
  }

  async createTask(input) {
    const task = this.captureDraft(input);
    if (!task) return input.requestId;
    const estimate = await this.estimate(task.text, { now: new Date(task.createdAt), timeZone: input.captureTimeZone || this.data.settings.timeZone,
      taskId: task.id, ...(input.captureAgent != null && { selection: this.captureSelection(input.captureAgent, task.createdAt) }) });
    applyEstimate(task, estimate, task.estimateOverrides, input.captureTimeZone || this.data.settings.timeZone);
    if (task.pendingEstimate) waitForEstimate(task);
    if (!this.data.accounts.length) {
      this.persistLocalPlan([...this.data.tasks, task]);
      return task.id;
    }
    this.data.tasks.push(task);
    this.store.save();
    return task.id;
  }

  enqueueTask(input) {
    const task = this.captureDraft(input);
    if (!task) return input.requestId;
    task.title = localTaskTitle(task.text);
    task.earliestDay = task.latestDay = task.estimateOverrides.day || task.estimateOverrides.viewDay || null;
    this.stageEstimate(task, task.text, false, { at: task.createdAt, timeZone: input.captureTimeZone, agent: this.captureSelection(input.captureAgent, task.createdAt) });
    const priorCommand = input.forceCreate === true && this.data.plannerCommands?.[task.id];
    if (priorCommand) delete this.data.plannerCommands[task.id];
    this.data.tasks.push(task);
    try { this.store.save(); }
    catch (error) {
      this.data.tasks.splice(this.data.tasks.indexOf(task), 1);
      if (priorCommand) this.data.plannerCommands[task.id] = priorCommand;
      throw error;
    }
    this.wakeEstimateWorker();
    return task.id;
  }

  stageEstimate(task, text, retry = false, capture = {}) {
    const previous = task.estimateJob;
    const requestedAt = retry ? previous?.at || task.estimateRequestedAt || task.createdAt : capture.at || this.clock().toISOString();
    const { timeZone, workDays, startTime, endTime } = this.data.settings;
    const { provider = 'local', model = '', effort } = this.data.agent || {};
    const selection = agentSelection(capture.agent ?? { provider, model, ...(effort && { effort }) });
    const order = this.data.tasks.reduce((max, t) => Math.max(max, t.estimateJob?.order || 0), 0) + 1;
    const protectedTask = previous?.protected || Boolean(task.remote || task.intent || task.pausedSync || task.done ||
      (task.start && Date.parse(task.start) < this.clock().getTime()));
    const workHours = retry && previous?.workHours ? previous.workHours : { workDays: [...workDays], startTime, endTime };
    task.estimateJob = { id: id(), order, text, at: requestedAt, timeZone: retry && previous ? previous.timeZone : capture.timeZone || timeZone,
      selection, workHours, protected: protectedTask };
    if (task.remote) task.estimateJob.remoteTitle = previous?.remoteTitle || task.title || task.text;
    task.estimateRequestedAt = requestedAt;
    task.pendingEstimate = true;
    task.estimateState = 'queued';
    if (!protectedTask) {
      const wordingChanged = task.text !== text;
      task.text = text;
      if (wordingChanged) updateSubtasks(task);
      task.title = task.estimateOverrides?.title || localTaskTitle(text);
    }
    waitForEstimate(task);
  }

  enqueueRetry(taskId, { requestId } = {}) {
    const task = this.findTask(taskId);
    if (requestId != null && (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId))) throw invalid('Invalid estimate request identifier.');
    if (requestId && task.estimateRetryIds?.includes(requestId)) return taskId;
    if (task.done || task.deleting) throw invalid('Reopen this task before retrying its estimate.', 409);
    if (!task.pendingEstimate && !isRemoteFallback(task)) throw invalid('This task already has an estimate.', 409);
    const changed = structuredClone(task);
    if (requestId) (changed.estimateRetryIds ||= []).push(requestId);
    if (!['queued', 'estimating'].includes(changed.estimateState)) {
      changed.estimateOverrides = estimateOverrides(changed, this.data.settings.timeZone);
      this.stageEstimate(changed, changed.estimateJob?.text || changed.text, true);
    }
    this.saveEdit(task, changed);
    this.wakeEstimateWorker();
    return taskId;
  }

  startEstimateWorker() {
    if (this.estimateWorkerEnabled) return;
    this.estimateWorkerEnabled = true;
    ++this.estimateSession;
    // A previous process may already have spent its model call. Queued work is
    // safe to resume; a claimed call needs an explicit retry from its owner.
    const unfinished = this.data.tasks.filter(t => t.estimateState === 'estimating' && t.estimateJob);
    for (const task of unfinished) {
      task.estimateState = 'failed';
      task.estimateJob.notice = interrupted;
      waitForEstimate(task);
    }
    if (unfinished.length) this.store.save();
    this.wakeEstimateWorker();
  }

  stopEstimateWorker() {
    this.estimateWorkerEnabled = false;
    ++this.estimateSession;
  }

  wakeEstimateWorker() {
    if (!this.estimateWorkerEnabled || this.estimateWorker || !this.data.tasks.some(t => t.estimateState === 'queued' && t.estimateJob && !t.deleting)) return;
    const session = this.estimateSession;
    this.estimateWorker = new Promise(resolve => setImmediate(resolve)).then(() => this.drainEstimates(session)).catch(() => {
      // A local commit failed. Do not launch an unrecorded or duplicate call.
      this.stopEstimateWorker();
      this.error = 'Dayline could not save its estimate queue. Check the local data folder and restart the app.';
    }).finally(() => {
      this.estimateWorker = null;
      this.wakeEstimateWorker();
    });
  }

  async whenEstimatesIdle() {
    while (this.estimateWorker) await this.estimateWorker;
    if (this.pendingSync) await this.pendingSync;
  }

  async drainEstimates(session) {
    while (session === this.estimateSession) {
      const job = await this.run(() => {
        if (session !== this.estimateSession) return null;
        const task = this.data.tasks.filter(t => t.estimateState === 'queued' && t.estimateJob && !t.deleting)
          .sort((a, b) => a.estimateJob.order - b.estimateJob.order)[0];
        if (!task) return null;
        task.estimateState = 'estimating';
        this.store.save();
        return { ...structuredClone(task.estimateJob), taskId: task.id };
      });
      if (!job) return;
      let estimate;
      try {
        // Only claims and commits use the planner’s mutation queue. Calendar
        // refreshes and editing remain available throughout the model call.
        estimate = await this.estimate(job.text, { now: new Date(job.at), timeZone: job.timeZone,
          taskId: job.taskId, selection: job.selection, workHours: job.workHours });
      } catch { /* A throwing provider has no trusted notice to display. */ }
      const scheduled = await this.run(() => {
        const task = this.data.tasks.find(t => t.id === job.taskId);
        if (session !== this.estimateSession || task?.estimateJob?.id !== job.id || task.estimateState !== 'estimating' || task.deleting) return false;
        const changed = structuredClone(task);
        if (estimate?.agent) this.data.agent = { ...this.data.agent, lastRun: estimate.agent };
        if (!estimate || estimate.pendingEstimate || !Number.isSafeInteger(estimate.minutes) || estimate.minutes < 1) {
          changed.estimateState = 'failed';
          changed.estimateJob.notice = estimate?.agent?.notice || estimateFailed;
          if (!job.protected && estimate?.pendingEstimate) applyEstimate(changed, estimate, changed.estimateOverrides, job.timeZone);
          this.saveEdit(task, changed);
          return false;
        }
        const before = captureTask(changed);
        changed.text = job.text;
        changed.title = estimate.title || localTaskTitle(job.text);
        applyEstimate(changed, estimate, changed.estimateOverrides || {}, job.timeZone);
        changed.estimateState = null;
        changed.estimateJob = null;
        if (before.title !== changed.title || before.text !== changed.text) changed.dirty.text = true;
        if (changed.dirty.text && job.remoteTitle && !changed.estimateOverrides?.title) changed.estimateRemoteTitle = job.remoteTitle;
        if (before.category !== changed.category) changed.dirty.category = true;
        if (!changed.done && (!changed.start || !job.protected || scheduleFields.some(key => before[key] !== changed[key]))) changed.dirty.schedule = true;
        this.saveEdit(task, changed);
        return true;
      });
      if (scheduled && this.data.accounts.length) this.queueSync();
    }
  }

  async reviseEstimate(task, text, retry = false) {
    const zone = this.data.settings.timeZone;
    const now = this.clock();
    // Relative dates in the saved text refer to the original capture or rename.
    const previousTime = Date.parse(task.estimateRequestedAt || task.createdAt);
    const requested = retry && Number.isFinite(previousTime) ? new Date(previousTime) : now;
    const estimate = await this.estimate(text, { now: requested, timeZone: zone, taskId: task.id });
    if (estimate.pendingEstimate && (task.remote || task.intent || task.pausedSync || task.done ||
        (task.start && Date.parse(task.start) < now.getTime()))) {
      throw invalid((estimate.agent?.notice || 'The selected model could not estimate this change.') +
        ' Retry the edit when the model is available.', 409);
    }
    const overrides = estimateOverrides(task, zone);
    const previous = captureTask(task);
    const wasPending = task.pendingEstimate;
    task.text = text;
    applyEstimate(task, estimate, overrides, zone);
    task.estimateRequestedAt = requested.toISOString();
    if (previous.text !== text || previous.title !== task.title) task.dirty.text = true;
    if (previous.category !== task.category) task.dirty.category = true;
    if (wasPending || !task.start || previous.text !== text || scheduleFields.some(k => previous[k] !== task[k])) {
      task.dirty.schedule = true;
    }
  }

  // Mutations are serialized by run(), including a retry from either local UI.
  // Calendar timers and planning passes never call the estimator.
  async retryEstimate(taskId) {
    const task = this.findTask(taskId);
    if (task.estimateJob) return this.enqueueRetry(taskId);
    if (task.done || task.deleting) throw invalid('Reopen this task before retrying its estimate.', 409);
    if (!task.pendingEstimate && !isRemoteFallback(task)) throw invalid('This task already has an estimate.', 409);
    const changed = structuredClone(task);
    await this.reviseEstimate(changed, task.text, true);
    this.saveEdit(task, changed);
  }

  enqueueEdit(taskId, input) {
    return this.editTask(taskId, input, true);
  }

  runPlannerCommand(input, options) {
    return executePlannerCommand(this, input, options);
  }

  settlePlannerClarification(input, message) {
    return settlePlannerClarification(this, input, message);
  }

  adjustDuration(taskId, input) {
    const task = this.findTask(taskId);
    return adjustTaskDuration(this, task, input, estimateOverrides(task, this.data.settings.timeZone));
  }

  setTaskCompletion(changed, done, propagate = true) {
    if (typeof done !== 'boolean') throw invalid('Choose complete or open.');
    if (changed.done === done) return;
    changed.done = done;
    if (propagate) setChecklistCompletion(changed, done);
    changed.dirty.done = true;
    const now = this.clock();
    if (changed.done) {
      changed.completedAt = now.toISOString();
      this.releaseCompletion(changed, now);
    } else if (changed.remote?.calendarAppointment && this.data.settings.calendarMode === 'sync') {
      delete changed.completedAt;
      delete changed.completedDay;
      delete changed.completedPlannedSlot;
    } else {
      reopenCompletedTask(changed, now);
      if (!changed.pendingEstimate) changed.dirty.schedule = true;
    }
    if (changed.done && changed.estimateJob) {
      if (changed.estimateJob.protected) {
        keepRevisionWording(changed);
      } else {
        changed.estimateState = 'failed';
        changed.estimateJob.notice = 'Estimation stopped when you completed this task. Reopen and retry to schedule it.';
      }
    }
  }

  setSubtaskDone(taskId, subtaskId, done) {
    const task = this.findTask(taskId);
    if (typeof done !== 'boolean') throw invalid('Choose complete or open for this subtask.');
    if (task.deleting) throw invalid('This task is waiting for its calendar entry to be removed.', 409);
    const changed = structuredClone(task);
    const item = changed.subtasks?.find(child => child.id === subtaskId);
    if (!item) throw invalid('This subtask is no longer on the task.', 404);
    if (item.done === done) return { id: task.id, done: task.done, completionChanged: false };
    item.done = done;
    const complete = changed.subtasks.every(child => child.done);
    const completionChanged = complete !== task.done;
    if (completionChanged) {
      this.setTaskCompletion(changed, complete, false);
      this.saveEdit(task, changed);
    } else {
      this.commitEdit(task, changed);
    }
    return { id: task.id, done: complete, completionChanged };
  }

  async editTask(taskId, input, queueEstimate = false) {
    const task = this.findTask(taskId);
    queueEstimate ||= Boolean(task.estimateJob);
    if (task.deleting) throw invalid('This task is waiting for its calendar entry to be removed.', 409);
    if (!Object.keys(input).length || Object.keys(input).some(k => !['done', 'text', 'title', 'minutes', 'category', 'day'].includes(k))) {
      throw invalid('Unknown task change.');
    }
    const changed = structuredClone(task);
    if (owns(input, 'text')) {
      const text = taskText(input.text);
      if (text !== (task.estimateJob?.text || task.text)) {
        if (queueEstimate) this.stageEstimate(changed, text);
        else await this.reviseEstimate(changed, text);
      }
    }
    this.applyTaskFields(changed, input);
    const learning = this.data.durationLearning;
    if (owns(input, 'minutes') && task.minutes !== changed.minutes) recordDurationFeedback(this.data, task, changed);
    try { this.saveEdit(task, changed, { durationOnly: Object.keys(input).length === 1 && owns(input, 'minutes') }); }
    catch (error) { this.data.durationLearning = learning; throw error; }
    if (queueEstimate) this.wakeEstimateWorker();
    return taskId;
  }

  applyTaskFields(changed, input) {
    const overrides = estimateOverrides(changed, this.data.settings.timeZone);
    changed.estimateOverrides = overrides;
    if (owns(input, 'title')) {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title || title.length > 120) throw invalid('Choose a title between 1 and 120 characters.');
      overrides.title = title;
      delete changed.estimateRemoteTitle;
      if (changed.title !== title) { changed.title = title; changed.dirty.text = true; }
    }
    if (owns(input, 'category')) {
      if (!CATEGORIES.some(c => c.id === input.category)) throw invalid('Choose a task type from the list.');
      overrides.category = input.category;
      if (changed.category !== input.category) { changed.category = input.category; changed.dirty.category = true; }
    }
    if (owns(input, 'minutes')) {
      setManualDuration(changed, input.minutes, this.data.settings.timeZone);
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
    if (owns(input, 'done')) this.setTaskCompletion(changed, input.done);
  }

  prepareSavedEdit(task, changed, { durationOnly = false } = {}) {
    if (changed.pendingEstimate) {
      waitForEstimate(changed);
      return;
    }
    if (durationOnly && (changed.done || changed.remote?.allDay)) delete changed.dirty.schedule;
    if (changed.dirty.schedule) changed.held = false;
    changed.issue = null;
    changed.syncStatus = Object.keys(changed.dirty).length ? 'pending' : changed.syncStatus;
    if (!this.data.accounts.length && !changed.remote && !changed.intent) {
      if (changed.dirty.schedule && !changed.done) {
        if (changed.start) changed.lastLocalSlot = { start: changed.start, end: changed.end };
        if (durationOnly && changed.start && Date.parse(changed.start) < this.clock().getTime()) changed.durationCheckPending = true;
        changed.start = changed.end = null;
      }
      if (this.data.settings.calendarMode === 'availability') changed.dirty = {};
      if (changed.done || changed.start) changed.syncStatus = 'local';
      return;
    }
    if (this.data.settings.calendarMode === 'availability') {
      const needsPlacement = Boolean(changed.dirty.schedule);
      changed.dirty = {};
      if (needsPlacement && !changed.done) {
        const preview = durationOnly ? previewAdjustedSlot(this, task, changed) : null;
        if (preview && (preview.start === task.start || !explicitStartFor(changed, this.data.settings.timeZone))) {
          Object.assign(changed, preview, { syncStatus: 'local', durationCheckPending: this.data.accounts.length > 0 });
        } else {
          if (changed.start) changed.lastLocalSlot = { start: changed.start, end: changed.end };
          changed.start = null;
          changed.end = null;
          changed.syncStatus = 'pending';
        }
      } else if (changed.done || changed.start) {
        changed.syncStatus = 'local';
      }
    }
  }

  saveEdit(task, changed, options) {
    this.prepareSavedEdit(task, changed, options);
    this.commitEdit(task, changed);
  }

  commitEdit(task, changed) {
    if (!this.data.accounts.length) return this.persistLocalPlan(this.data.tasks.map(t => t === task ? changed : t));
    if (changed.done !== task.done && this.data.settings.calendarMode === 'availability' && this.busyRange && !this.error) {
      const now = this.clock();
      const proposed = this.data.tasks.map(t => t === task ? changed : t);
      const covers = range => range && Date.parse(range.start) >= Date.parse(this.busyRange.start) && Date.parse(range.end) <= Date.parse(this.busyRange.end);
      const verified = new Set(proposed.filter(t => covers(planningRange({ task: t, settings: this.data.settings, now })) &&
        (!t.start || covers(t)) && (!t.lastLocalSlot || covers(t.lastLocalSlot))));
      const canMove = (t, at) => verified.has(t) && canMoveLocalTask(t, at);
      return this.commitTaskList(this.plannedTasks(proposed, this.busy, now, { canMove }));
    }
    // Persist the candidate first. On disk failure the original record, including
    // its in-flight model claim or retry identifier, remains live in this process.
    const index = this.data.tasks.indexOf(task);
    this.data.tasks[index] = changed;
    try { this.store.save(); }
    finally { this.data.tasks[index] = task; }
    copyRecord(task, changed);
  }

  deleteTask(taskId) {
    const task = this.findTask(taskId);
    this.data.deletedTaskIds ||= [];
    if (!this.data.deletedTaskIds.includes(taskId)) this.data.deletedTaskIds.push(taskId);
    task.estimateJob = null;
    task.estimateState = null;
    if (this.data.settings.calendarMode === 'sync' && (task.remote || task.intent)) {
      task.deleting = true;
      task.syncStatus = 'deleting';
      task.issue = 'Waiting to remove the linked Google event.';
    } else {
      const kept = this.data.tasks.filter(t => t.id !== taskId);
      if (!this.data.accounts.length) return this.persistLocalPlan(kept, true);
      this.data.tasks = kept;
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
    if (['excludedCalendarIds', 'timeZone', 'calendarMode', 'targetCalendarId'].some(key => JSON.stringify(old[key]) !== JSON.stringify(next[key]))) {
      this.meetingAgenda.clear();
      this.busy = [];
      this.busyRange = null;
      this.checkedPlanningRanges = [];
    }
    if (next.calendarMode !== old.calendarMode) {
      this.auth.clear();
      this.authVersion++;
      this.tokens.clear();
      this.refreshes.clear();
      this.discovery = null;
      this.error = null;
      if (next.calendarMode === 'availability') this.pauseEventSync();
      else this.resumeEventSync();
    }
    const hoursChanged = ['timeZone', 'workDays', 'startTime', 'endTime'].some(k => JSON.stringify(old[k]) !== JSON.stringify(next[k]));
    if (hoursChanged) {
      for (const task of this.data.tasks) {
        if (!this.data.accounts.length && !task.remote && !task.intent) continue;
        if (task.pendingEstimate || task.done || task.held || task.deleting || task.remote?.allDay ||
            (task.end && Date.parse(task.end) <= this.clock().getTime())) continue;
        if (next.calendarMode === 'availability' && task.start && Date.parse(task.start) < this.clock().getTime()) continue;
        if (task.start && this.fitsHours(task.start, task.end)) continue;
        if (next.calendarMode === 'availability') {
          if (task.start) task.lastLocalSlot = { start: task.start, end: task.end };
          task.start = null;
          task.end = null;
        } else task.dirty.schedule = true;
        task.syncStatus = 'pending';
      }
    }
    if (!this.data.accounts.length) this.persistLocalPlan(this.data.tasks, true);
    else this.store.save();
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

  async beginConnection({ expectedMode, mode = this.data.settings.calendarMode, accountSub } = {}) {
    const plannerMode = this.data.settings.calendarMode;
    if (expectedMode !== undefined && expectedMode !== plannerMode) throw invalid('The calendar mode changed. Refresh Settings before connecting.', 409);
    if (mode !== 'details' && mode !== plannerMode) throw invalid('Choose the calendar access shown in Settings.', 409);
    const account = this.data.accounts.find(a => a.sub === accountSub);
    if (accountSub != null && !account) throw invalid('Choose a connected Google account.');
    const { clientId } = await this.client();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = this.origin + '/oauth/callback';
    for (const [key, request] of this.auth) if (request.expires < Date.now()) this.auth.delete(key);
    this.auth.set(state, { verifier, redirectUri, mode, plannerMode, accountSub, version: this.authVersion, expires: Date.now() + 600000 });
    return { url: this.google.authorizationUrl({ clientId, redirectUri, state, codeChallenge, mode, loginHint: account?.email }).toString() };
  }

  async finishConnection({ state, code, error }) {
    const request = this.auth.get(state);
    this.auth.delete(state);
    if (!request || request.expires < Date.now()) throw invalid('This sign-in request expired. Start again in Dayline.');
    if (error || !code) throw invalid('Google sign-in was cancelled. You can return to Dayline.');
    const checkMode = () => {
      if (request.plannerMode !== this.data.settings.calendarMode || request.version !== this.authVersion) {
        throw invalid('Calendar access changed during sign-in. Start again with the current mode.', 409);
      }
    };
    const client = await this.client();
    checkMode();
    const tokens = await this.google.exchangeCode({ ...client, ...request, code });
    checkMode();
    const profile = await this.google.getProfile(tokens.access_token);
    if (request.accountSub != null && request.accountSub !== profile.sub) {
      throw invalid('Google returned a different account. Choose the address shown for this connection in Dayline.', 409);
    }
    const existing = this.data.accounts.find(a => a.sub === profile.sub);
    const mode = request.mode === 'details' ? 'availability' : request.mode;
    const meetingDetails = request.mode === 'details';
    if (!tokens.refresh_token && (!existing?.secret || existing.mode !== mode || Boolean(existing.meetingDetails) !== meetingDetails)) {
      throw invalid('Google did not grant offline access. Reconnect and allow the requested calendar permissions.');
    }
    const secret = tokens.refresh_token ? await this.vault.seal(tokens.refresh_token) : existing.secret;
    checkMode();
    const account = { ...existing, ...profile, secret, mode, meetingDetails };
    if (existing) this.data.accounts[this.data.accounts.indexOf(existing)] = account;
    else this.data.accounts.push(account);
    this.discovery = null;
    this.meetingAgenda.clear();
    this.busy = [];
    this.busyRange = null;
    this.refreshes.delete(profile.sub);
    this.discoveredSubs.delete(profile.sub);
    this.checkedPlanningRanges = [];
    this.cacheToken(profile.sub, tokens, request.mode);
    this.error = null;
    this.store.save();
  }

  disconnect(sub) {
    if (sub != null && (typeof sub !== 'string' || !this.data.accounts.some(a => a.sub === sub))) throw invalid('Unknown Google account.');
    this.data.accounts = this.data.accounts.filter(a => sub && a.sub !== sub);
    this.calendars = this.calendars.filter(c => sub && c.sub !== sub);
    if (sub) this.discoveryErrors.delete(sub); else this.discoveryErrors.clear();
    if (sub) this.discoveredSubs.delete(sub); else this.discoveredSubs.clear();
    if (sub) this.tokens.delete(sub); else this.tokens.clear();
    this.refreshes.clear();
    this.discovery = null;
    this.meetingAgenda.clear();
    this.busy = [];
    this.busyRange = null;
    this.error = null;
    this.auth.clear();
    this.authVersion++;
    this.checkedPlanningRanges = [];
    for (const t of this.data.tasks) {
      if ((t.remote || t.intent) && !this.data.accounts.some(a => a.sub === (t.remote || t.intent).sub)) {
        t.syncStatus = t.deleting ? 'deleting' : 'pending';
        t.issue = 'Reconnect the original Google account to sync this event.';
      }
    }
    if (!this.data.accounts.length) this.persistLocalPlan(this.data.tasks, true);
    else this.store.save();
  }

  cacheToken(sub, tokens, mode) {
    this.tokens.set(sub, { mode, access: tokens.access_token, identity: tokens.id_token,
      expires: Date.now() + (tokens.expires_in || 3600) * 1000 });
  }

  async relayIdentity() {
    const account = this.data.accounts.find(a => a.email?.toLowerCase().endsWith('@antaia.space'));
    if (!account) throw invalid('Connect your Antaia Google account for live calendar notifications.', 401);
    await this.token(account.sub);
    const proof = this.tokens.get(account.sub)?.identity;
    if (typeof proof !== 'string' || !proof) throw invalid('Google did not return an identity for live notifications.', 401);
    return proof;
  }

  async token(sub) {
    const account = this.data.accounts.find(a => a.sub === sub);
    if (!account) throw invalid('Reconnect the original Google account to sync this event.', 409);
    const mode = account.mode === 'sync' && this.data.settings.calendarMode === 'sync' ? 'sync'
      : account.meetingDetails ? 'details' : 'availability';
    const cached = this.tokens.get(sub);
    if (cached?.mode === mode && cached.expires > Date.now() + 60000) return cached.access;
    const pending = this.refreshes.get(sub);
    if (pending) return pending;
    const version = this.authVersion;
    const refresh = (async () => {
      const tokens = await this.google.refreshToken({ ...await this.client(), mode, refreshToken: await this.vault.open(account.secret) });
      const replacement = tokens.refresh_token && await this.vault.seal(tokens.refresh_token);
      if (this.authVersion !== version || !this.data.accounts.includes(account)) throw invalid('Calendar access changed. Refresh your calendar.', 409);
      this.cacheToken(sub, tokens, mode);
      if (replacement) { account.secret = replacement; this.store.save(); }
      return tokens.access_token;
    })().finally(() => { if (this.refreshes.get(sub) === refresh) this.refreshes.delete(sub); });
    this.refreshes.set(sub, refresh);
    return refresh;
  }

  discover() {
    if (this.discovery) return this.discovery;
    const accounts = [...this.data.accounts];
    const current = Promise.allSettled(accounts.map(async account => {
      const calendars = await this.google.listCalendars(await this.token(account.sub));
      return calendars.map(c => ({ ...c, sub: account.sub, accountEmail: account.email, accountMode: account.mode,
        providerId: c.id, id: recordKey(account.sub, c.id) }));
    })).then(groups => {
      if (this.discovery !== current) return;
      const calendars = groups.flatMap(group => group.status === 'fulfilled' ? group.value : []);
      this.discoveryErrors = new Set(accounts.filter((account, i) => groups[i].status === 'rejected').map(account => account.sub));
      this.discoveredSubs = new Set(accounts.filter((account, i) => groups[i].status === 'fulfilled').map(account => account.sub));
      if (JSON.stringify(calendars) !== JSON.stringify(this.calendars)) this.meetingAgenda.clear();
      this.calendars = calendars;
      const failure = groups.find(group => group.status === 'rejected');
      // Scheduling needs an answer from every account. The agenda can still
      // show meetings from the accounts that Google successfully returned.
      if (failure) throw failure.reason;
    }).finally(() => { if (this.discovery === current) this.discovery = null; });
    this.discovery = current;
    return current;
  }

  canReadMeetings(account) {
    return account.meetingDetails === true || (account.mode === 'sync' && this.data.settings.calendarMode === 'sync');
  }

  calendarBoardRange(now = this.clock()) {
    const monday = DateTime.fromJSDate(now, { zone: this.data.settings.timeZone }).startOf('week');
    return { start: monday.toUTC().toISO(), end: monday.plus({ weeks: 5 }).toUTC().toISO() };
  }

  calendarMonitorSources() {
    const accounts = new Map(this.data.accounts.map(account => [account.sub, account]));
    const excluded = new Set(this.data.settings.excludedCalendarIds);
    const target = this.data.settings.calendarMode === 'sync' ? this.selectedTarget()?.id : null;
    const calendars = this.calendars.filter(c => accounts.has(c.sub) && c.canCheckAvailability !== false &&
      (c.id === target || !excluded.has(c.id))).map(c => ({
        sub: c.sub, id: c.providerId, details: c.accessRole !== 'freeBusyReader' && this.canReadMeetings(accounts.get(c.sub))
      }));
    const ranges = calendars.length ? [this.busyRange || this.calendarBoardRange(),
      ...this.checkedPlanningRanges, ...this.meetingAgenda.ranges()] : [];
    const uncertainSubs = this.data.accounts.filter(a => !this.discoveredSubs.has(a.sub)).map(a => a.sub);
    return { revision: this.authVersion, calendars, ranges, uncertainSubs };
  }

  async meetings({ from, to }) {
    const range = meetingRange(from, to, this.data.settings.timeZone);
    if (!this.data.accounts.some(account => this.canReadMeetings(account))) return { events: [], warnings: [] };
    if (!this.calendars.length) {
      try { await this.discover(); }
      catch { /* Each account that failed discovery is identified below. */ }
    }
    const enabled = new Set(this.data.accounts.filter(account => this.canReadMeetings(account)).map(account => account.sub));
    const { excludedCalendarIds, calendarMode } = this.data.settings;
    const target = calendarMode === 'sync' ? this.selectedTarget()?.id : null;
    const calendars = this.calendars.filter(c => enabled.has(c.sub) && c.canCheckAvailability !== false &&
      c.accessRole !== 'freeBusyReader' && (!excludedCalendarIds.includes(c.id) || c.id === target));
    const representedTaskIds = new Set(this.data.tasks.filter(task => !completedBesideMeeting(task) &&
      (task.remote || task.intent || (task.pausedSync?.original?.start && task.start === task.pausedSync.original.start && task.end === task.pausedSync.original.end)))
      .map(task => task.id));
    const week = await this.meetingAgenda.read(calendars, range, async (calendar, interval) =>
      this.readMeetings(await this.token(calendar.sub), { ...calendar, representedTaskIds }, interval));
    const warnings = this.data.accounts.filter(a => this.canReadMeetings(a) && this.discoveryErrors.has(a.sub))
      .map(a => 'Check the Google connection for ' + a.email + ' in Settings to load its meetings.');
    return warnings.length ? { events: week.events, warnings: [...week.warnings, ...warnings] } : week;
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

  async availability(range, destinationId, reservations = [], precise = false) {
    if (!Array.isArray(reservations)) reservations = [reservations];
    const byCalendar = new Map();
    for (const ref of reservations) {
      this.syncPermission(ref.sub);
      const key = recordKey(ref.sub, ref.calendarId);
      if (!byCalendar.has(key)) byCalendar.set(key, []);
      byCalendar.get(key).push(ref);
    }
    const excluded = new Set(this.data.settings.excludedCalendarIds);
    const target = this.data.settings.calendarMode === 'sync' ? this.selectedTarget() : null;
    const selected = this.calendars.filter(c => c.canCheckAvailability !== false &&
      (c.id === target?.id || c.id === destinationId || (!precise && byCalendar.has(c.id)) || !excluded.has(c.id)));
    // A shared calendar can be listed by more than one Google identity. Read
    // the physical source once through the grant that can verify our event IDs.
    const physicalId = calendar => calendar.providerId === 'primary' ? calendar.id : calendar.providerId;
    const inspectors = new Map();
    for (const calendar of selected) {
      if (byCalendar.has(calendar.id) && calendar.canInspectReservations === true) {
        const source = physicalId(calendar);
        if (!inspectors.has(source)) inspectors.set(source,{ calendar, reservations:[] });
        inspectors.get(source).reservations.push(...byCalendar.get(calendar.id));
      }
    }
    const chosen = selected.filter(c => !inspectors.has(physicalId(c)) || inspectors.get(physicalId(c)).calendar === c);
    if (!chosen.length) throw invalid('Select at least one calendar to check availability.', 409);
    const groups = await Promise.all(this.data.accounts.map(async account => {
      const calendars = chosen.filter(c => c.sub === account.sub);
      if (!calendars.length) return [];
      try {
        const access = await this.token(account.sub);
        const inspect = calendars.filter(c => inspectors.has(physicalId(c)));
        const calendarIds = calendars.filter(c => !inspect.includes(c)).map(c => c.providerId);
        const busy = calendarIds.length ? await this.google.getBusy(access, { ...range, calendarIds }) : [];
        for (const calendar of inspect) {
          const matching = inspectors.get(physicalId(calendar)).reservations;
          if (precise) {
            busy.push(...await this.google.busyWithoutReservations(access, { ...range, calendarId: calendar.providerId,
              timeZone: calendar.timeZone, reservations: matching, confirm: precise === 'confirm' }));
            continue;
          }
          const eventIds = matching.map(ref => ref.eventId);
          if (await this.google.hasOtherBusyEvent(access, { ...range, calendarId: calendar.providerId, eventId: eventIds[0], eventIds })) {
            busy.push(range);
          }
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

  projectCalendarCompletion(task, now = this.clock()) {
    const { remote } = task, zone = this.data.settings.timeZone;
    if (!remote || !task.done) return false;
    const changedFields = () => JSON.stringify([task.start,task.end,task.completedDay,task.completedPlannedSlot,task.overrunMinutes,task.overrunWatchStart,
      task.lastLocalSlot,task.durationCheckPending,remote,task.dirty]);
    const before = changedFields();
    if (!remote.providerSlot && task.start && task.end) remote.providerSlot = slotOf(task);
    const physical = remote.providerSlot;
    if (remote.calendarAppointment) {
      const projection = { ...task };
      releaseCompletedTime(projection,now,zone);
      if (projection.completedDay) task.completedDay = projection.completedDay;
      if (projection.completedPlannedSlot) task.completedPlannedSlot = projection.completedPlannedSlot;
      delete remote.releasedSlot;
      delete task.dirty.release;
    } else {
      const known = Date.parse(task.completedAt);
      const cutoff = Number.isFinite(known) ? Math.min(known,now.getTime()) : now.getTime();
      if (!remote.releasedSlot && physical && Date.parse(physical.end) > cutoff) {
        const partial = !remote.allDay && Number.isFinite(known) && Date.parse(physical.start) < cutoff;
        remote.releasedSlot = { ...physical, cutoff: new Date(cutoff).toISOString(), kind: partial ? 'trim' : 'free' };
        if (partial) remote.releasedSlot.providerEnd = new Date(Math.min(Date.parse(physical.end),Math.ceil(cutoff / 1000) * 1000)).toISOString();
      }
      const release = remote.releasedSlot;
      if (release) {
        Object.assign(task,slotOf(release));
        releaseCompletedTime(task,new Date(release.cutoff),zone);
        const changed = release.kind === 'free' ? !remote.transparent : Date.parse(physical?.end) !== Date.parse(release.providerEnd || release.cutoff);
        if (changed) task.dirty.release = true;
        else delete task.dirty.release;
      } else releaseCompletedTime(task,now,zone);
      delete task.dirty.schedule;
    }
    return before !== changedFields();
  }

  acceptRemote(task, event, ref, { pulled = false } = {}) {
    if (!event.owned || event.taskId !== task.id) throw invalid('Google could not verify ownership of the linked event.', 409);
    if (!event.start || !event.end) throw invalid('The linked event needs a timed start and end in Google Calendar.', 409);
    if (task.estimateRemoteTitle && event.text !== task.estimateRemoteTitle && event.text !== task.title) {
      // A person renamed this appointment in Calendar after the model started.
      delete task.dirty.text;
    }
    if (!task.dirty.text) {
      delete task.estimateRemoteTitle;
      if (task.title) {
        if (task.remote && event.text !== task.title) {
          task.estimateOverrides ||= {};
          task.estimateOverrides.title = event.text;
        }
        task.title = event.text;
      }
      else task.text = event.text;
    }
    const wasDone = Boolean(task.done);
    if (!task.dirty.done) task.done = event.done;
    if (pulled && wasDone !== task.done) setChecklistCompletion(task,task.done);
    const now = this.clock();
    if (task.done && !wasDone && !task.completedAt) {
      const updated = Date.parse(event.updated);
      task.completedAt = Number.isFinite(updated) && updated <= now.getTime() ? new Date(updated).toISOString() : now.toISOString();
    }
    // Google all-day dates float with the calendar day. The board groups by local
    // instants, and a day-long reservation should preserve the task’s estimated effort.
    const allDay = DAY.test(event.start) && DAY.test(event.end);
    const instant = value => allDay ? DateTime.fromISO(value, { zone: this.data.settings.timeZone }).toUTC().toISO() : value;
    const slot = { start: instant(event.start), end: instant(event.end) };
    const priorSlot = ref.providerSlot || (task.start && task.end ? task : null);
    const manualChange = pulled && priorSlot && !sameSlot(priorSlot, slot) && !sameSlot(ref.proposedSlot, slot);
    const manualTime = ref.manualTime || manualChange;
    const rebooked = !task.done && !event.done && !event.transparent && ref.proposedSlot?.rebook && sameSlot(ref.proposedSlot,slot);
    const released = ref.proposedSlot?.completion && ref.proposedSlot.completionDone === task.done && event.done === task.done &&
      sameSlot(ref.proposedSlot,slot) && (ref.proposedSlot.completion === 'trim' || event.transparent);
    if (released) delete task.dirty.done;
    if (rebooked) {
      delete task.dirty.done;
      if (scheduleFields.every(key => task[key] === ref.proposedSlot.rebook[key])) delete task.dirty.schedule;
    }
    if (manualChange) {
      delete task.calendarFit;
      delete task.overrunMinutes;
      delete task.overrunWatchStart;
    }
    if (sameSlot(ref.proposedSlot,slot) && Number.isSafeInteger(ref.proposedSlot?.overrunMinutes)) {
      task.overrunMinutes = ref.proposedSlot.overrunMinutes;
    }
    if (sameSlot(ref.proposedSlot, slot) && owns(ref.proposedSlot, 'originalMinutes') && task.estimateOverrides?.minutes == null) {
      if (ref.proposedSlot.originalMinutes) task.calendarFit = { originalMinutes: ref.proposedSlot.originalMinutes };
      else delete task.calendarFit;
    }
    Object.assign(task, slot);
    if (!allDay && !task.overrunMinutes && !task.dirty.schedule && !ref.releasedSlot && !(task.done && (task.estimateOverrides?.minutes != null || ref.proposedSlot?.completion))) {
      const length = Math.round((Date.parse(task.end) - Date.parse(task.start)) / 60000);
      if (length > 0) task.minutes = length;
    }
    if (task.remote && task.remote.done !== event.done && !task.dirty.done && !rebooked && !released) task.dirty.link = true;
    task.remote = { sub: ref.sub, calendarId: ref.calendarId, eventId: event.eventId, etag: event.etag, done: event.done, providerSlot:slot };
    if (event.transparent) task.remote.transparent = true;
    if (ref.releasedSlot && !rebooked && !event.calendarAppointment) task.remote.releasedSlot = ref.releasedSlot;
    if (manualTime) task.remote.manualTime = true;
    if (event.calendarAppointment) task.remote.calendarAppointment = true;
    if (allDay) task.remote.allDay = { start: event.start, end: event.end };
    task.intent = null;
    if (task.done) {
      if (manualChange && task.remote.releasedSlot?.kind === 'trim') {
        // Respect a later manual placement while keeping a completed task free.
        task.remote.releasedSlot = { ...task.remote.releasedSlot, kind: 'free' };
      }
      this.projectCalendarCompletion(task,now);
    } else if (!event.calendarAppointment && !rebooked && (ref.releasedSlot || ref.done || wasDone)) {
      task.remote.releasedSlot ||= { ...slot, kind: 'free', cutoff: now.toISOString() };
      if (!task.reopenedAt || wasDone) reopenCompletedTask(task,now);
      task.start = task.end = null;
      task.dirty.schedule = true;
    } else if (!task.done && event.calendarAppointment) {
      delete task.completedAt;
      delete task.completedDay;
      delete task.completedPlannedSlot;
    }
    task.issue = null;
    task.syncStatus = Object.keys(task.dirty).length ? 'pending' : 'synced';
  }

  async pullChanges() {
    if (this.data.settings.calendarMode !== 'sync') return;
    const groups = new Map();
    for (const task of this.data.tasks) {
      if (!task.remote || (task.pendingEstimate && !task.deleting && !task.estimateJob?.protected)) continue;
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
        if (event) {
          if (task.estimateJob?.protected && event.done && !ref.done && !task.dirty.done) keepRevisionWording(task);
          this.acceptRemote(task, event, ref, { pulled: true });
          if (task.pendingEstimate) waitForEstimate(task);
          continue;
        }
        if (task.deleting) { this.data.tasks = this.data.tasks.filter(t => t !== task); continue; }
        if (task.estimateJob?.protected) keepRevisionWording(task);
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

  async cachedAvailability(range, destinationId, cache) {
    const key = destinationId + '|' + range.start + '|' + range.end;
    if (!cache.has(key)) cache.set(key, await this.availability(range, destinationId));
    return cache.get(key);
  }

  async bookingAvailability(task,range,destination,cache) {
    const ref = task.remote;
    if (ref?.releasedSlot && !ref.transparent && !ref.allDay && overlaps(ref.providerSlot,range)) {
      return this.availability(range,destination,[{...ref,taskId:task.id,...ref.providerSlot}],true);
    }
    return this.cachedAvailability(range,destination,cache);
  }

  movableFlexibleEvent(task, now = this.clock()) {
    if (!task.start || !task.end || Date.parse(task.start) <= now.getTime() || task.done || task.held ||
        task.deleting || task.pendingEstimate || task.intent || explicitStartFor(task, this.data.settings.timeZone)) return false;
    if (!task.remote) return true; // A local preview has no event to move.
    return !task.remote.allDay && !task.remote.manualTime && !task.remote.calendarAppointment && !Object.keys(task.dirty).length &&
      this.calendars.some(c => c.sub === task.remote.sub && c.providerId === task.remote.calendarId &&
        c.accountMode === 'sync' && c.writable && c.canInspectReservations === true);
  }

  async replacementFor(task, reserved, rangeCache) {
    const { settings } = this.data;
    const now = this.clock();
    const range = planningRange({ task, settings, now });
    if (!range) return null;
    const dest = recordKey(task.remote.sub, task.remote.calendarId);
    const raw = await this.cachedAvailability(range, dest, rangeCache);
    const busy = [...withoutSlots(raw, [task]), ...this.localBusy(task.id), ...reserved];
    for (;;) {
      const slot = nextFlexibleSlot(task, settings, now, busy);
      if (!slot) return null;
      const blockers = await this.availability(slot, dest, overlaps(slot, task) ? [task.remote] : []);
      if (!blockers.length) return slot;
      busy.push(...blockers);
    }
  }

  async writeEvent(task, ref, slot, rangeCache, completionAction) {
    // Keep the old confirmed time until the PATCH returns. After an interrupted
    // write, the next pull can distinguish our move from a person's calendar edit.
    const plannedEffort = Number.isSafeInteger(slot.minutes);
    if ((task.remote && !sameSlot(task, slot)) || plannedEffort || completionAction) {
      ref.proposedSlot = task.remote?.allDay && DAY.test(slot.start) ? { ...task.remote.providerSlot } : slotOf(slot);
      if (completionAction === 'book') {
        ref.proposedSlot.rebook = Object.fromEntries(scheduleFields.map(key => [key,task[key]]));
      } else if (completionAction) {
        ref.proposedSlot.completion = completionAction;
        ref.proposedSlot.completionDone = task.done;
      }
      if (Number.isSafeInteger(slot.overrunMinutes)) ref.proposedSlot.overrunMinutes = slot.overrunMinutes;
      if (plannedEffort) {
        const full = fullTaskMinutes(task);
        ref.proposedSlot.originalMinutes = slot.minutes < full ? full : null;
      }
      if (task.intent) task.intent.proposedSlot = ref.proposedSlot;
      this.store.save();
    }
    rangeCache.clear();
    return this.google.putTaskEvent(await this.eventToken(ref.sub), { ...ref, completionAction, adjustingOverrun:Number.isSafeInteger(slot.overrunMinutes),
      task: { ...task, ...slot, text: task.title || task.text },
      actionUrl: this.origin + '/action/' + task.id + '?done=' + (task.done ? '0' : '1'), expectedEtag: task.remote?.etag || null });
  }

  async moveFlexibleEvent(task, slot, allowed, cache, canMove = other => this.movableFlexibleEvent(other)) {
    if (!canMove(task) || Date.parse(slot.start) < this.clock().getTime()) {
      throw invalid('This time has already started or become fixed. Sync again to check the latest opening.', 409);
    }
    const dest = recordKey(task.remote.sub, task.remote.calendarId);
    const refs = allowed.filter(other => overlaps(other, slot)).map(reservationOf);
    if ((await this.availability(slot, dest, refs, 'confirm')).length) {
      throw invalid('An event now occupies the proposed time. Sync again to check the calendar.', 409);
    }
    if (Date.parse(slot.start) < this.clock().getTime() || !canMove(task)) {
      throw invalid('This time began while Google was checking availability. Sync again for a future opening.', 409);
    }
    const ref = task.remote;
    const event = await this.writeEvent(task, ref, slot, cache);
    this.acceptRemote(task, event, ref);
    this.store.save();
  }

  eligibleEventOverrun(task) {
    return Boolean(task.remote && !task.remote.transparent && this.movableFlexibleEvent(task,new Date(Date.parse(task.start) - 1)));
  }

  async extendRunningEvent(cache) {
    const { tasks, settings } = this.data;
    const now = this.clock();
    const canExtend = task => this.eligibleEventOverrun(task);
    const canYield = task => canExtend(task) && task.overrunWatchStart !== task.start;
    const context = { tasks, settings, now, canExtend, canYield };
    for (const task of tasks) {
      if (!task.overrunMinutes || !canExtend(task) || Date.parse(task.end) <= now.getTime()) continue;
      const dest = recordKey(task.remote.sub,task.remote.calendarId);
      const refs = [task,...tasks.filter(other => other !== task && canYield(other) && overlaps(other,task))].map(reservationOf);
      const busy = await this.availability(slotOf(task),dest,refs,true);
      const cap = capOverrun({ ...context, task, busy });
      if (cap) {
        const ref = task.remote;
        const event = await this.writeEvent(task,ref,{ ...slotOf(cap), overrunMinutes:cap.overrunMinutes },cache);
        this.acceptRemote(task,event,ref);
        this.store.save();
        return;
      }
    }
    const possible = proposeOverrun(context);
    if (!possible) return;
    const { task } = possible;
    const dest = recordKey(task.remote.sub,task.remote.calendarId);
    const refs = [task,...possible.displaced].map(reservationOf);
    const busy = await this.availability(slotOf(possible),dest,refs,true);
    const plan = proposeOverrun({ ...context, busy });
    if (!plan) return;

    const reserved = [slotOf(plan)];
    const moves = [];
    for (const next of plan.displaced) {
      const slot = await this.replacementFor(next,reserved,cache);
      if (!slot) return;
      reserved.push(slot);
      moves.push({ next,slot });
    }
    // The watched predecessor was still running at the handoff. Only its
    // unobserved, personally owned successors can yield across that boundary.
    for (const {next,slot} of moves) {
      await this.moveFlexibleEvent(next,slot,[next],cache,other => canYield(other) &&
        Date.parse(other.start) >= Date.parse(task.end) && this.clock().getTime() < Date.parse(plan.end));
    }
    if (!canExtend(task) || this.clock().getTime() >= Date.parse(plan.end) ||
        (await this.availability(slotOf(plan),dest,[reservationOf(task)],'confirm')).length) {
      throw invalid('Calendar availability changed before the running task could extend. Sync again to check the next opening.',409);
    }
    const ref = task.remote;
    const event = await this.writeEvent(task,ref,{...slotOf(plan),overrunMinutes:plan.overrunMinutes},cache);
    this.acceptRemote(task,event,ref);
    this.store.save();
  }

  async finishEventSwap(cache) {
    const group = this.data.eventMoveGroup;
    if (!group) return;
    const members = group.map(step => this.data.tasks.find(task => task.id === step.id));
    const obsolete = () => {
      delete this.data.eventMoveGroup;
      this.store.save();
      throw invalid('A reservation changed while reordering. Sync again to plan around the latest calendar changes.', 409);
    };
    // Supersede a previous order or a manual calendar edit without replaying it.
    if (members.some(task => !task || !this.movableFlexibleEvent(task)) ||
        this.data.tasks.filter(task => members.includes(task)).some((task,i) => task !== members[i])) return obsolete();
    for (const [i,step] of group.entries()) {
      const task = members[i], ref = task.remote;
      if (ref.sub !== step.sub || ref.calendarId !== step.calendarId || ref.eventId !== step.eventId ||
          !(sameSlot(task,step.to) || (sameSlot(task,step.from) && ref.etag === step.etag))) return obsolete();
      const current = await this.google.getTaskEvent(await this.eventToken(ref.sub), { ...ref, taskId: task.id });
      if (!current?.owned || current.taskId !== task.id || current.etag !== ref.etag || current.done ||
          current.calendarAppointment || !sameSlot(current,task)) return obsolete();
    }
    // Preflight the whole pair/cycle before allowing any transient overlap.
    for (const [i,step] of group.entries()) {
      if (sameSlot(members[i],step.to)) continue;
      const dest = recordKey(step.sub,step.calendarId);
      const refs = members.filter(other => overlaps(other,step.to)).map(reservationOf);
      if ((await this.availability(step.to,dest,refs,'confirm')).length) return obsolete();
    }
    for (const [i,step] of group.entries()) {
      if (!sameSlot(members[i],step.to)) await this.moveFlexibleEvent(members[i],step.to,members,cache);
    }
    delete this.data.eventMoveGroup;
    this.store.save();
  }

  async compactEventReservations(cache) {
    const { tasks, settings } = this.data;
    const now = this.clock();
    const movable = tasks.filter(task => task.remote && this.movableFlexibleEvent(task,now));
    const candidates = tasks.filter(task => movable.includes(task) || (!task.remote && !task.intent && !task.start && !task.done &&
      !task.deleting && !task.held && !task.pendingEstimate && !explicitStartFor(task,settings.timeZone)));
    if (!candidates.length) return;
    const fixed = tasks.filter(task => !candidates.includes(task) && !task.deleting && task.start && task.end &&
      (!task.pendingEstimate || task.estimateJob?.protected));
    const checkedRanges = new Map(), external = new Map();
    for (const task of candidates) {
      const range = planningRange({ task, settings, now });
      if (!range) continue;
      const dest = task.remote ? recordKey(task.remote.sub, task.remote.calendarId) : this.target().id;
      const key = dest + '|' + range.start + '|' + range.end;
      if (!checkedRanges.has(key)) {
        const reservations = movable.filter(other => overlaps(other, range)).map(reservationOf);
        checkedRanges.set(key, await this.availability(range, dest, reservations, true));
      }
      external.set(task.id, checkedRanges.get(key));
    }
    const preserved = new Set();
    let moves, additions;
    // A reservation with no legal replacement retains its original time. Plan
    // again around it before committing any moves onto another event's slot.
    for (;;) {
      moves = [];
      additions = [];
      const failed = [];
      const active = candidates.filter(task => !preserved.has(task));
      const slots = planFlexibleSlots({ tasks: active.filter(task => external.has(task.id)), settings, now, reserved: [...fixed,...preserved],
        externalFor: task => external.get(task.id), allowCatchUp: false });
      for (const task of active) {
        const slot = slots.get(task.id);
        if (!slot) { if (task.remote) failed.push(task); continue; }
        if (!task.remote) additions.push({ task, slot });
        else if (!sameSlot(task,slot)) moves.push({ task, slot });
      }
      if (!failed.length) break;
      for (const task of failed) {
        preserved.add(task);
        task.issue = noSlot + ' Google still holds the previous time.';
        task.syncStatus = 'attention';
      }
    }
    while (moves.length) {
      const vacant = moves.find(move => !moves.some(other => other !== move && overlaps(other.task,move.slot)));
      if (vacant) {
        await this.moveFlexibleEvent(vacant.task,vacant.slot,[vacant.task],cache);
        moves = moves.filter(move => move !== vacant);
        continue;
      }
      // A cycle can normally use one vacant legal slot as a temporary step.
      const first = moves[0];
      const spare = await this.replacementFor(first.task,moves.map(move => move.slot),cache);
      if (spare && !sameSlot(first.task,spare)) {
        await this.moveFlexibleEvent(first.task,spare,[first.task],cache);
        continue;
      }
      // In a completely booked window all target slots belong to this group.
      // Preserve both halves of the swap on disk before the first PATCH.
      this.data.eventMoveGroup = moves.map(({task,slot}) => ({ id:task.id,sub:task.remote.sub,calendarId:task.remote.calendarId,
        eventId:task.remote.eventId,etag:task.remote.etag,from:slotOf(task),to:slot }));
      this.store.save();
      await this.finishEventSwap(cache);
      break;
    }
    for (const item of additions) await this.pushTask(item.task,cache,item.slot);
  }

  async explicitPlacement(task, range, destinationId, rangeCache) {
    const { settings } = this.data;
    const now = this.clock();
    const others = this.data.tasks.filter(t => t !== task && t.start && t.end && !t.deleting && (!t.pendingEstimate || t.estimateJob?.protected));
    const flexible = others.filter(t => this.movableFlexibleEvent(t, now));
    const fixed = others.filter(t => !flexible.includes(t));
    const movableEvents = flexible.filter(t => t.remote);
    const raw = await this.bookingAvailability(task,range,destinationId,rangeCache);
    const ownedSlots = task.remote && !task.remote.allDay ? [...movableEvents, task] : movableEvents;
    const possible = withoutSlots(raw, ownedSlots);
    const busy = [...possible, ...fixed];
    const request = { task, settings, now, allowInProgress: !task.remote?.releasedSlot };
    const original = task.remote && Date.parse(task.start) >= now.getTime() &&
      findSlot({ ...request, now: new Date(task.start), busy });
    let preferred = original && Date.parse(original.start) === Date.parse(task.start) ? original : null;
    let issue = null;
    for (;;) {
      const slot = preferred || findSlot({ ...request, busy });
      preferred = null;
      if (!slot) {
        task.issue = issue || explicitSchedulingIssue({ ...request, tasks: others, busy: possible, placements: new Map() });
        return null;
      }
      const displaced = movableEvents.filter(t => overlaps(t, slot));
      const physical = task.remote?.providerSlot || task;
      const own = task.remote && !task.remote.transparent && overlaps(physical, slot) ? [task.remote] : [];
      const ignore = [...own, ...displaced.map(t => t.remote)];
      // The exact time must be free on every other calendar, and on the source
      // calendars once these specific, verified Dayline event IDs are excluded.
      const clock = explicitStartFor(task, settings.timeZone);
      if (!(await this.availability(slot, destinationId, ignore)).length) {
        const moves = [];
        for (const other of displaced) {
          const next = await this.replacementFor(other, [slot, ...moves.map(move => move.slot)], rangeCache);
          if (!next) break;
          moves.push({ task: other, slot: next });
        }
        if (moves.length === displaced.length) {
          for (const move of moves) {
            const other = move.task;
            const ref = other.remote;
            const dest = recordKey(ref.sub, ref.calendarId);
            if (!this.movableFlexibleEvent(other, this.clock()) ||
                (await this.availability(move.slot, dest, overlaps(other, move.slot) ? [ref] : [])).length) {
              throw invalid('Availability changed while moving a flexible task. Sync again to check the new times.', 409);
            }
            const event = await this.writeEvent(other, ref, move.slot, rangeCache);
            this.acceptRemote(other, event, ref);
            this.store.save();
          }
          if (moves.length && (await this.availability(slot, destinationId, own)).length) {
            throw invalid('Another event now occupies the requested time. Sync again to check the calendar.', 409);
          }
          return slot;
        }
        issue = 'A flexible task already occupies ' + clock + ' and has no other open slot. Change a task’s time, duration, or working hours.';
      } else issue = 'Google Calendar is busy at the requested ' + clock + ' start. Change the time or day.';
      // There can be another valid day for a clock-only request. A task pinned
      // to one date remains unscheduled when that appointment cannot be placed.
      busy.push(slot);
    }
  }

  async pushTask(task, rangeCache, plannedSlot) {
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
    if (task.remote && !Object.keys(task.dirty).length) { delete task.commandEventPending; return; }
    if (task.commandEventPending && protectedCommandAppointment(task)) {
      throw invalid('Google Calendar now protects this appointment. Review it in Google Calendar before changing its reservation.', 409);
    }
    if (ref && !this.calendars.some(c => c.sub === ref.sub && c.providerId === ref.calendarId && c.writable)) {
      throw invalid('Reconnect the original writable calendar to sync this task.', 409);
    }

    // A previous insertion may already have reached Google even if the app lost its response.
    if (!task.remote && task.intent) {
      const found = await this.google.getTaskEvent(await this.eventToken(ref.sub), { ...ref, taskId: task.id });
      if (found) {
        const later = { ...task.dirty };
        for (const field of ['category', 'done']) if (task[field] === task.intent.snapshot[field]) delete later[field];
        if (task.text === task.intent.snapshot.text && task.title === task.intent.snapshot.title) delete later.text;
        if (task.minutes === task.intent.snapshot.minutes && task.earliestDay === task.intent.snapshot.earliestDay &&
            task.latestDay === task.intent.snapshot.latestDay && task.windowStart === task.intent.snapshot.windowStart &&
            task.windowEnd === task.intent.snapshot.windowEnd && task.deadlineTime === task.intent.snapshot.deadlineTime) delete later.schedule;
        task.dirty = later;
        this.acceptRemote(task, found, ref);
        if (!Object.keys(later).length) { this.store.save(); return; }
        ref = task.remote;
      }
    }

    let slot = task.remote?.allDay || task.remote?.providerSlot || { start: task.start, end: task.end };
    let waitingForSlot = false;
    const release = task.remote?.releasedSlot;
    let completionAction;
    if (task.done && release) {
      completionAction = release.kind;
      if (completionAction === 'trim') slot = { start: slot.start, end: release.providerEnd || release.cutoff };
    } else if (plannedSlot && !ref) {
      if ((await this.availability(plannedSlot,this.target().id)).length) throw invalid('The proposed time is now busy. Sync again to check the calendar.',409);
      slot = plannedSlot;
    } else if (task.dirty.schedule || !ref) {
      const now = this.clock();
      const range = planningRange({ task, settings, now });
      let placement = null;
      if (range) {
        const destinationId = ref ? recordKey(ref.sub, ref.calendarId) : this.target().id;
        if (explicitStartFor(task, settings.timeZone)) {
          placement = await this.explicitPlacement(task, range, destinationId, rangeCache);
        } else {
          const busy = await this.bookingAvailability(task,range,destinationId,rangeCache);
          // Reuse this reservation only after checking for a second, overlapping event.
          if (task.remote && !task.remote.allDay && Date.parse(task.end) > now.getTime()) {
            const candidate = findSlot({ task, settings, now: new Date(task.start), busy: this.localBusy(task.id) });
            if (candidate && Date.parse(candidate.start) === Date.parse(task.start) &&
                !(await this.availability(candidate, destinationId, task.remote)).length) placement = candidate;
          }
          placement ||= findSlot({ task, settings, now, busy: [...busy, ...this.localBusy(task.id)] });
        }
      }
      if (!placement) {
        if (!task.remote) { task.start = null; task.end = null; }
        const detail = explicitStartFor(task, settings.timeZone) ? task.issue : null;
        task.issue = (detail || noSlot) + (release && !task.done ? ' The completed time stays free until a new slot is confirmed.' :
          task.remote ? ' Google still holds the previous time.' : '');
        task.syncStatus = 'attention';
        // A completion gesture still reaches an existing reservation when rescheduling cannot fit.
        if (!task.remote || !(task.dirty.done || (release && task.dirty.link))) return;
        waitingForSlot = true;
        if (release?.kind === 'free' && !task.remote.transparent) completionAction = 'free';
      } else {
        slot = placement;
        if (release && !task.done) {
          const dest = recordKey(ref.sub,ref.calendarId);
          // It may have been restored to busy by another client. Ignore this
          // old block only after verifying its current ownership and version.
          const physical = task.remote.providerSlot;
          const self = !task.remote.transparent && !task.remote.allDay && physical && overlaps(physical,slot) ? [{ ...ref,taskId:task.id,...physical }] : [];
          if (Date.parse(slot.start) < this.clock().getTime() || (await this.availability(slot,dest,self,'confirm')).length) {
            throw invalid('The proposed reopening time is no longer free. Sync again to check the calendar.',409);
          }
          completionAction = 'book';
        }
      }
    }
    if (!ref) {
      const dest = this.target();
      ref = { sub: dest.sub, calendarId: dest.providerId, eventId: id() };
    }
    if (!task.remote) {
      task.intent = { ...ref, snapshot: {
        text: task.text, title: task.title, category: task.category, done: task.done, minutes: task.minutes, earliestDay: task.earliestDay,
        latestDay: task.latestDay, windowStart: task.windowStart, windowEnd: task.windowEnd, deadlineTime: task.deadlineTime
      } };
      this.store.save();
    }
    const event = await this.writeEvent(task, ref, slot, rangeCache,completionAction);
    const issue = task.issue;
    if (!waitingForSlot) delete task.commandEventPending;
    task.dirty = waitingForSlot ? { schedule: true } : {};
    this.acceptRemote(task, event, ref);
    // The response is authoritative, including recovery from an idempotent duplicate insert.
    delete task.dirty.link;
    if (waitingForSlot) { task.issue = issue; task.syncStatus = 'attention'; }
    else task.syncStatus = 'synced';
    this.store.save();
  }

  futureLocalTask(task, now) {
    return canMoveLocalTask(task, now);
  }

  async planAgainstCalendars(boardRange) {
    const settings = this.data.settings;
    const zone = settings.timeZone;
    const busy = [], checked = [];
    let now = this.clock();
    for (;;) {
      const ranges = [boardRange];
      for (const task of this.data.tasks) {
        const active = task.start && Date.parse(task.end) > now.getTime() && canMoveLocalTask(task, new Date(task.start));
        if (!canMoveLocalTask(task, now) && !active) continue;
        ranges.push(planningRange({ task, settings, now }));
        const prior = task.start ? task : task.lastLocalSlot;
        if (prior && (task.durationCheckPending || explicitStartFor(task, zone))) {
          ranges.push(prior);
          const resized = findSlot({ task, settings, now: new Date(prior.start) });
          if (resized && Date.parse(resized.start) === Date.parse(prior.start)) ranges.push(resized);
        }
      }
      const missing = uncoveredRanges(ranges, combinedRanges(checked));
      for (const range of missing) busy.push(...await this.availability(range));
      checked.push(...missing);
      const before = DateTime.fromJSDate(now, { zone });
      now = this.clock();
      const after = DateTime.fromJSDate(now, { zone });
      if (after.hasSame(before, 'day')) break;
      // A laptop can wake during a request. Cover the new day's horizon and
      // schedule from the current clock before exposing any placements.
      boardRange = this.calendarBoardRange(now);
    }

    const planned = this.plannedTasks(this.data.tasks, busy, now, { overruns: true });
    planned.forEach((task, i) => { if (task !== this.data.tasks[i]) copyRecord(this.data.tasks[i], task); });
    this.busy = busy.filter(e => Date.parse(e.end) > Date.parse(boardRange.start) && Date.parse(e.start) < Date.parse(boardRange.end));
    this.busyRange = boardRange;
    this.checkedPlanningRanges = combinedRanges(checked);
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
    this.transientSyncError = false;
    this.retrySyncAt = 0;
    if (!this.data.accounts.length) { this.persistLocalPlan(this.data.tasks); return; }
    try {
      await this.discover();
      const range = this.calendarBoardRange();
      if (this.data.settings.calendarMode === 'availability') {
        await this.planAgainstCalendars(range);
        this.data.lastSync = this.clock().toISOString();
        return;
      }
      await this.pullChanges();
      this.store.save();
      const rangeCache = new Map();
      await this.finishEventSwap(rangeCache);
      let firstError = null;
      try { this.target(); }
      catch (error) { firstError = messageOf(error); }
      const rank = task => task.deleting || (task.done && (task.dirty.done || task.dirty.release)) ? 0 : explicitStartFor(task, this.data.settings.timeZone) ? 1 : 2;
      const ordered = this.data.tasks.map(task => ({ task, rank: rank(task) }));
      ordered.sort((a, b) => a.rank - b.rank || (a.rank === 1 && Date.parse(a.task.estimateRequestedAt || a.task.createdAt) - Date.parse(b.task.estimateRequestedAt || b.task.createdAt)));
      for (const { task } of ordered) {
        try { await this.pushTask(task, rangeCache); }
        catch (error) {
          task.issue = messageOf(error);
          task.syncStatus = task.deleting ? 'deleting' : 'attention';
          firstError ||= task.issue;
          if (error.status === 401) this.tokens.clear();
        }
      }
      if (!firstError) {
        await this.extendRunningEvent(rangeCache);
        await this.compactEventReservations(rangeCache);
      }
      this.busy = await this.availability(range);
      this.busyRange = range;
      if (firstError) this.error = firstError;
      else {
        const now = this.clock();
        const observed = observeOverrun(this.data.tasks,now,t => this.eligibleEventOverrun(t));
        observed.forEach((next,i) => { if (next !== this.data.tasks[i]) copyRecord(this.data.tasks[i],next); });
        this.data.lastSync = now.toISOString();
      }
    } catch (error) {
      this.error = messageOf(error);
      this.transientSyncError = error.status >= 500 || error.status === 429 || /quota|rate.?limit|resource_exhausted/i.test(error.reason || '');
      if (this.transientSyncError && error.retryAfterSeconds > 0) this.retrySyncAt = Date.now() + error.retryAfterSeconds * 1000;
      if (error.status === 401) this.tokens.clear();
      if (this.data.settings.calendarMode === 'availability') {
        this.unavailableLocalPlans(this.error);
        return;
      }
      const swapTasks = new Set(this.data.eventMoveGroup?.map(step => step.id));
      for (const task of this.data.tasks) {
        if (!task.pendingEstimate && !(task.done && !task.remote) && (!task.remote || Object.keys(task.dirty).length || task.remote.proposedSlot || swapTasks.has(task.id)) && !task.held) {
          task.syncStatus = task.deleting ? 'deleting' : 'attention';
          task.issue = this.error;
        }
      }
    } finally { this.store.save(); }
  }
}
