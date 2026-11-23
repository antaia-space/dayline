import { DateTime } from 'luxon';
import { parsePlannerCommand } from './planner-commands.mjs';
import { CATEGORIES, explicitStartFor, resizedClockWindow } from './planner.mjs';
import { fullTaskMinutes } from './calendar-fit.mjs';
import { recordDurationFeedback } from './task-learning.mjs';

const ID = /^[a-f0-9]{32}$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const titleOf = task => task.title || task.text;
// A model may rephrase a group instruction, but cannot enlarge an individual
// edit into a whole-board move. These phrases explicitly quantify the tasks.
const groupInOriginal = /\b(?:(?:all|every|both|each)\s+(?:(?:of|my|our|the|these|those|unfinished|open|incomplete|remaining|pending|scheduled)\s+)*(?:tasks?|to[ -]?dos?|items?|work)|(?:alle[nrms]?|sämtliche[nrms]?)\s+(?:(?:meine[nrms]?|offenen|unerledigten)\s+)*(?:aufgaben|todos)|(?:tous|toutes)\s+(?:(?:mes|les|nos)\s+)*(?:tâches|todos)|tod[oa]s\s+(?:(?:mis|las|los)\s+)*(?:tareas|pendientes))\b/iu;

function originalText(input) {
  if (typeof input?.text !== 'string' || !input.text.trim() || input.text.trim().length > 1000) {
    throw fail('Enter a task or planner instruction between 1 and 1,000 characters.');
  }
  return input.text.trim();
}

function commandDay(input) {
  // Older agenda captures saved their displayed day as viewDay. The explicit
  // day picker belongs to task scheduling and is never a source-day hint.
  const day = input.contextDay ?? input.viewDay;
  if (day == null || day === '') return undefined;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !DateTime.fromISO(day, { zone:'UTC' }).isValid) {
    throw fail('Choose a valid planner date.');
  }
  return day;
}

// The regular capture endpoint and the command handler share the outbox ID
// namespace. A delayed normal capture cannot turn a completed edit into a task.
export function guardCommandCapture(data, input) {
  const entry = input.requestId && data.plannerCommands?.[input.requestId];
  if (entry && (entry.text !== originalText(input) || ['applied','preview','answer'].includes(entry.receipt.kind) || input.forceCreate !== true)) {
    throw fail('This entry already belongs to a planner instruction.', 409);
  }
}

export function protectedCommandAppointment(task) {
  const linked = task.remote || task.pausedSync?.remote;
  return Boolean(task.calendarAppointment || task.kind === 'meeting' || task.type === 'meeting' || linked?.owned === false ||
    linked?.calendarAppointment || linked?.allDay || linked?.manualTime);
}

function cannotEdit(task, action) {
  if (task.deleting || task.held || task.intent || task.pausedSync?.intent) return 'This task is held or still awaiting calendar confirmation.';
  if (protectedCommandAppointment(task)) return 'This appointment is protected by its calendar. Choose a Dayline task.';
  if (task.done && action !== 'reopen') return 'This task has already been completed.';
  if (!task.done && action === 'reopen') return 'This task is already open.';
  if (task.pendingEstimate && action === 'duration') return 'Wait for this task’s estimate before changing its duration.';
  return null;
}

function revise(service, before, action, changes, learning, now) {
  const changed = structuredClone(before);
  changed.dirty ||= {};
  if (action === 'move') {
    const oldClock = explicitStartFor(before, service.data.settings.timeZone);
    if (!changes.day || (changes.time !== undefined && (typeof changes.time !== 'string' || !CLOCK.test(changes.time)))) {
      throw fail('Choose a valid day and start time for this move.');
    }
    service.applyTaskFields(changed, { day:changes.day });
    if (changes.day !== before.earliestDay || changes.day !== before.latestDay || (changes.time && changes.time !== oldClock)) {
      changed.commandMovedAt = now.toISOString();
      changed.dirty.schedule = true;
      if (changed.calendarFit) {
        changed.minutes = fullTaskMinutes(changed);
        delete changed.calendarFit;
      }
      delete changed.overrunMinutes;
      delete changed.overrunWatchStart;
      delete changed.durationCheckPending;
    }
    if (changes.time) {
      changed.estimateOverrides.time = changes.time;
      changed.windowStart = changes.time;
      changed.windowEnd = Number.isSafeInteger(changed.minutes) ? resizedClockWindow(changed, changed.minutes, service.data.settings.timeZone) : null;
    }
  } else if (action === 'duration') {
    const minutes = changes.minutes ?? (before.minutes + changes.deltaMinutes);
    if (!Number.isSafeInteger(minutes) || minutes < 1) throw fail('The resulting duration must be at least one whole minute.');
    service.applyTaskFields(changed, { minutes });
    if (minutes !== before.minutes) recordDurationFeedback(learning, before, changed);
  } else if (action === 'complete' || action === 'reopen') {
    service.applyTaskFields(changed, { done:action === 'complete' });
  } else if (action === 'rename') {
    service.applyTaskFields(changed, { title:changes.title });
  } else throw fail('This planner instruction is unsupported.');
  if (before.remote || before.pausedSync?.remote) changed.commandEventPending = true;
  service.prepareSavedEdit(before, changed, { durationOnly:action === 'duration',
    ...(action === 'move' && {moveDay:changes.day,moveRequestId:changes.moveRequestId,now}) });
  return changed;
}

