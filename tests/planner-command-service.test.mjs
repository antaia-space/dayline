import test from 'node:test';
import assert from 'node:assert/strict';
import { DaylineService } from '../src/service.mjs';
import { defaultSettings } from '../src/store.mjs';
import { estimateTask } from '../src/planner.mjs';

const monday = '2026-11-23', tuesday = '2026-11-24', wednesday = '2026-11-25';
const at = (day, time) => day + 'T' + time + ':00.000Z';
const id = n => n.toString(16).padStart(32, '0');
const body = (number, text) => ({ requestId: id(number), text });

function fixture(saved, google) {
  const state = saved ? structuredClone(saved) : { version: 1, tasks: [], accounts: [], settings: { ...defaultSettings(), timeZone: 'UTC' } };
  const store = { state, writes: 0, save() { this.writes++; this.saved = structuredClone(this.state); } };
  const h = { store, now: at(monday, '08:00'), estimates: 0 };
  h.service = new DaylineService({ store, clock: () => new Date(h.now), google,
    bundledClient: { clientId: 'fixture' }, vault: { open: value => value },
    estimate(text, context) {
      h.estimates++;
      return { ...estimateTask(text, context), agent: { provider: 'local', model: 'Fixture', outcome: 'success' } };
    } });
  h.command = (input, options) => h.service.run(() => h.service.runPlannerCommand(input, options));
  h.add = async (number, note, title) => {
    const taskId = await h.service.createTask(body(number, note));
    if (title) await h.service.editTask(taskId, { title });
    return h.service.findTask(taskId);
  };
  return h;
}

test('a local read-only planner moves an existing task around authoritative Google busy time without creating or re-estimating it', async () => {
  const calls = [];
  const bookings = { home: [{ start: at(wednesday, '13:00'), end: at(wednesday, '14:30') }], work: [] };
  const google = {
    refreshToken({ refreshToken }) { return { access_token: refreshToken, expires_in: 3600 }; },
    listCalendars(account) { return [{ id: account, name: account, primary: true, writable: false }]; },
    getBusy(account, { calendarIds }) { calls.push({ account, calendarIds }); return bookings[account]; }
  };
  const h = fixture(undefined, google);
  const note = 'Review the launch checklist at 10:00 for 25 minutes';
  const task = await h.add(1, note, 'Launch review');
  task.subtasks = [{ id: 'draft', text: 'Check the draft', done: true }, { id: 'signoff', text: 'Check sign-off', done: false }];
  const original = structuredClone(task);
  h.service.data.accounts = ['work', 'home'].map(sub => ({ sub, email: sub + '@example.test', secret: sub, mode: 'availability' }));
  const receipt = await h.command(body(9, 'Move the launch review to Wednesday at 2pm'));
  assert.deepEqual([receipt.kind, receipt.taskIds], ['applied', [task.id]]);
  assert.equal(task.start, null);
  assert.match(receipt.message, /check calendar availability/i);
  await h.service.queueSync();
  assert.equal(h.service.error, null);
  assert.equal(task.start, null);
  assert.match(task.issue, /Google Calendar is busy at the requested 14:00/);
  bookings.home = [];
  await h.service.queueSync();
  assert.deepEqual([task.start, task.end], [at(wednesday, '14:00'), at(wednesday, '14:25')]);
  assert.deepEqual(new Set(calls.map(c => c.account)), new Set(['work', 'home']));
  assert.deepEqual([task.id, task.text, task.title, task.subtasks, task.agent, task.estimatedMinutes],
    [original.id, note, original.title, original.subtasks, original.agent, original.estimatedMinutes]);
  assert.equal(h.estimates, 1);
  assert.equal(h.service.data.tasks.length, 1);
  assert.equal(h.service.data.settings.calendarMode, 'availability');
});

test('one relative duration instruction creates one correction across overlapping clients, restarts, and lost acknowledgements', async () => {
  const h = fixture();
  const task = await h.add(1, 'Prepare the budget for 20 minutes', 'Budget');
  const input = body(8, 'Give the budget 5 more minutes');
  const [first, second] = await Promise.all([h.command(input), h.command(input)]);
  assert.deepEqual(first, second);
  assert.deepEqual([first.kind, task.minutes, task.baseMinutes, task.estimatedMinutes], ['applied', 25, 20, 20]);
  assert.equal(h.service.data.durationLearning.examples.length, 1);
  const restart = fixture(h.store.saved);
  assert.deepEqual(await restart.command(input), first);
  assert.deepEqual(await restart.command({ ...input, forceCreate: true }), first);
  assert.equal(restart.service.findTask(task.id).minutes, 25);
  await assert.rejects(restart.command({ ...input, text: 'Give the budget another 10 minutes' }), { status: 409 });
  assert.throws(() => restart.service.enqueueTask({ ...input, forceCreate: true }), { status: 409 });
  assert.equal(restart.estimates, 0);
});

