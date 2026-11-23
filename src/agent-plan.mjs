import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { createPlanContext, dayOf, digest, label, requestText, taskVersion, validDay, validId } from './agent-plan-context.mjs';
import { explicitStartFor } from './planner.mjs';
import { persistPlannerReceipt, plannerEditIssue, revisePlannerTask } from './planner-command-service.mjs';
import { editChecklist } from './subtasks.mjs';

export { createPlanContext };

const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const fields = new Map(Object.entries({
  update:['day','time','minutes','deltaMinutes','title'], complete:[], reopen:[], first:[], order:['other','placement'],
  'subtask.add':['title','done'], 'subtask.rename':['subtask','title'], 'subtask.remove':['subtask'], 'subtask.check':['subtask','done'],
}));
const reject = message => { throw Object.assign(new Error(message), { status:409 }); };
const display = value => '“' + value + '”';
const own = (object, key) => Object.hasOwn(object,key);
const stale = 'The tasks or schedule changed since this plan was prepared. Submit the request again to review an updated plan.';
const clarification = message => ({ kind:'clarification', reason:'agent', message, taskIds:[] });

// A completed ordinary capture or command wins even if a slower model response
// arrives later. A previously unmatched instruction can still receive a plan.
export function agentPlanReceipt(service, requestId, text) {
  text = requestText({ requestId,text });
  const existing = service.data.plannerCommands?.[requestId];
  if (existing && existing.text !== text) reject('This capture ID belongs to different wording.');
  if (existing?.receipt?.kind === 'applied') return structuredClone(existing.receipt);
  if (service.data.tasks.some(task => task.id === requestId) || service.data.deletedTaskIds?.includes(requestId)) {
    return { kind:'create', id:requestId };
  }
  if (existing?.agentPlan || existing?.receipt?.kind === 'answer' || existing?.receipt?.reason === 'agent') return structuredClone(existing.receipt);
  return null;
}

function normalize(actions, targets) {
  if (!Array.isArray(actions) || !actions.length || actions.length > 24) reject('Choose between one and 24 planner changes.');
  return actions.map(action => {
    if (!action || typeof action !== 'object' || Array.isArray(action) || !fields.has(action.op)) reject('This plan contains an unsupported action.');
    const allowed = fields.get(action.op);
    if (Object.keys(action).some(key => !['op','task',...allowed].includes(key))) reject('This plan contains an unsupported field.');
    if (typeof action.task !== 'string' || !own(targets,action.task)) reject('A proposed task was outside the supplied planner context.');
    const result = { op:action.op, task:action.task };
    for (const key of allowed) if (action[key] != null) result[key] = action[key];
    if (result.op === 'update' && !allowed.some(key => own(result,key))) reject('Choose a day, time, title or duration to update.');
    if (own(result,'time') && (typeof result.time !== 'string' || !clock.test(result.time))) reject('Choose a valid local start time.');
    if (own(result,'day') && !validDay(result.day)) reject('Choose a valid calendar date.');
    if (own(result,'minutes') && (!Number.isSafeInteger(result.minutes) || result.minutes < 1)) reject('Choose a positive whole duration.');
    if (own(result,'deltaMinutes') && (!Number.isSafeInteger(result.deltaMinutes) || !result.deltaMinutes || own(result,'minutes'))) reject('Choose one absolute or relative duration change.');
    const needsTitle = result.op === 'subtask.add' || result.op === 'subtask.rename';
    if (needsTitle || own(result,'title')) {
      if (typeof result.title !== 'string' || !result.title.trim() || [...result.title.trim()].length > (needsTitle ? 160 : 120) || /[\p{Cc}\p{Cf}]/u.test(result.title)) reject('Choose a short, nonempty title for this change.');
      result.title = result.title.trim();
    }
    if ((own(result,'done') || result.op === 'subtask.check') && typeof result.done !== 'boolean') reject('Choose complete or open for this step.');
    if (allowed.includes('subtask') && (typeof result.subtask !== 'string' || !own(targets[result.task].subtasks,result.subtask))) {
      reject('A proposed checklist step does not belong to its named task.');
    }
    if (result.op === 'order' && (typeof result.other !== 'string' || !own(targets,result.other) || result.task === result.other ||
        !['before','after'].includes(result.placement))) reject('Choose two different tasks and their relative order.');
    return result;
  });
}

function referenced(actions) {
  return [...new Set(actions.flatMap(action => action.other ? [action.task,action.other] : [action.task]))];
}

function ambiguous(subjects) {
  const names = [...new Set(subjects.map(subject => display(subject.label)))].slice(0,3);
  reject('More than one task matches' + (names.length ? ', including ' + names.join(' and ') : '') + '. Include its day or a distinguishing word.');
}