function describe(action, changes, tasks, zone, connected, target) {
  const subject = tasks.length === 1 ? '“' + titleOf(tasks[0]) + '”' : tasks.length + ' tasks';
  if (action === 'complete') return 'Completed ' + subject + '.';
  if (action === 'reopen') return 'Reopened ' + subject + '.';
  if (action === 'rename') return 'Renamed the task to ' + subject + '.';
  if (action === 'order') return 'Placed ' + subject + ' ' + changes.placement + ' “' + titleOf(target) + '” in the task order.';
  if (action === 'duration') return tasks.length === 1 ? 'Set ' + subject + ' to ' + tasks[0].minutes + ' minutes.' : 'Updated the duration of ' + subject + '.';
  const day = DateTime.fromISO(changes.day, { zone }).toFormat('ccc, LLL d');
  const when = day + (changes.time ? ' at ' + changes.time : '');
  if (connected) return 'Requested ' + when + ' for ' + subject + '. Dayline will check calendar availability.';
  if (tasks.length === 1 && tasks[0].start) {
    const start = DateTime.fromISO(tasks[0].start, { zone });
    return 'Scheduled ' + subject + ' for ' + start.toFormat('ccc, LLL d') + ' at ' + start.toFormat('HH:mm') + '.';
  }
  const unplaced = tasks.filter(task => !task.start && !task.pendingEstimate);
  if (unplaced.length === 1 && tasks.length === 1) return 'Requested ' + when + ' for ' + subject + '. ' + (unplaced[0].issue || 'The task is waiting for an available work period.');
  if (unplaced.length) return 'Requested ' + when + ' for ' + subject + '. ' + unplaced.length + ' still need an available work period.';
  return 'Set ' + subject + ' for ' + when + '.';
}

function persist(service, item, receipt, tasks, learning) {
  const { data } = service;
  const previous = data.plannerCommands;
  const previousLearning = data.durationLearning;
  data.plannerCommands = { ...previous, [item.id]:{ ...item, receipt } };
  if (learning?.durationLearning !== undefined) data.durationLearning = learning.durationLearning;
  try {
    if (tasks) service.commitTaskList(tasks);
    else service.store.save();
  } catch (error) {
    if (previous === undefined) delete data.plannerCommands;
    else data.plannerCommands = previous;
    if (previousLearning === undefined) delete data.durationLearning;
    else data.durationLearning = previousLearning;
    throw error;
  }
  return structuredClone(receipt);
}

export { revise as revisePlannerTask, cannotEdit as plannerEditIssue, persist as persistPlannerReceipt };

function clarification(service, parsed) {
  const zone = service.data.settings.timeZone;
  const candidates = (parsed.candidates || []).flatMap(({ id }) => {
    const task = service.data.tasks.find(t => t.id === id);
    if (!task) return [];
    const start = task.start ? DateTime.fromISO(task.start, { zone }) : null;
    const day = task.completedDay || start?.toISODate() || task.earliestDay;
    const detail = [start ? start.toFormat('ccc, LLL d · HH:mm') : day ? DateTime.fromISO(day,{ zone }).toFormat('ccc, LLL d') : 'Unscheduled'];
    if (task.done) detail.push('Completed');
    const category = CATEGORIES.find(item => item.id === task.category);
    if (category) detail.push(category.name);
    const title = titleOf(task);
    const note = (task.estimateJob?.text || task.text || '').trim().replace(/\s+/g, ' ');
    if (note && note.toLowerCase() !== title.toLowerCase()) detail.push(note.length > 72 ? note.slice(0, 71).trimEnd() + '…' : note);
    return [{ id, title, detail:detail.join(' · '), ...(day && { day }) }];
  });
  return { kind:parsed.reason === 'syntax' ? 'unparsed' : candidates.length ? 'needs-choice' : 'no-match',
    message:parsed.message, reason:parsed.reason, candidates, taskIds:[],
    ...(parsed.choiceRole && { choiceRole:parsed.choiceRole }), ...(parsed.counterpartId && { counterpartId:parsed.counterpartId }) };
}