test('ambiguities show only matching titles with distinguishing details and require a still-valid original choice', async () => {
  const h = fixture();
  const first = await h.add(1, 'Review the North contract for 20 minutes', 'Contract');
  const second = await h.add(2, 'Review the South contract for 20 minutes', 'Contract');
  const other = await h.add(3, 'Open the delivery', 'Delivery');
  const input = body(8, 'Move contract to tomorrow');
  const question = await h.command(input);
  assert.equal(question.kind, 'needs-choice');
  assert.deepEqual(question.candidates.map(c => c.id), [first.id, second.id]);
  assert.match(question.candidates[0].detail, /09:00.*North contract/);
  assert.match(question.candidates[1].detail, /09:20.*South contract/);
  await assert.rejects(h.command({ ...input, chosenTaskId: other.id }), { status: 409 });
  h.service.deleteTask(first.id);
  const stale = await h.command({ ...input, chosenTaskId: first.id });
  assert.notEqual(stale.kind, 'applied');
  assert.equal(second.start.slice(0, 10), monday);
  const answer = await h.command({ ...input, chosenTaskId: second.id });
  assert.deepEqual(answer.taskIds, [second.id]);
  assert.equal(second.start.slice(0, 10), tuesday);
  assert.equal(other.start.slice(0, 10), monday);
  assert.equal(h.estimates, 3);
});

test('a trusted paraphrase is resolved against live tasks and retained for a choice across restart and midnight', async () => {
  const h = fixture();
  await h.add(1, 'Draft North bulletin', 'Bulletin');
  const south = await h.add(2, 'Draft South bulletin', 'Bulletin');
  const input = { ...body(7, 'Tuesday would suit one of the bulletins better'), capturedAt: at(monday, '07:59'), captureTimeZone: 'UTC' };
  const result = await h.command(input, { interpretedText: 'Move bulletin to tomorrow' });
  assert.equal(result.kind, 'needs-choice');
  const restart = fixture(h.store.saved);
  restart.now = at(tuesday, '07:00');
  const answer = await restart.command({ ...input, chosenTaskId: south.id }, { interpretedText: 'Mark North done' });
  assert.deepEqual([answer.kind, answer.action, answer.taskIds], ['applied', 'move', [south.id]]);
  assert.equal(restart.service.findTask(south.id).earliestDay, tuesday);
  assert.equal(restart.service.data.tasks.some(task => task.done), false);
  assert.equal(restart.estimates, 0);
});

test('an explicit force-create settles an unmatched instruction once, including after a deleted task and replay', async () => {
  const h = fixture();
  const input = body(5, 'Move the missing review to Wednesday');
  assert.equal((await h.command(input)).kind, 'no-match');
  assert.equal(h.service.data.tasks.length, 0);
  assert.throws(() => h.service.enqueueTask(input), { status: 409 });
  const forced = { ...input, forceCreate: true };
  assert.equal((await h.command(forced)).kind, 'create');
  assert.equal(h.service.enqueueTask(forced), input.requestId);
  assert.equal(h.service.data.plannerCommands[input.requestId], undefined);
  assert.equal(h.service.enqueueTask(forced), input.requestId);
  h.service.deleteTask(input.requestId);
  const restart = fixture(h.store.saved);
  assert.deepEqual(await restart.command(input), { kind: 'create', id: input.requestId });
  assert.equal(restart.service.enqueueTask(input), input.requestId);
  assert.equal(restart.service.data.tasks.length, 0);
});

test('scoped bulk moves and their receipt persist in one write or roll back as a whole; fixed clocks survive a day change', async () => {
  const h = fixture();
  const a = await h.add(1, 'Inspect the battery at 10:00 for 20 minutes', 'Battery');
  const b = await h.add(2, 'Order new parts for 15 minutes', 'Parts');
  const historical = await h.add(3, 'Deliver materials for 10 minutes', 'Delivered');
  await h.service.editTask(historical.id, { done: true });
  const external = await h.add(4, 'Review room bookings', 'Real appointment');
  external.pausedSync = { remote: { calendarAppointment: true } };
  const original = structuredClone(h.service.data.tasks);
  const input = body(8, 'Move all unfinished tasks from Monday to Wednesday');
  const save = h.store.save;
  h.store.save = () => { throw new Error('Disk busy'); };
  await assert.rejects(h.command(input), /Disk busy/);
  assert.deepEqual(h.service.data.tasks, original);
  assert.equal(h.service.data.plannerCommands, undefined);
  h.store.save = save;
  const writes = h.store.writes;
  const reply = await h.command(input);
  assert.deepEqual(reply.taskIds, [a.id, b.id]);
  assert.equal(h.store.writes, writes + 1);
  assert.equal(a.start, at(wednesday, '10:00'));
  assert.equal(b.start, at(wednesday, '09:00'));
  assert.equal(historical.completedDay, monday);
  assert.equal(external.estimateOverrides.day, undefined);
  assert.deepEqual(h.store.saved.plannerCommands[input.requestId].receipt, reply);
});