function rankedSubject(subject, all, rank) {
  const duration = ['shortest','quickest','longest'].includes(rank), descending = ['longest','last','latest'].includes(rank);
  const candidates = all.filter(item => !item.done && item.inScope && (duration ? item.minutes > 0 : Boolean(item.start)));
  const value = item => duration ? item.minutes : Date.parse(item.start);
  candidates.sort((a,b) => descending ? value(b) - value(a) : value(a) - value(b));
  if (!candidates.length) reject('No scheduled task matches that comparison. Name the task to use.');
  const best = candidates.filter(item => value(item) === value(candidates[0]));
  if (best.length > 1) ambiguous(best);
  if (best[0].id !== subject.id) reject('That task does not match the requested order or duration. Name the task to use.');
}

function checkSubjects(bindings, nativeIds) {
  const all = Object.values(bindings.targets);
  for (const id of nativeIds) {
    const subject = all.find(item => item.id === id);
    if (!subject) reject(stale);
    const byScope = subject.inScope && (bindings.broad || (bindings.group && subject.evidence.length));
    const byPointer = subject.visible && bindings.pointed && bindings.visibleCount === 1;
    if (!subject.evidence.length && bindings.rank) { rankedSubject(subject,all,bindings.rank); continue; }
    if (byPointer || byScope) continue;
    if (subject.evidence.length) {
      const equallySupported = all.filter(other => JSON.stringify(subject.evidence) === JSON.stringify(other.evidence));
      if (equallySupported.length > 1) ambiguous(equallySupported);
    } else {
      // The subscribed agent may recognize a metaphor that has no matching word
      // locally. A single explicitly named preview can propose that visible row.
      // It cannot use this exception to add offscreen or multiple targets.
      if (nativeIds.length !== 1 || !subject.visible || all.some(item => item.evidence.length)) {
        reject('Name the task to change or identify a group on your planner.');
      }
      const close = all.filter(other => other.visible && (other.id === id || other.label.toLocaleLowerCase() === subject.label.toLocaleLowerCase() ||
        other.topics.some(word => subject.topics.includes(word))));
      if (close.length > 1) ambiguous(close);
      if (bindings.pointed && bindings.visibleCount > 1) ambiguous(all.filter(item => item.visible && !item.done));
    }
  }
  if (bindings.omitted && /\b(?:all|every|each|everything)\b/i.test(bindings.text)) reject('This group does not fit in one preview. Name a day or a smaller group of tasks.');
}

function guardCurrent(service, plan, body) {
  const current = createPlanContext(service, { ...body, capturedAt:plan.at, captureTimeZone:plan.captureZone, contextDay:plan.viewDay }).bindings;
  if (current.settings !== plan.settings || (plan.scope && current.scope !== plan.scope)) reject(stale);
  const pinned = Object.values(plan.targets), ids = pinned.map(target => target.id);
  const byId = new Map(service.data.tasks.map(task => [task.id,task]));
  if (pinned.some(target => !byId.has(target.id) || taskVersion(byId.get(target.id)) !== target.version)) reject(stale);
  if (plan.order && Object.entries(plan.order).some(([group,version]) => (current.orderByGroup[group] || null) !== version)) reject(stale);
  checkSubjects(current,ids);
}

function assertEditable(task, action) {
  const problem = plannerEditIssue(task, action);
  if (problem) reject(problem);
}

function update(view, task, action, learning, now, today) {
  const subject = display(label(task)), edits = [];
  let next = task;
  if (action.day || action.time) {
    assertEditable(next,'move');
    const day = action.day || dayOf(next,view.data.settings.timeZone) || today;
    next = revisePlannerTask(view,next,'move',{day,...(action.time && {time:action.time})},learning,now);
    edits.push('request ' + day + (action.time ? ' at ' + action.time : ''));
    if ((next.movedSlots?.length || 0) > (task.movedSlots?.length || 0)) {
      const old = next.movedSlots.at(-1);
      const start = DateTime.fromISO(old.start,{zone:old.timeZone}).toFormat('HH:mm');
      edits.push('keep ' + old.day + ' at ' + start + ' marked Moved');
    }
  }
  if (own(action,'minutes') || own(action,'deltaMinutes')) {
    assertEditable(next,'duration');
    const minutes = action.minutes ?? next.minutes + action.deltaMinutes;
    next = revisePlannerTask(view,next,'duration',{minutes},learning,now);
    edits.push('set duration to ' + minutes + ' min');
  }
  if (action.title) {
    assertEditable(next,'rename');
    next = revisePlannerTask(view,next,'rename',{title:action.title},learning,now);
    edits.push('rename to ' + display(action.title));
  }
  return {next,step:subject + ' — ' + edits.join(', ') + '.'};
}

