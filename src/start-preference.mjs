import { DateTime } from 'luxon';
import { explicitStartFor } from './planner.mjs';

// A request for queue order is independent of a requested date, a time window,
// or a fixed appointment. Only the person's own note establishes this preference.
export const earliestPhrase = '(?:as (?:early|soon)(?: in (?:the |my |that )?(?:workday|day|morning))? as (?:possible|you can|I can)|first thing(?: in the morning)?|a\\.?s\\.?a\\.?p\\.?|(?:the )?(?:earliest (?:available |possible )?(?:slot|time|opening|opportunity)|first available (?:slot|time|opening)))';
const earliest = new RegExp('\\b' + earliestPhrase + '\\b', 'gi');
const negation = /(?:\b(?:not|never|avoid|skip|without|isn['’]t|aren['’]t)|\b(?:no need|don['’]t need|doesn['’]t (?:need|have)|not necessary)\b[^,;.!?]{0,45})\s*(?:necessarily\s+)?$/i;

export function asksForEarliest(text) {
  const words = String(text || '');
  return [...words.matchAll(earliest)].some(match => {
    const before = words.slice(0, match.index);
    if (negation.test(before)) return false;
    if (!/^first thing/i.test(match[0])) return true;
    if (/\b(?:what(?:['’]s| is)?|which|name|describe)\s+(?:the\s+)?$/i.test(before)) return false;
    return !(/\bthe\s+$/i.test(before) && /^\s+(?:on (?:the|my|your) list|that\b|(?:guests?|visitors?|customers?)\b)/i.test(words.slice(match.index + match[0].length)));
  });
}

// A model can infer a genuine contextual restriction (for example, while a
// foreign office is open). The preference alone cannot imply a clock window.
export function onlyFlexibleTiming(text) {
  return asksForEarliest(text) && !/\b(?:after|before|between|during|while|until|opens?|closes?|hours|morning|afternoon|evening|night|noon|midnight|timezone|time zone|deadline)\b|\d:\d{2}|\d\s*[ap]m\b/i.test(text);
}

const dayFor = task => task.estimateOverrides?.day || (task.earliestDay && task.earliestDay === task.latestDay && task.earliestDay);
const sharesDay = (a,b) => !dayFor(a) || !dayFor(b) || dayFor(a) === dayFor(b);
const promoted = task => task.startOrder === 'note' || task.startOrder === 'first';
function flexible(task, zone) {
  const remote = task.remote || task.pausedSync?.remote;
  return !task.done && !task.held && !task.deleting && !task.intent && !task.pausedSync?.intent && !task.calendarAppointment && task.kind !== 'meeting' && task.type !== 'meeting' &&
    !remote?.calendarAppointment && !remote?.manualTime && !remote?.allDay && remote?.owned !== false && !explicitStartFor(task, zone);
}

// Commit the preference once into the same array the drag handle edits. A
// periodic re-sort would silently undo a person's subsequent manual order.
export function putEarlyNote(tasks, subject, zone) {
  const others = tasks.filter(task => task.id !== subject.id);
  const peers = others.filter(task => flexible(task,zone));
  const ordinary = peers.find(task => !promoted(task));
  const prior = peers.findLast(task => promoted(task) && sharesDay(subject,task));
  // A dated Friday call can sit before an ordinary Tuesday task in storage
  // without consuming Tuesday. Keeping early requests together also leaves a
  // later undated ASAP task free to take Tuesday's first opening.
  const index = Math.max(ordinary ? others.indexOf(ordinary) : others.length, prior ? others.indexOf(prior) + 1 : 0);
  return others.toSpliced(index,0,{...subject,startOrder:'note'});
}

export function insertCapture(tasks, task, zone) {
  if (!asksForEarliest(task.text) || !flexible(task,zone)) return [...tasks,task];
  // The worker's estimate can resolve the intended day. Until then this note
  // has no slot and should not reorder the schedule for unrelated days.
  return task.pendingEstimate ? [...tasks,{...task,startOrder:'pending-note'}] : putEarlyNote(tasks,task,zone);
}

export function migrateEarlyNotes(tasks, zone, now) {
  let upgraded = tasks;
  const group = task => task.start ? DateTime.fromISO(task.start,{zone}).toISODate() : dayFor(task) || 'unscheduled';
  for (const [index,task] of tasks.entries()) {
    if (task.startOrder || !asksForEarliest(task.text) || !flexible(task,zone) || (task.start && Date.parse(task.start) <= now.getTime())) continue;
    // A saved drag may have been performed on the other task in the pair.
    const manuallyOrdered = task.orderRequestedAt || tasks.slice(0,index).some(peer => peer.orderRequestedAt && group(task) === group(peer) &&
      (!task.createdAt || Date.parse(peer.orderRequestedAt) >= Date.parse(task.createdAt)));
    if (manuallyOrdered || task.pendingEstimate) {
      upgraded = upgraded.map(item => item.id === task.id ? {...item,startOrder:manuallyOrdered ? 'manual' : 'pending-note'} : item);
    } else upgraded = putEarlyNote(upgraded,task,zone);
  }
  return upgraded;
}
