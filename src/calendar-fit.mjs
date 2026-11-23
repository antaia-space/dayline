import { durationInText, explicitStartFor } from './planner.mjs';

const positiveMinutes = n => Number.isSafeInteger(n) && n > 0;

export function fullTaskMinutes(task) {
  const original = task.calendarFit?.originalMinutes;
  return positiveMinutes(original) ? original : task.minutes;
}

// Fit the time reserved on a calendar. A user's estimate and corrections
// retain their own meaning in the task agent's local duration history.
export function canFitDuration(task, timeZone) {
  if (task.done || task.held || task.deleting || task.pendingEstimate || task.estimateJob ||
      task.remote?.allDay || task.remote?.manualTime || task.remote?.calendarAppointment ||
      task.estimateOverrides?.minutes != null || task.reason === 'Duration set by you.' ||
      !positiveMinutes(fullTaskMinutes(task)) || typeof task.text !== 'string') return false;
  return durationInText(task.text) === null && !explicitStartFor(task, timeZone);
}

export function shorterDurations(task) {
  const original = fullTaskMinutes(task);
  if (!positiveMinutes(original)) return [];
  const savings = Math.min(15, Math.floor(original / 4), Math.max(0, original - 5));
  return Array.from({ length: savings }, (_, index) => original - index - 1);
}