export function settlePlannerClarification(service, input, message, { kind = 'clarification', reason = 'syntax', agent } = {}) {
  const text = originalText(input), { requestId } = input;
  if (typeof requestId !== 'string' || !ID.test(requestId)) throw fail('Invalid planner request identifier.');
  const saved = service.data.plannerCommands?.[requestId];
  if (saved && saved.text !== text) throw fail('This request identifier belongs to a different planner instruction.', 409);
  const canReinterpret = reason === 'agent' && ['no-match','clarification'].includes(saved?.receipt.kind) && saved.receipt.reason !== 'agent';
  if (saved && saved.receipt.kind !== 'unparsed' && !canReinterpret) return structuredClone(saved.receipt);
  if (service.data.tasks.some(task => task.id === requestId) || service.data.deletedTaskIds?.includes(requestId)) return { kind:'create', id:requestId };
  const details = saved || { id:requestId, text, ...service.captureContext(input) };
  const request = { id:requestId, text, at:details.at, timeZone:details.timeZone };
  if (details.interpretedText) request.interpretedText = details.interpretedText;
  const day = details.contextDay ?? commandDay(input);
  if (day) request.contextDay = day;
  if (details.matchRetryIds) request.matchRetryIds = details.matchRetryIds;
  const summary = typeof message === 'string' && message.trim() ? message.trim().slice(0, kind === 'answer' ? 1500 : 500) : 'Name the task and the change you want.';
  return persist(service, request, { kind, reason, message:summary, taskIds:[], ...(agent && {agent}) });
}

