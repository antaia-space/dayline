import { DateTime } from 'luxon';

function localDay(instant, timeZone) {
  return instant ? DateTime.fromISO(instant, { zone: timeZone }).toISODate() : null;
}

// Completion keeps its list date and releases any unworked part of the block.
// Older records have no reliable check-off timestamp; do not invent one.
export function releaseCompletedTime(task, now, timeZone) {
  if (!task.done) return false;
  const day = task.completedDay || localDay(task.start || task.lastLocalSlot?.start, timeZone) ||
    task.estimateOverrides?.day || (task.earliestDay === task.latestDay && task.earliestDay) ||
    localDay(task.completedAt || task.createdAt, timeZone);
  let changed = false;
  if (day && task.completedDay !== day) { task.completedDay = day; changed = true; }
  const start = Date.parse(task.start), end = Date.parse(task.end);
  const known = Date.parse(task.completedAt);
  const cutoff = Number.isFinite(known) ? Math.min(known, now.getTime()) : now.getTime();
  const former = task.start && task.end ? task : task.lastLocalSlot;
  if (!task.completedPlannedSlot && former && Date.parse(former.start) >= cutoff && Date.parse(former.end) > Date.parse(former.start)) {
    // This is a display anchor for the checked item, separate from its actual occupied time.
    task.completedPlannedSlot = { start: former.start, end: former.end };
    changed = true;
  }
  if (Number.isFinite(start) && Number.isFinite(end) && cutoff < end) {
    // An early all-day check-off has a date but no clocked work interval.
    if (cutoff <= start || !Number.isFinite(known) || task.remote?.allDay || task.pausedSync?.remote?.allDay) task.start = task.end = null;
    else task.end = new Date(cutoff).toISOString();
    if (task.overrunMinutes) {
      const elapsed = task.end ? Math.max(0, Math.ceil((cutoff - (end - task.overrunMinutes * 60_000)) / 60_000)) : 0;
      if (elapsed) task.overrunMinutes = elapsed;
      else delete task.overrunMinutes;
    }
    changed = true;
  }
  for (const key of ['lastLocalSlot', 'durationCheckPending', 'overrunWatchStart']) {
    if (Object.hasOwn(task, key)) { delete task[key]; changed = true; }
  }
  return changed;
}

export function reopenCompletedTask(task, now) {
  delete task.completedDay;
  delete task.completedAt;
  delete task.completedPlannedSlot;
  delete task.lastLocalSlot;
  delete task.durationCheckPending;
  delete task.overrunWatchStart;
  delete task.overrunMinutes;
  task.start = task.end = null;
  task.reopenedAt = now.toISOString();
}
