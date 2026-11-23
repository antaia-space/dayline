import { DateTime } from 'luxon';
import { explicitStartFor, findSlot, planningRange } from './planner.mjs';

const priorSlot = task => task.start && task.end ? task : task.lastLocalSlot;
const overlaps = (a, b) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
const captured = task => Date.parse(task.estimateRequestedAt || task.createdAt);

export function canMoveLocalTask(task, now) {
  if (task.pendingEstimate || task.done || task.held || task.deleting || task.remote || task.intent) return false;
  return !task.start || Date.parse(task.start) >= now.getTime() || (task.durationCheckPending && Date.parse(task.end) > now.getTime());
}

function sameStart(task, settings, now, busy) {
  const prior = priorSlot(task);
  if (!prior) return null;
  const start = Date.parse(prior.start);
  if (start < now.getTime() && !(task.durationCheckPending && Date.parse(prior.end) > now.getTime())) return null;
  const slot = findSlot({ task, settings, busy, now: new Date(start) });
  return slot && Date.parse(slot.start) === start ? slot : null;
}

export function nextFlexibleSlot(task, settings, now, busy) {
  const prior = priorSlot(task);
  if (prior && Date.parse(prior.start) > now.getTime()) {
    // Prefer a later opening after displacement, without extending the horizon
    // beyond the dates checked for free/busy. An earlier gap can still save a deadline.
    const range = planningRange({ task, settings, now });
    const next = findSlot({ task, settings, busy, now: new Date(prior.start) });
    if (range && next && Date.parse(next.end) <= Date.parse(range.end)) return next;
  }
  return findSlot({ task, settings, busy, now });
}

// Results contain only tasks whose placement may change. Protected history and
// opaque provider appointments remain occupied throughout the entire batch.
export function planTaskSlots({ tasks, settings, now, busy = [], canMove = canMoveLocalTask }) {
  const placements = new Map();
  const reserved = [...busy];
  const exact = [], flexible = [], active = [];
  for (const task of tasks) {
    const movable = canMove(task, now);
    const ongoing = task.start && Date.parse(task.start) < now.getTime() && Date.parse(task.end) > now.getTime();
    const potentiallyPreemptible = ongoing && canMove(task, new Date(task.start));
    const clock = (movable || potentiallyPreemptible) && explicitStartFor(task, settings.timeZone);
    if (potentiallyPreemptible && !clock) active.push(task);
    else if (movable) (clock ? exact : flexible).push(task);
    else if (task.start && task.end && !task.deleting && (!task.pendingEstimate || task.estimateJob?.protected)) reserved.push(task);
  }

  function place(task, slot) {
    placements.set(task.id, slot);
    if (slot) reserved.push(slot);
  }

  // The currently booked appointment wins a tie. For two unbooked requests,
  // their capture order is stable even if their estimates finished much later.
  exact.sort((a, b) => Number(Boolean(b.start)) - Number(Boolean(a.start)) || captured(a) - captured(b));
  const waiting = [], displaced = new Set();
  function exactBusy(task) {
    const request = captured(task);
    return [...reserved, ...active.filter(other => !displaced.has(other) && (!Number.isFinite(request) || Date.parse(other.start) < request))];
  }
  function bookExact(task, slot) {
    place(task, slot);
    if (slot) for (const other of active) if (overlaps(slot, other)) displaced.add(other);
  }
  for (const task of exact) {
    const slot = sameStart(task, settings, now, exactBusy(task));
    if (slot) bookExact(task, slot);
    else waiting.push(task);
  }
  waiting.sort((a, b) => captured(a) - captured(b));
  for (const task of waiting) {
    bookExact(task, findSlot({ task, settings, now, busy: exactBusy(task), allowInProgress: true }));
  }

  for (const task of active) {
    if (displaced.has(task) || canMove(task, now)) flexible.push(task);
    else reserved.push(task);
  }
  const unplaced = [];
  for (const task of flexible) {
    const slot = sameStart(task, settings, now, reserved);
    if (slot) place(task, slot);
    else unplaced.push(task);
  }
  for (const task of unplaced) place(task, nextFlexibleSlot(task, settings, now, reserved));
  return placements;
}

export function explicitSchedulingIssue({ task, tasks, settings, now, busy, placements }) {
  const clock = explicitStartFor(task, settings.timeZone);
  if (!clock) return null;
  const request = { task, settings, now, allowInProgress: true };
  if (!findSlot(request)) {
    const today = DateTime.fromJSDate(now, { zone: settings.timeZone }).startOf('day');
    const day = task.latestDay && task.latestDay < today.toISODate() ? DateTime.fromISO(task.latestDay, { zone: settings.timeZone }).startOf('day') : today;
    const earlier = findSlot({ task, settings, now: day.toJSDate() });
    if (earlier && Date.parse(earlier.start) < now.getTime()) return 'The requested ' + clock + ' start has passed. Choose another time or day.';
    return 'The full task at ' + clock + ' does not fit its time window, working days, or working hours. Change the time, day, duration, or working hours.';
  }
  if (busy.length && !findSlot({ ...request, busy })) return 'Google Calendar is busy at the requested ' + clock + ' start. Change the time or day, or move the calendar commitment.';
  const appointments = tasks.filter(t => t.id !== task.id && explicitStartFor(t, settings.timeZone))
    .map(t => placements.has(t.id) ? placements.get(t.id) : t).filter(t => t?.start && t.end);
  if (appointments.length && !findSlot({ ...request, busy: [...busy, ...appointments] })) {
    return 'Another fixed-time task overlaps the requested ' + clock + ' start. Change one appointment’s time or day.';
  }
  return 'A reserved or already-started task overlaps the requested ' + clock + ' start. Change the time or day.';
}