test('rename and completion commands retain the original note and apply the same completion and reopen lifecycle as the checkbox', async () => {
  const h = fixture();
  const task = await h.add(1, 'Plan the rollout for 25 minutes', 'Rollout');
  task.subtasks = [{ id:'a', text:'Draft', done:true }, { id:'b', text:'Approve', done:false }];
  await h.command(body(2, 'Rename Rollout to Launch plan'));
  assert.deepEqual([task.title, task.text, task.subtasks.map(t => t.done)], ['Launch plan', 'Plan the rollout for 25 minutes', [true,false]]);
  const closed = await h.command(body(3, 'Mark Launch plan done'));
  assert.deepEqual([closed.action, task.done, task.start, task.completedDay, task.subtasks.map(t => t.done)], ['complete', true, null, monday, [true,true]]);
  const completed = await h.command(body(4, 'Move Launch plan to Wednesday'));
  assert.equal(completed.kind, 'no-match');
  assert.equal(task.completedDay, monday);
  await h.command(body(5, 'Reopen Launch plan'));
  assert.deepEqual([task.done, task.start, task.completedDay, task.subtasks.map(t => t.done)], [false, at(monday,'09:00'), undefined, [false,false]]);
  assert.equal(h.estimates, 1);
});

test('moving a queued estimate preserves the job and its exact override when the estimate finishes', async () => {
  const h = fixture();
  const taskId = h.service.enqueueTask(body(1, 'Review the forecast at 10am for 35 minutes'));
  await h.service.editTask(taskId, { title:'Forecast' });
  const task = h.service.findTask(taskId), job = task.estimateJob.id;
  const move = await h.command(body(2, 'Move Forecast to Wednesday at 2pm'));
  assert.deepEqual([move.kind, task.estimateJob.id, task.estimateOverrides.time, task.windowEnd], ['applied', job, '14:00', null]);
  h.service.startEstimateWorker();
  await h.service.whenEstimatesIdle();
  h.service.stopEstimateWorker();
  assert.equal(task.estimateJob, null);
  assert.deepEqual([task.id, task.text, task.minutes, task.start, task.end, task.windowEnd],
    [taskId, 'Review the forecast at 10am for 35 minutes', 35, at(wednesday,'14:00'), at(wednesday,'14:35'), '14:35']);
  assert.equal(h.estimates, 1);
});

test('an explicit move clears the old overrun, restores a fitted forecast, and cannot claim elapsed time or outside work hours', async () => {
  const h = fixture();
  const task = await h.add(1, 'Outline the proposals for 45 minutes', 'Proposals');
  task.calendarFit = {originalMinutes:45}; task.minutes = 40;
  task.overrunWatchStart = task.start; task.overrunMinutes = 5;
  h.now = at(monday,'09:25');
  const earlier = await h.command(body(2, 'Move proposals to today at 9:10'));
  assert.equal(earlier.kind, 'applied');
  assert.deepEqual([task.start, task.minutes, task.calendarFit, task.overrunMinutes, task.overrunWatchStart], [null, 45, undefined, undefined, undefined]);
  assert.match(task.issue, /passed/);
  const late = await h.command(body(3, 'Move proposals to Wednesday at 16:50'));
  assert.equal(late.kind, 'applied');
  assert.equal(task.start, null);
  assert.match(task.issue, /working hours/);
  assert.equal(h.estimates, 1);
});

test('a newly shared reservation blocks an already requested calendar-write instruction after the provider is refreshed', async () => {
  const h = fixture(undefined, { putTaskEvent() { assert.fail('Must not write a shared meeting'); } });
  const task = await h.add(1, 'Review the slides', 'Slides');
  h.service.data.settings.calendarMode = 'sync';
  h.service.data.accounts = [{sub:'work',mode:'sync'}];
  task.remote = {sub:'work',calendarId:'main',eventId:id(91),etag:'version1'};
  const receipt = await h.command(body(2, 'Move slides to Wednesday at 14:00'));
  assert.equal(receipt.kind, 'applied');
  assert.equal(task.commandEventPending, true);
  task.remote.calendarAppointment = true;
  await assert.rejects(h.service.pushTask(task, new Map()), /Google Calendar now protects this appointment/);
  assert.equal(task.start, at(monday,'09:00'));
});