function changeStep(view, task, action, binding, newId) {
  assertEditable(task,task.done ? 'reopen' : 'rename');
  const next = structuredClone(task), kind = action.op.slice('subtask.'.length);
  const subtaskId = kind === 'add' ? newId : binding.subtasks[action.subtask];
  const previousStep = next.subtasks?.find(step => step.id === subtaskId);
  const previous = previousStep?.title || previousStep?.text;
  const result = editChecklist(next,{kind,subtaskId,title:action.title,done:action.done});
  const effect = result.completion === null ? '' : result.completion ? ' This completes the parent task.' : ' This reopens the parent task.';
  if (result.completion !== null) {
    next.dirty ||= {};
    view.setTaskCompletion(next,result.completion,false);
    if (next.remote || next.pausedSync?.remote) next.commandEventPending = true;
    view.prepareSavedEdit(task,next);
  }
  const wording = kind === 'add' ? 'Add ' + display(action.title) + (action.done ? ' as complete' : '') :
    kind === 'remove' ? 'Remove ' + display(previous) : kind === 'rename' ? 'Rename ' + display(previous) + ' to ' + display(action.title) :
    (action.done ? 'Check off ' : 'Reopen ') + display(previous);
  return {next,step:wording + ' in ' + display(label(task)) + '.' + effect};
}

function checkRequestedSlot(task, settings, now, requestedClock) {
  const day = task.estimateOverrides?.day;
  if (!day || task.done) return;
  const zone = settings.timeZone, date = DateTime.fromISO(day,{zone});
  if (day < DateTime.fromJSDate(now,{zone}).toISODate()) reject(display(label(task)) + ' needs a current or future date.');
  // A day pin is valid even when the normal planner must wait for an opening.
  if (!requestedClock) return;
  if (!settings.workDays.includes(date.weekday)) reject(display(label(task)) + ' needs a working day for that exact time.');
  const time = explicitStartFor(task,zone);
  if (!time) return;
  const start = DateTime.fromISO(day + 'T' + time,{zone}), end = DateTime.fromISO(day + 'T' + settings.endTime,{zone});
  if (!start.isValid || start.toFormat('HH:mm') !== time || time < settings.startTime || start.toMillis() < now.getTime() ||
    start.plus({minutes:task.pendingEstimate ? 1 : task.minutes || 1}) > end) {
    reject(display(label(task)) + ' cannot fit at that time inside the remaining work hours. Choose another time.');
  }
}

// All service edit helpers work on copies here. A later invalid step cannot
// publish an earlier one, train a duration, touch Google or claim a model job.
function stage(service, plan) {
  const view = Object.create(service);
  view.data = { ...service.data,tasks:[...service.data.tasks] };
  const steps = [], moved = new Set(), requestedClocks = new Set(), learning = {durationLearning:service.data.durationLearning}, now = service.clock();
  const today = DateTime.fromISO(plan.at,{zone:plan.captureZone}).toISODate();
  for (const [i,action] of plan.actions.entries()) {
    const binding = plan.targets[action.task], task = view.findTask(binding.id);
    if (action.op === 'first') {
      view.data.tasks = view.reorderedTaskList(task.id,{placement:'first'},moved.has(task.id) ? task.estimateOverrides?.day : undefined);
      steps.push('Give ' + display(label(task)) + ' the earliest available time.');
      continue;
    }
    if (action.op === 'order') {
      if (moved.size && !service.data.accounts.length) view.data.tasks = view.plannedTasks(view.data.tasks,[],now);
      const target = view.findTask(plan.targets[action.other].id);
      view.data.tasks = view.reorderedTaskList(task.id,{targetId:target.id,placement:action.placement});
      steps.push('Place ' + display(label(task)) + ' ' + action.placement + ' ' + display(label(target)) + '.');
      continue;
    }
    let next, step;
    if (action.op === 'update') {
      if ((action.day || action.time || action.minutes || action.deltaMinutes) && binding.groupOnly && explicitStartFor(task,view.data.settings.timeZone)) {
        reject(display(label(task)) + ' has a fixed appointment time. Name it explicitly to change its schedule.');
      }
      ({next,step} = update(view,task,action,learning,now,today));
      if (action.day || action.time) moved.add(task.id);
      if (action.time) requestedClocks.add(task.id);
    }
    else if (action.op.startsWith('subtask.')) {
      const subtaskId = digest([plan.id, i, task.id]).slice(0,32);
      ({next,step} = changeStep(view,task,action,binding,subtaskId));
    } else {
      assertEditable(task,action.op);
      next = revisePlannerTask(view,task,action.op,{done:action.op === 'complete'},learning,now);
      step = (action.op === 'complete' ? 'Complete ' : 'Reopen ') + display(label(task)) +
        (task.subtasks?.length ? ' and its checklist.' : '.');
    }
    view.data.tasks = view.data.tasks.map(item => item.id === task.id ? next : item);
    steps.push(step);
  }
  for (const id of moved) checkRequestedSlot(view.findTask(id),view.data.settings,now,requestedClocks.has(id));
  const tasks = service.data.accounts.length ? view.data.tasks : view.plannedTasks(view.data.tasks,[],now,{overruns:true});
  return {tasks,steps,learning};
}