// Called on the service's serialized write queue. Only the server supplies an
// interpretedText. The renderer can submit original wording and one offered ID.
export function executePlannerCommand(service, input, { interpretedText } = {}) {
  const text = originalText(input), { requestId, chosenTaskId } = input;
  if (requestId != null && (typeof requestId !== 'string' || !ID.test(requestId))) throw fail('Invalid planner request identifier.');
  if (chosenTaskId != null && (typeof chosenTaskId !== 'string' || !ID.test(chosenTaskId))) throw fail('Choose a task from the offered list.');
  if (input.forceCreate != null && typeof input.forceCreate !== 'boolean') throw fail('Choose whether to add this as a new task.');
  if ((input.retryMatch != null && typeof input.retryMatch !== 'boolean') ||
      (input.retryMatchId != null && (input.retryMatch !== true || typeof input.retryMatchId !== 'string' || !ID.test(input.retryMatchId))) ||
      (input.retryMatch === true && (chosenTaskId || input.forceCreate))) throw fail('Choose one planner action to retry.');
  const enteredDay = commandDay(input);
  const saved = requestId && service.data.plannerCommands?.[requestId];
  if (saved && saved.text !== text) throw fail('This request identifier belongs to a different planner instruction.', 409);
  if (['applied','preview','answer'].includes(saved?.receipt.kind)) return structuredClone(saved.receipt);
  if (requestId && (service.data.tasks.some(task => task.id === requestId) || service.data.deletedTaskIds?.includes(requestId))) return { kind:'create', id:requestId };
  if (input.forceCreate === true) return { kind:'create' };
  if (chosenTaskId && (!saved || saved.receipt.kind !== 'needs-choice' || !saved.receipt.candidates.some(item => item.id === chosenTaskId))) {
    throw fail('Choose a task offered for this instruction.', 409);
  }
  const attemptId = input.retryMatchId || 'explicit';
  const retry = input.retryMatch === true && (!saved || (['no-match','clarification','unparsed'].includes(saved.receipt.kind) &&
    !saved.matchRetryIds?.includes(attemptId)));
  if (saved && !chosenTaskId && !retry && (saved.receipt.kind !== 'unparsed' || !interpretedText)) return structuredClone(saved.receipt);
  const item = saved ? { id:requestId, text, at:saved.at, timeZone:saved.timeZone } : { id:requestId, text, ...service.captureContext(input) };
  const day = saved?.contextDay ?? enteredDay;
  if (day) item.contextDay = day;
  if (saved?.matchRetryIds || retry) item.matchRetryIds = [...(saved?.matchRetryIds || []), ...(retry ? [attemptId] : [])];
  if (saved?.interpretedText) item.interpretedText = saved.interpretedText;
  else if (interpretedText != null) item.interpretedText = originalText({ text:interpretedText });
  const context = { tasks:service.data.tasks, now:new Date(item.at), timeZone:item.timeZone, contextDay:item.contextDay };
  const original = parsePlannerCommand(text, context);
  const useInterpretation = Boolean(item.interpretedText && (original.kind === 'create' || original.reason === 'syntax'));
  const wording = useInterpretation ? item.interpretedText : text;
  const parsed = chosenTaskId || useInterpretation ? parsePlannerCommand(wording, { ...context, selectedTaskId:chosenTaskId,
    ...(saved?.receipt.choiceRole && { choiceRole:saved.receipt.choiceRole }),
    ...(saved?.receipt.counterpartId && { counterpartId:saved.receipt.counterpartId }) }) : original;
  if (parsed.kind === 'create' && !item.interpretedText && !chosenTaskId && !retry) return { kind:'create' };
  if (!requestId) throw fail('A request identifier is required to apply this planner instruction.');
  if (parsed.kind !== 'command') {
    const reason = parsed.kind === 'clarify' ? parsed : { reason:'syntax', message:'Try a task name and the change you want.' };
    const receipt = clarification(service, reason);
    if (retry && receipt.kind === 'unparsed') receipt.kind = 'clarification';
    return persist(service, item, receipt);
  }
  if (useInterpretation && (parsed.taskIds.length > 1 || groupInOriginal.test(wording)) && !groupInOriginal.test(text)) {
    return persist(service, item, { kind:'clarification', reason:'scope',
      message:'Name the task to change, or explicitly say which group of tasks should move.', taskIds:[] });
  }
  const sourceChoice = chosenTaskId && saved.receipt.choiceRole !== 'target';
  const chosenId = sourceChoice ? parsed.taskIds[0] : parsed.action === 'order' && parsed.changes.targetId;
  const counterpart = parsed.action === 'order' && (sourceChoice ? parsed.changes.targetId : parsed.taskIds[0]);
  if (chosenTaskId && (parsed.taskIds.length !== 1 || chosenId !== chosenTaskId ||
      (saved.receipt.counterpartId && counterpart !== saved.receipt.counterpartId))) {
    return persist(service, item, clarification(service, { reason:'stale-selection', message:'The chosen task no longer matches this instruction. Enter its current title.' }));
  }
  const ids = new Set(parsed.taskIds);
  const targets = service.data.tasks.filter(task => ids.has(task.id));
  if (!targets.length || targets.length !== ids.size) return persist(service, item, clarification(service, { reason:'unmatched', message:'The requested tasks are no longer on this planner.' }));
  const protectedReason = targets.map(task => cannotEdit(task,parsed.action)).find(Boolean);
  if (protectedReason) return persist(service, item, clarification(service, { reason:'protected', message:protectedReason }));

  const learning = { durationLearning:service.data.durationLearning };
  const now = service.clock();
  let tasks;
  try {
    tasks = parsed.action === 'order' ? service.reorderedTaskList(targets[0].id, parsed.changes)
      : service.data.tasks.map(task => ids.has(task.id) ? revise(service,task,parsed.action,parsed.changes,learning,now) : task);
  } catch (error) {
    if (![400, 404, 409].includes(error.status) && !(error instanceof RangeError)) throw error;
    return persist(service, item, clarification(service, { reason:'invalid-change', message:error.message }));
  }
  const connected = service.data.accounts.length > 0;
  if (!connected) tasks = service.plannedTasks(tasks, [], now, { overruns:true });
  const target = parsed.action === 'order' && service.findTask(parsed.changes.targetId);
  const message = describe(parsed.action, parsed.changes, tasks.filter(task => ids.has(task.id)), service.data.settings.timeZone, connected, target);
  return persist(service, item, { kind:'applied', action:parsed.action, message, taskIds:[...ids] }, tasks, learning);
}
