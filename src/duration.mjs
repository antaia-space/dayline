import { findSlot, resizedClockWindow } from './planner.mjs';
import { recordDurationFeedback } from './task-learning.mjs';

export function setManualDuration(changed, minutes, timeZone) {
  if (!Number.isSafeInteger(minutes) || minutes < 1) throw new RangeError('Enter a positive whole number of minutes.');
  changed.estimateOverrides ||= {};
  changed.estimateOverrides.minutes = minutes;
  if (changed.minutes === minutes) return;
  // Older tasks only stored the displayed duration. Keep that reference across
  // repeated clicks, so undoing a change also undoes its contribution to the note.
  changed.baseMinutes ??= changed.minutes;
  changed.estimatedMinutes ??= changed.minutes;
  if (!changed.done && !changed.remote?.allDay) {
    changed.windowEnd = resizedClockWindow(changed, minutes, timeZone);
    changed.dirty.schedule = true;
  }
  changed.minutes = minutes;
  changed.reason = 'Duration set by you.';
}

// A fast local preview keeps the stepper on a valid block while Google refreshes.
// The service confirms the placement against live calendars after the last click.
export function previewAdjustedSlot(service, before, after) {
  const { accounts, settings } = service.data;
  const connected = accounts.length > 0;
  const coverage = service.busyRange;
  if (connected && (service.error || !coverage)) return null;
  const busy = service.localBusy(before.id);
  if (connected) busy.push(...service.busy);
  const checked = slot => slot && (!connected || (Date.parse(slot.start) >= Date.parse(coverage.start)
    && Date.parse(slot.end) <= Date.parse(coverage.end)));
  const now = service.clock();
  const prior = before.start ? before : before.lastLocalSlot;
  if (prior && Math.max(Date.parse(prior.end), Date.parse(prior.start) + after.minutes * 60_000) >= now.getTime()) {
    const same = findSlot({ task: after, settings, busy, now: new Date(prior.start) });
    if (checked(same) && Date.parse(same.start) === Date.parse(prior.start)) return same;
  }
  const next = findSlot({ task: after, settings, busy, now });
  return checked(next) ? next : null;
}

export function adjustTaskDuration(service, task, input, overrides) {
  if (!input || ![5, -5].includes(input.delta) ||
      typeof input.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(input.requestId)) {
    throw new RangeError('Send a five-minute change with a valid request ID.');
  }
  const applied = task.durationRequests?.[input.requestId];
  if (applied !== undefined) {
    if (applied !== input.delta) throw new RangeError('This request ID belongs to a different duration change.');
    return { id: task.id, minutes: task.minutes };
  }
  if (task.pendingEstimate || task.deleting) {
    throw Object.assign(new Error('Adjust the duration after the estimate is ready and the task is open for editing.'), { status: 409 });
  }
  const changed = structuredClone(task);
  changed.estimateOverrides = overrides;
  setManualDuration(changed, task.minutes + input.delta, service.data.settings.timeZone);
  changed.durationRequests ||= {};
  changed.durationRequests[input.requestId] = input.delta;
  const previousLearning = service.data.durationLearning;
  recordDurationFeedback(service.data, task, changed);
  try { service.saveEdit(task, changed, { durationOnly: true }); }
  catch (error) {
    service.data.durationLearning = previousLearning;
    throw error;
  }
  return { id: task.id, minutes: task.minutes };
}
