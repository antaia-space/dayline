import { DateTime } from 'luxon';
import { explicitStartFor, findSlot } from './planner.mjs';

const minute = 60_000;
const increment = 5 * minute;
const personal = task => !task.remote && !task.intent;
const open = task => !task.done && !task.deleting && !task.held && !task.pendingEstimate && !task.estimateJob &&
  !task.remote?.allDay && !task.remote?.manualTime && !task.remote?.calendarAppointment && task.start && task.end;
const intersects = (start, end, interval) => start < Date.parse(interval.end) && Date.parse(interval.start) < end;

// A watch is evidence that this exact reservation was running. Store it with
// the task so that a quick restart at the handoff cannot select its successor.
export function observeOverrun(tasks, now, canExtend = personal) {
  const current = now.getTime();
  const active = tasks.filter(task => open(task) && canExtend(task) && Date.parse(task.start) <= current && current < Date.parse(task.end));
  const watched = active.find(t => t.overrunWatchStart === t.start) || active[0];
  return tasks.map(task => {
    if (task === watched) return task.overrunWatchStart === task.start ? task : { ...task, overrunWatchStart: task.start };
    if (!Object.hasOwn(task, 'overrunWatchStart')) return task;
    const next = { ...task };
    delete next.overrunWatchStart;
    return next;
  });
}

function neighbors(task, tasks, settings, busy, end, wanted, canYield) {
  const start = Date.parse(task.start), zone = settings.timeZone;
  const flexible = [], protectedTimes = [...busy];
  for (const other of tasks) {
    if (other === task || other.deleting || (other.pendingEstimate && !other.estimateJob?.protected)) continue;
    if (other.start && other.end) {
      if (!intersects(start, wanted, other)) continue;
      if (open(other) && canYield(other) && Date.parse(other.start) >= end && !explicitStartFor(other, zone)) flexible.push(other);
      else protectedTimes.push(other);
    } else if (!other.done && !other.held && !other.pendingEstimate && explicitStartFor(other, zone)) {
      const requested = findSlot({ task: other, settings, now: new Date(start), busy: [] });
      if (requested && intersects(start, wanted, requested)) protectedTimes.push(requested);
    }
  }
  return { flexible, protectedTimes };
}

// A newly booked commitment can take back the extra minutes while a task is
// still running. Keep its original work and release only the granted extension.
export function capOverrun({ task, tasks, settings, now, busy = [], canExtend = personal, canYield = personal }) {
  if (!open(task) || !canExtend(task) || !task.overrunMinutes || Date.parse(task.end) <= now.getTime()) return null;
  const end = Date.parse(task.end), base = end - task.overrunMinutes * minute;
  const { protectedTimes } = neighbors(task, tasks, settings, busy, base, end, canYield);
  let until = end;
  for (const block of protectedTimes) {
    const beginning = Date.parse(block.start);
    if (beginning >= base && beginning < until) until = Math.floor(beginning / minute) * minute;
  }
  return until < end ? { task, start: task.start, end: new Date(until).toISOString(), overrunMinutes: (until - base) / minute, displaced: [] } : null;
}

export function proposeOverrun({ tasks, settings, now, busy = [], canExtend = personal, canYield = personal }) {
  const current = now.getTime();
  const task = tasks.find(t => open(t) && canExtend(t) && t.overrunWatchStart === t.start &&
    Date.parse(t.end) <= current && current - Date.parse(t.end) < 2 * increment);
  if (!task) return null;
  const start = Date.parse(task.start), end = Date.parse(task.end);
  const zone = settings.timeZone;
  if (!DateTime.fromMillis(start, { zone }).hasSame(DateTime.fromMillis(current, { zone }), 'day')) return null;
  // Recover a missed short timer tick, never a long sleep or an older day.
  const steps = Math.floor((current - end) / increment) + 1;
  const wanted = end + steps * increment;
  const { flexible, protectedTimes } = neighbors(task, tasks, settings, busy, end, wanted, canYield);
  // Test the whole reservation against working hours, written windows and
  // actual calendar commitments. An intervening appointment caps this step.
  for (let until = wanted; until > end; until -= minute) {
    const minutes = (until - start) / minute;
    if (!Number.isInteger(minutes)) return null;
    const possible = findSlot({ task: { ...task, minutes }, settings, now: new Date(start), busy: protectedTimes });
    if (possible && Date.parse(possible.start) === start && Date.parse(possible.end) === until) {
      return { task, start: task.start, end: possible.end,
        overrunMinutes: (task.overrunMinutes || 0) + (until - end) / minute,
        displaced: flexible.filter(other => intersects(end, until, other)) };
    }
  }
  return null;
}