function permittedFailure(error) {
  return error instanceof RangeError || [400,404,409].includes(error.status);
}

function remember(service, record, receipt, staged) {
  // Disk failures must propagate. A failing save is never interpreted as a
  // validation failure or an applied plan.
  return persistPlannerReceipt(service,record,receipt,staged?.tasks,staged?.learning);
}

export function previewAgentPlan(service, body, context, actions, agent) {
  const text = requestText(body), saved = agentPlanReceipt(service,body.requestId,text);
  if (saved) return saved;
  const earlier = service.data.plannerCommands?.[body.requestId];
  if (earlier?.receipt.kind === 'needs-choice') return structuredClone(earlier.receipt);
  const b = context?.bindings;
  if (!b || b.requestId !== body.requestId || b.text !== text) reject('The planner context belongs to a different request.');
  const plan = { id:randomUUID().replaceAll('-',''), at:b.at, captureZone:b.captureZone, viewDay:b.viewDay, settings:b.settings };
  const record = {id:body.requestId,text,at:b.at,timeZone:b.captureZone,contextDay:b.viewDay,agentPlan:plan};
  let receipt;
  try {
    plan.actions = normalize(actions,b.targets);
    const aliases = referenced(plan.actions);
    const ids = aliases.map(alias => b.targets[alias].id);
    checkSubjects(b,ids);
    if (b.group) plan.scope = b.scope;
    const orderGroups = new Set(plan.actions.filter(action => action.op === 'order' || action.op === 'first')
      .flatMap(action => action.other ? [b.targets[action.task].orderGroup,b.targets[action.other].orderGroup] : [b.targets[action.task].orderGroup]));
    if (orderGroups.size) plan.order = Object.fromEntries([...orderGroups].map(group => [group,b.orderByGroup[group] || null]));
    plan.targets = Object.fromEntries(aliases.map(alias => {
      const {id,version,subtasks,evidence} = b.targets[alias];
      const groupOnly = b.group && !evidence.length && !(b.pointed && b.visibleCount === 1);
      return [alias,{id,version,subtasks,groupOnly}];
    }));
    guardCurrent(service,plan,body);
    const {steps} = stage(service,plan);
    receipt = {kind:'preview', message:'Review ' + steps.length + (steps.length === 1 ? ' proposed change.' : ' proposed changes.'), planId:plan.id,steps,taskIds:ids};
  } catch (error) {
    if (!permittedFailure(error)) throw error;
    record.agentPlan = {id:plan.id};
    receipt = clarification(error.message);
  }
  if (agent) receipt.agent = structuredClone(agent);
  return remember(service,record,receipt);
}

export function applyAgentPlan(service, { requestId,planId,text } = {}) {
  if (!validId(requestId) || !validId(planId)) reject('Choose the saved plan you want to apply.');
  const entry = service.data.plannerCommands?.[requestId];
  if (!entry?.agentPlan || entry.agentPlan.id !== planId || (text !== undefined && entry.text !== requestText({requestId,text}))) reject('This preview no longer belongs to that request.');
  const replay = agentPlanReceipt(service,requestId,entry.text);
  if (replay?.kind === 'create') return replay;
  if (entry.receipt.kind !== 'preview') return structuredClone(entry.receipt);
  const { receipt:preview,agentPlan:plan,...saved } = entry;
  const record = {...saved,agentPlan:{id:planId}};
  let staged, receipt;
  try {
    guardCurrent(service,plan,{requestId,text:entry.text});
    staged = stage(service,plan);
    if (JSON.stringify(staged.steps) !== JSON.stringify(preview.steps)) reject(stale);
    receipt = {kind:'applied', message:'Applied ' + preview.steps.length + (preview.steps.length === 1 ? ' planner change.' : ' planner changes.'),
      planId,steps:preview.steps,taskIds:preview.taskIds};
  } catch (error) {
    if (!permittedFailure(error)) throw error;
    staged = undefined;
    receipt = clarification(error.message);
  }
  if (preview.agent) receipt.agent = structuredClone(preview.agent);
  return remember(service,record,receipt,staged);
}
