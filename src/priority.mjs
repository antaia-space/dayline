import { DateTime } from 'luxon';
import { createSlotSearch, explicitStartFor, findSlot } from './planner.mjs';
import { canFitDuration, fullTaskMinutes, shorterDurations } from './calendar-fit.mjs';

const priorSlot = task => task.start && task.end ? task : task.lastLocalSlot;
const overlaps = (a, b) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
const captured = task => Math.max(Date.parse(task.estimateRequestedAt || task.createdAt), Date.parse(task.reopenedAt) || 0);

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
  return findSlot({ task, settings, busy, now });
}

function catchUpSlot(task, settings, now, busy, { before = now.getTime(), search = findSlot, startOfDay } = {}) {
  const capturedAt = captured(task);
  if (!Number.isFinite(capturedAt)) return null;
  const floor = Math.max(capturedAt, Date.parse(task.orderRequestedAt) || 0, Date.parse(task.calendarInterruptedAt) || 0);
  startOfDay ??= DateTime.fromJSDate(now, { zone: settings.timeZone }).startOf('day').toMillis();
  const limit = now.getTime() - task.minutes * 60_000;
  // A checked preceding appointment is the evidence for a missed handoff.
  // Capture time or a rounding grid alone cannot create historical work.
  const ends = new Set();
  for (const block of busy) {
    const end = Date.parse(block.end);
    if (end >= floor && end >= startOfDay && end > limit && end < before) ends.add(end);
  }
  for (const end of [...ends].sort((a, b) => a - b)) {
    const slot = search({ task, settings, now: new Date(end), busy });
    if (slot && Date.parse(slot.start) === end && Date.parse(slot.end) > now.getTime()) return slot;
  }
  return null;
}

// Tasks are in user priority order. This also serves the Google event writer,
// which supplies verified availability for each destination and never backdates.
export function planFlexibleSlots({ tasks, settings, now, reserved = [], externalFor = () => [], allowCatchUp = false }) {
  const search = createSlotSearch(settings);
  const catchUp = allowCatchUp && { search, startOfDay: DateTime.fromJSDate(now, { zone: settings.timeZone }).startOf('day').toMillis() };
  const external = new Map(tasks.map(task => [task.id, externalFor(task)]));
  const originals = new Map(tasks.map(task => [task.id, fullTaskMinutes(task)]));
  const withMeetings = new Map(), withoutMeetings = new Map();
  function pack(sizes, includeExternal) {
    const taken = [...reserved];
    const slots = new Map();
    // Duration trials share their unchanged schedule prefix. Later tasks whose
    // first-fit inputs are identical need no additional calendar search.
    let prefix = includeExternal ? withMeetings : withoutMeetings;
    for (const task of tasks) {
      const minutes = sizes.get(task.id);
      const key = task.id + '/' + minutes;
      if (!prefix.has(key)) {
        const request = minutes === task.minutes ? task : { ...task, minutes };
        const busy = includeExternal ? [...taken, ...external.get(task.id)] : taken;
        const slot = (catchUp && catchUpSlot(request, settings, now, busy, catchUp)) || search({ task: request, now, busy });
        prefix.set(key, { slot: slot && { ...slot, minutes }, next: slot && new Map() });
      }
      const { slot, next } = prefix.get(key);
      slots.set(task.id, slot);
      if (slot) { taken.push(slot); prefix = next; }
    }
    return slots;
  }
  let sizes = originals;
  let slots = pack(sizes, true);
  if (!tasks.some(t => external.get(t.id).length && canFitDuration(t, settings.timeZone))) return slots;

  // Compare against the full-length day the task would naturally occupy if
  // Google had no meetings. Local workload alone never shortens an estimate.
  const ideal = pack(originals, false);
  const localDates = new Map();
  function localDay(slot) {
    if (!slot) return null;
    if (!localDates.has(slot.start)) localDates.set(slot.start, DateTime.fromISO(slot.start, { zone: settings.timeZone }).toISODate());
    return localDates.get(slot.start);
  }
  const today = DateTime.fromJSDate(now, { zone: settings.timeZone }).toISODate();
  const goals = new Map();
  for (const task of tasks) {
    const previous = priorSlot(task);
    const previousDay = previous && localDay(previous);
    const writtenDay = task.earliestDay === task.latestDay && task.earliestDay;
    const day = writtenDay || localDay(ideal.get(task.id)) || previousDay;
    if (day && day >= today) goals.set(task.id, day);
  }
  const met = (task, placements) => placements.get(task.id) && localDay(placements.get(task.id)) <= goals.get(task.id);
  const count = placements => tasks.reduce((total, task) => total + Number(Boolean(met(task, placements))), 0);
  function earlierInOrder(a, b) {
    for (const { id } of tasks) {
      const first = a.get(id)?.start, second = b.get(id)?.start;
      if (first !== second) return Boolean(first && (!second || first < second));
    }
    return false;
  }
  let score = count(slots);
  const zone = settings.timeZone;
  const goalDays = [...new Set(goals.values())].sort();
  for (const day of goalDays) {
    if (!tasks.some(task => goals.get(task.id) === day && !met(task, slots))) continue;
    const lostTime = tasks.some(task => {
      const original = ideal.get(task.id) || priorSlot(task);
      return original && localDay(original) === day && external.get(task.id).some(block => overlaps(original, block));
    });
    if (!lostTime) continue;
    const work = { start: DateTime.fromISO(day + 'T' + settings.startTime, { zone }).toUTC().toISO(),
      end: DateTime.fromISO(day + 'T' + settings.endTime, { zone }).toUTC().toISO() };
    const candidates = tasks.filter(task => (goals.get(task.id) === day || localDay(slots.get(task.id)) === day)
      && canFitDuration(task, zone) && external.get(task.id).some(block => overlaps(work, block)) && shorterDurations(task).length);
    if (!candidates.length) continue;
    let best = null;
    // Try the group for cumulative shortages and each individual task for a
    // short opening. Restore every minute that does not cost a same-day task.
    const groups = candidates.length === 1 ? [candidates] : [candidates, [...candidates].reverse(), ...candidates.map(task => [task])];
    for (const group of groups) {
      const trial = new Map(sizes);
      for (const task of group) trial.set(task.id, shorterDurations(task).at(-1));
      let result = pack(trial, true);
      const target = count(result);
      if (target <= score || (best && target < best.score)) continue;
      for (const task of group) {
        const minimum = trial.get(task.id);
        for (let minutes = sizes.get(task.id); minutes > minimum; minutes--) {
          trial.set(task.id, minutes);
          const restored = pack(trial, true);
          if (count(restored) >= target) { result = restored; break; }
          trial.set(task.id, minimum);
        }
      }
      const cost = tasks.reduce((sum, task) => sum + originals.get(task.id) - trial.get(task.id), 0);
      const retained = count(result);
      if (!best || retained > best.score || (retained === best.score && (cost < best.cost ||
          (cost === best.cost && earlierInOrder(result, best.slots))))) {
        best = { sizes: trial, slots: result, score: retained, cost };
      }
    }
    if (best) ({ sizes, slots, score } = best);
  }
  return slots;
}

