import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { CATEGORIES, explicitStartFor } from './planner.mjs';
import { protectedCommandAppointment } from './planner-command-service.mjs';
import { localTaskTitle } from './task-learning.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value, { zone:'UTC' }).isValid;
export const label = task => task.title || localTaskTitle(task.text) || 'Untitled task';

export function requestText(body) {
  if (!validId(body?.requestId) || typeof body.text !== 'string' || !body.text.trim() || body.text.trim().length > 1000) {
    throw Object.assign(new Error('Enter a planner request with a valid capture ID.'), { status:400 });
  }
  return body.text.trim();
}

// Always derive provider input from a small allowlist. Notes may help find a
// named cross-day task locally, but the provider never receives those notes.
function sharedLabel(value) {
  return String(value || '').replace(/https?:\/\/\S+|\bwww\.\S+/giu, '[link]')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/gu, '[email]').replace(/\b[\da-f]{32}\b/gi,'[identifier]')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 160);
}

const stop = new Set(('a an the of for from to in on at with and or but by as into before after my our me i be has have ' +
  'could would can please this that it its these those then first last all any every each both next current ' +
  'move set make mark check give add remove delete take change put split break turn call rename instead ' +
  'task tasks step steps subtasks subtask checklist time day week today tomorrow yesterday morning afternoon evening ' +
  'monday tuesday wednesday thursday friday saturday sunday minute minutes hour hours more less done open completed').split(' '));