test('terminal agent clarification is durable and cannot replace a chosen edit or expand a single task into a bulk move', async () => {
  const h = fixture();
  const task = await h.add(1, 'Review the accounts', 'Account review');
  const other = await h.add(2, 'Review permits', 'Permits');
  const input = body(3, 'Would Wednesday suit the account review better?');
  const widened = await h.command(input, { interpretedText:'Move all tasks to Wednesday' });
  assert.equal(widened.kind, 'clarification');
  assert.deepEqual([task.start.slice(0,10), other.start.slice(0,10)], [monday,monday]);
  const ask = body(4, 'Would Wednesday be better?');
  const answer = h.service.settlePlannerClarification(ask, 'Which task do you mean?');
  const restart = fixture(h.store.saved);
  assert.deepEqual(await restart.command(ask), answer);
  assert.deepEqual(await restart.command(ask, { interpretedText:'Move permits to Wednesday' }), answer);
  assert.equal((await restart.command({ ...ask, forceCreate:true })).kind, 'create');
  const precise = body(5, 'Move permits to Wednesday');
  const applied = await restart.command(precise, { interpretedText: 'Move all tasks to Wednesday' });
  assert.deepEqual(applied.taskIds, [other.id]);
  assert.deepEqual(restart.service.settlePlannerClarification(precise, 'A late model notice'), applied);
});

test('spoken task ordering and the grip share priority, preserve fixed reservations, and replay once after restart', async () => {
  const h = fixture();
  const first = await h.add(1, 'Proofread for 20 minutes', 'Proofread');
  const second = await h.add(2, 'Draft agenda for 15 minutes', 'Agenda');
  const fixed = await h.add(3, 'Attend briefing at 10:00 for 10 minutes', 'Briefing');
  const tomorrow = await h.add(4, 'Buy materials tomorrow for 10 minutes', 'Materials');
  const viaGrip = fixture(h.store.saved);
  viaGrip.service.reorderTask(second.id, { targetId:first.id, placement:'before', day:monday });
  const input = body(5, 'Move agenda before proofread');
  const answer = await h.command(input);
  assert.deepEqual([answer.kind, answer.action, answer.taskIds], ['applied', 'order', [second.id]]);
  assert.match(answer.message, /Agenda.*before.*Proofread/);
  const geometry = service => service.data.tasks.map(({id,start,end}) => [id,start,end]);
  assert.deepEqual(geometry(h.service), geometry(viaGrip.service));
  assert.deepEqual([second.start, first.start, fixed.start, tomorrow.start], [at(monday,'09:00'), at(monday,'09:15'), at(monday,'10:00'), at(tuesday,'09:00')]);
  const restart = fixture(h.store.saved), before = geometry(restart.service);
  assert.deepEqual(await restart.command(input), answer);
  assert.equal((await restart.command(body(6, 'Move agenda after briefing'))).kind, 'no-match');
  assert.equal((await restart.command(body(7, 'Move agenda before materials'))).kind, 'no-match');
  assert.deepEqual(geometry(restart.service), before);
  assert.equal(restart.estimates, 0);
});

test('an ambiguous order destination stays bound to its original source, even if another task adopts that source title', async () => {
  const h = fixture();
  const source = await h.add(1, 'Prepare minutes for 10 minutes', 'Minutes');
  const first = await h.add(2, 'Review North outline', 'Outline');
  const second = await h.add(3, 'Review South outline', 'Outline');
  const spare = await h.add(4, 'Review permits', 'Permits');
  const input = body(5, 'Move minutes after outline');
  const choose = await h.command(input);
  assert.deepEqual([choose.kind, choose.choiceRole, choose.counterpartId], ['needs-choice', 'target', source.id]);
  assert.deepEqual(choose.candidates.map(t => t.id), [first.id,second.id]);
  const isolated = fixture(h.store.saved);
  const applied = await isolated.command({ ...input, chosenTaskId:second.id });
  assert.deepEqual([applied.kind, applied.action, applied.taskIds], ['applied','order',[source.id]]);
  assert.deepEqual(isolated.service.data.tasks.map(t => t.id), [first.id,second.id,source.id,spare.id]);
  await h.service.editTask(source.id, {title:'Filed record', text:'File the earlier record'});
  await h.service.editTask(spare.id, {title:'Minutes'});
  const order = h.service.data.tasks.map(t => t.id);
  const stale = await h.command({ ...input, chosenTaskId:second.id });
  assert.notEqual(stale.kind, 'applied');
  assert.deepEqual(h.service.data.tasks.map(t => t.id), order);
});
