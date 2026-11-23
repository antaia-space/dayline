import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { fullTaskMinutes } from './calendar-fit.mjs';
import { protectedCommandAppointment } from './planner-command-service.mjs';

const requestKey = /^[a-f0-9]{32}$/;
const fail = (message,status=409) => { throw Object.assign(new Error(message),{status}); };
const sameOccurrence = (a,b) => Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end);

function elapsed(task,now) {
  const start = Date.parse(task.start), end = Date.parse(task.end);
  return Number.isFinite(start) && end > start && end <= now.getTime();
}

export function movedFromCurrentSlot(task) {
  return Boolean(task.start && task.end && task.movedSlots?.some(slot => sameOccurrence(slot,task)));
}

export function canMoveLater(task,now) {
  return elapsed(task,now) && !task.done && !task.deleting && !task.held && !task.pendingEstimate && !task.estimateJob &&
    !task.intent && !task.pausedSync?.intent && !task.allDay && !protectedCommandAppointment(task) &&
    !(task.remote && (task.dirty?.schedule || task.remote.proposedSlot)) && !movedFromCurrentSlot(task);
}

export function publicMovedSlot({id,start,end,day,toDay,movedAt,timeZone}) {
  return {id,start,end,day,toDay,movedAt,timeZone};
}

// The picker sends the precise occurrence it was displaying. A lost reply
// must still succeed after that same task has been moved a second time.
export function checkMoveLater(task,input,now,settings) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Choose the task and its new date.',400);
  const {day,requestId,sourceStart,sourceEnd} = input;
  if (Object.keys(input).some(key => !['day','requestId','sourceStart','sourceEnd'].includes(key)) ||
      typeof requestId !== 'string' || !requestKey.test(requestId) || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !DateTime.fromISO(day,{zone:settings.timeZone}).isValid || ![sourceStart,sourceEnd].every(instant =>
        typeof instant === 'string' && /T.+(?:Z|[+-]\d\d:\d\d)$/i.test(instant) && Number.isFinite(Date.parse(instant))) ||
      Date.parse(sourceStart) >= Date.parse(sourceEnd)) {
    fail('Choose a valid later day for the time shown on this task.',400);
  }
  const original = {start:sourceStart,end:sourceEnd};
  const saved = task.movedSlots?.find(slot => slot.requestId === requestId);
  if (saved) {
    if (saved.toDay !== day || !sameOccurrence(saved,original)) fail('This request has already been used for a different move.');
    return publicMovedSlot(saved);
  }
  if (!sameOccurrence(task,original) || !canMoveLater(task,now)) {
    fail('This task or its scheduled time changed. Open the current task to move it.');
  }
  const sourceDay = DateTime.fromISO(task.start,{zone:settings.timeZone}).toISODate();
  if (day <= sourceDay) fail('Choose a day after the original scheduled day.',400);
  if (day < DateTime.fromJSDate(now,{zone:settings.timeZone}).toISODate()) fail('Choose today or a future date.',400);
  return null;
}

// Run only for an explicit day change on the edited clone. This metadata is
// never inserted into the scheduler, free/busy, or the Google event payload.
export function recordElapsedMove(before,changed,day,now,settings,requestId) {
  if (!day || changed.done || !canMoveLater(before,now)) return null;
  const zone = settings.timeZone, sourceDay = DateTime.fromISO(before.start,{zone}).toISODate();
  const today = DateTime.fromJSDate(now,{zone}).toISODate();
  if (day <= sourceDay || day < today) return null;
  if (changed.calendarFit) {
    changed.minutes = fullTaskMinutes(changed);
    delete changed.calendarFit;
  }
  const {start,end} = before;
  const id = createHash('sha256').update(JSON.stringify([before.id,Date.parse(start),Date.parse(end)])).digest('hex').slice(0,32);
  const record = {id,start,end,day:sourceDay,toDay:day,movedAt:now.toISOString(),timeZone:zone,...(requestId && {requestId})};
  changed.movedSlots = [...(before.movedSlots || []),record];
  changed.commandMovedAt = record.movedAt;
  changed.dirty ||= {};
  changed.dirty.schedule = true;
  if (changed.remote || changed.pausedSync?.remote) changed.commandEventPending = true;
  if (!changed.remote) changed.start = changed.end = null;
  for (const key of ['overrunMinutes','overrunWatchStart','lastLocalSlot','durationCheckPending']) delete changed[key];
  return record;
}