function words(text) {
  return [...new Set((text.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(word => word.length > 1 && !stop.has(word) && !/^\d+$/.test(word))
    .map(word => word.length > 4 && /[^siu]s$/.test(word) ? word.slice(0,-1) : word))];
}
const groupWords = /\b(?:all|every|each|both|everything|anything|whatever|remaining|unfinished|unscheduled|overdue)\b(?!\s+(?:(?:the|of|its|my|these|those)\s+)*(?:subtasks?|steps?|checkboxes?|checklist)\b)/i;
const unnamedGroup = /\b(?:all|every|each|both|remaining|unfinished|unscheduled|overdue)\s+(?:(?:of|those|these|my|our|the|open|unfinished|remaining)\s+)*(?:tasks?|to-?dos?|items?|work)\b|\b(?:everything|anything|whatever)\b/i;
const calendarScope = /\b(?:my|this|that|the) (?:morning|afternoon|evening|schedule|workday|workload|agenda)|\b(?:rebalance|triage|reorganize|reorganise|rearrange|spread out|batch)\s+(?:(?:the|my|remaining|open)\s+)*(?:tasks|work|things)\b/i;
const pointed = /\b(?:this|that|the selected|the visible|the current) (?:task|item|to-?do)\b/i;
const ranked = /\b(?:the|my|today['’]s|tomorrow['’]s)\s+(first|last|earliest|latest|shortest|longest|quickest)\s+(?:(?:remaining|open|scheduled|unfinished)\s+)*(?:task|item|to-?do)\b/i;
const ignoredTopics = new Set('review prepare create design send write produce update discuss draft file organize process make research read build plan analyze edit work'.split(' '));
const topic = word => ['slides','slide','deck','presentation','slideshow'].includes(word) ? 'presentation' : word;

function orderGroup(task, zone) {
  return task.start ? DateTime.fromISO(task.start,{zone}).toISODate() : 'unscheduled';
}

function mentionedDay(day, text, today) {
  if (!day) return /\b(?:unscheduled|backlog)\b/i.test(text);
  const date = DateTime.fromISO(day, { zone:today.zoneName });
  if (!date.isValid) return false;
  if (text.includes(day) || new RegExp('\\b' + date.setLocale('en').toFormat('cccc') + '\\b', 'i').test(text)) return true;
  if ((day === today.toISODate() && /\btoday\b/i.test(text)) || (day === today.plus({days:1}).toISODate() && /\btomorrow\b/i.test(text))) return true;
  const first = /\bnext week\b/i.test(text) ? today.plus({ weeks:1 }).startOf('week') : /\bthis week\b/i.test(text) ? today.startOf('week') : null;
  return Boolean(first && day >= first.toISODate() && day < first.plus({ weeks:1 }).toISODate());
}

export function dayOf(task, zone) {
  return task.completedDay || (task.start && DateTime.fromISO(task.start, { zone }).toISODate()) ||
    task.estimateOverrides?.day || task.estimateOverrides?.viewDay || (task.earliestDay === task.latestDay && task.earliestDay) || null;
}

export function taskVersion(task) {
  const linked = task.remote || task.pausedSync?.remote;
  return digest([task.id, task.title, task.text, task.category, task.done, task.start, task.end, task.minutes, task.earliestDay, task.latestDay,
    task.windowStart, task.windowEnd, task.deadlineTime, task.estimateOverrides, task.calendarFit, task.calendarProgressMinutes,
    task.overrunMinutes, task.pendingEstimate, task.estimateJob?.text, task.estimateJob?.id, task.held, task.deleting, task.intent?.eventId,
    task.pausedSync?.intent?.eventId, linked && [linked.sub,linked.calendarId,linked.eventId,linked.etag,linked.allDay,linked.manualTime,linked.calendarAppointment],
    (task.subtasks || []).map(step => [step.id,step.title,step.done])]);
}

export function createPlanContext(service, body) {
  const text = requestText(body), { at, timeZone:captureZone } = service.captureContext(body);
  const { settings } = service.data, zone = settings.timeZone;
  const today = DateTime.fromISO(at, { zone:captureZone }).startOf('day');
  const viewDay = body.contextDay ?? body.viewDay ?? today.toISODate();
  if (!validDay(viewDay)) throw Object.assign(new Error('Choose a valid visible day.'), {status:400});
  const requested = new Set(words(text).map(topic)), rank = text.match(ranked)?.[1]?.toLowerCase();
  const broad = unnamedGroup.test(text) || calendarScope.test(text);
  const group = groupWords.test(text) || broad || Boolean(rank);
  const global = /\b(?:all|every|each)\s+(?:(?:of|my|our|the|open|unfinished|remaining)\s+)*(?:tasks?|to-?dos?|items?)\b/i.test(text) &&
    !/\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|morning|afternoon|evening)\b/i.test(text);
  const completed = /\b(?:completed?|done|finished|checked|reopen|undo)\b/i.test(text);
  const rows = [];
  for (const task of service.data.tasks) {
    if (task.deleting || protectedCommandAppointment(task)) continue;
    const title = label(task), day = dayOf(task, zone), visible = day === viewDay;
    const parent = new Set(words([title, task.text, task.estimateJob?.text, task.category].filter(Boolean).join(' ')).map(topic));
    const children = task.subtasks || [];
    const all = new Set([...parent, ...children.flatMap(step => words(step.title || step.text || '').map(topic))]);
    const evidence = [...requested].filter(word => all.has(word)).sort();
    const inScope = visible || mentionedDay(day, text, today) || (global && !task.done);
    if ((!visible && !inScope && !evidence.length) || (task.done && !completed && !evidence.length)) continue;
    const score = evidence.reduce((n, word) => n + (parent.has(word) ? 2 : 1), 0);
    rows.push({ task, title, day, visible, inScope, evidence, score });
  }
  rows.sort((a,b) => b.score - a.score || Number(b.visible) - Number(a.visible));
  const tasks = [], targets = {};
  let childLimit = 120;
  for (const [index,row] of rows.slice(0,24).entries()) {
    const { task, title, day, visible, inScope, evidence } = row;
    const alias = 't' + (index + 1), children = task.subtasks || [];
    const picked = children.map((step,i) => ({step,i,match:words(step.title || step.text || '').some(word => requested.has(topic(word)))}))
      .sort((a,b) => Number(b.match) - Number(a.match)).slice(0,Math.min(childLimit,16)).sort((a,b) => a.i - b.i);
    childLimit -= picked.length;
    const subtasks = picked.map(({step}, i) => ({alias:alias + '.s' + (i + 1),title:sharedLabel(step.title || step.text),done:Boolean(step.done)}));
    const time = task.start ? DateTime.fromISO(task.start, {zone}).toFormat('HH:mm') : explicitStartFor(task, zone);
    const subtasksByAlias = Object.fromEntries(subtasks.map((step,i) => [step.alias,picked[i].step.id]));
    tasks.push({alias, title:sharedLabel(title), day, time, minutes:task.pendingEstimate ? null : task.minutes, category:CATEGORIES.find(c => c.id === task.category)?.id || null,
      done:Boolean(task.done), fixed:Boolean(explicitStartFor(task,zone)), protected:Boolean(task.held || task.intent || task.pausedSync?.intent),
      canReorder:service.canReorderTask(task,service.clock()), subtasks,
      ...(children.length > subtasks.length && {omittedSubtasks:children.length - subtasks.length})});
    targets[alias] = {id:task.id, version:taskVersion(task), label:title, evidence, visible, inScope, done:Boolean(task.done),
      topics:words(title).filter(word => !ignoredTopics.has(word)).map(topic),
      minutes:task.pendingEstimate ? null : task.minutes, start:task.start || null, orderGroup:orderGroup(task,zone), subtasks:subtasksByAlias};
  }
  const { workDays,startTime,endTime } = settings;
  const groups = new Map(), now = service.clock();
  for (const task of service.data.tasks) if (service.canReorderTask(task,now)) {
    const group = orderGroup(task,zone);
    if (!groups.has(group)) groups.set(group,[]);
    groups.get(group).push(task.id);
  }
  const orderByGroup = Object.fromEntries([...groups].map(([group,ids]) => [group,digest(ids)]));
  const bindings = {requestId:body.requestId, text, at, captureZone, viewDay, group, broad, rank, pointed:pointed.test(text), targets, orderByGroup,
    visibleCount:rows.filter(r => r.visible && !r.task.done).length,
    scope:digest(rows.filter(r => r.inScope).map(r => r.task.id).sort()),
    settings:digest([settings,service.data.accounts.map(a => [a.sub,a.mode])]),
    omitted:rows.length - tasks.length};
  return {modelContext:{today:today.toISODate(),viewDay,timeZone:zone,workDays:[...workDays],startTime,endTime,tasks,omittedTasks:bindings.omitted},bindings};
}