// Results contain only tasks whose placement may change. Protected history and
// opaque provider appointments remain occupied throughout the entire batch.
export function planTaskSlots({ tasks, settings, now, busy = [], canMove = canMoveLocalTask }) {
  const placements = new Map();
  const remainingWork = new Map();
  const reserved = [];
  const exact = [], active = [];
  const flexible = new Set();
  for (const task of tasks) {
    const movable = canMove(task, now);
    const prior = task.start ? task : task.durationCheckPending && task.lastLocalSlot;
    const ongoing = prior && Date.parse(prior.start) < now.getTime() && Date.parse(prior.end) > now.getTime();
    const potentiallyPreemptible = ongoing && canMove(task, new Date(prior.start));
    const clock = (movable || potentiallyPreemptible) && explicitStartFor(task, settings.timeZone);
    if (potentiallyPreemptible && !clock) active.push(task);
    else if (movable && clock) exact.push(task);
    else if (movable) flexible.add(task);
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
    return [...busy, ...reserved, ...active.filter(other => !displaced.has(other) && (!Number.isFinite(request) || Date.parse(priorSlot(other).start) < request)).map(priorSlot)];
  }
  function bookExact(task, slot) {
    place(task, slot);
    if (slot) for (const other of active) if (overlaps(slot, priorSlot(other))) displaced.add(other);
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

  const progressed = new Map();
  const protecting = new Map(active.filter(task => !displaced.has(task)).map(task => [task.id, priorSlot(task)]));
  for (const task of active) {
    if (displaced.has(task)) { flexible.add(task); continue; }
    const prior = priorSlot(task);
    protecting.delete(task.id);
    const blockers = [...busy, ...reserved, ...protecting.values()];
    const conflicts = busy.filter(block => overlaps(prior, block));
    if (conflicts.length) {
      const committedUntil = Math.min(now.getTime(), ...conflicts.map(block => Date.parse(block.start)));
      const elapsed = Math.max(0, Math.floor((committedUntil - Date.parse(prior.start)) / 60_000));
      // A just-started block keeps its full estimate. For a longer session
      // only elapsed, uninterrupted minutes count as progress.
      const credited = elapsed < 5 || !canFitDuration(task, settings.timeZone) ? 0 : Math.min(elapsed, fullTaskMinutes(task) - 1);
      const remaining = fullTaskMinutes(task) - credited;
      remainingWork.set(task.id, { minutes: remaining, credited });
      progressed.set(task, { ...task, minutes: remaining, calendarFit: null, start: null, end: null,
        lastLocalSlot: prior, calendarInterruptedAt: now.toISOString() });
      flexible.add(task);
    } else if (canMove(task, now)) {
      // A duration edit may retain an already-started block after a fresh check.
      const slot = sameStart(task, settings, now, blockers);
      if (slot) place(task, slot);
      else flexible.add(task);
    } else {
      const earlier = !task.overrunMinutes && catchUpSlot(task, settings, now, blockers, { before: Date.parse(prior.start) });
      if (earlier) place(task, earlier);
      else reserved.push(prior);
    }
  }
  const ordered = tasks.filter(task => flexible.has(task)).map(task => progressed.get(task) || task);
  const planned = planFlexibleSlots({ tasks: ordered, settings, now, reserved, externalFor: () => busy, allowCatchUp: true });
  for (const [id, slot] of planned) placements.set(id, slot);
  return { placements, remainingWork };
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
