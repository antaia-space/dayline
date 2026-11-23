import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlannerCommand } from '../src/planner-commands.mjs';
import { createSlotSearch, explicitStartFor, findSlot } from '../src/planner.mjs';
import { planTaskSlots } from '../src/priority.mjs';

const now = new Date('2026-11-24T00:25:00Z'); // Monday in Los Angeles.
const timeZone = 'America/Los_Angeles';
const task = (id, title, additional = {}) => ({ id, title, text: title, minutes: 30, createdAt: '2026-11-20T16:00:00Z',
  start: '2026-11-24T17:00:00.000Z', end: '2026-11-24T17:30:00.000Z', done: false, ...additional });
const vercel = task('deployment', 'Clean up manual Vercel tasks');
const parse = (text, tasks = [vercel], extra = {}) => parsePlannerCommand(text, { tasks, now, timeZone, ...extra });
const result = (action, changes, taskIds = ['deployment']) => ({ kind: 'command', action, taskIds, changes });

test('planner instructions select existing titles and resolve dates from the capture time in the planning zone', () => {
  const tasks = [structuredClone(vercel)];
  const before = structuredClone(tasks);
  for (const [text, changes] of [
    ['move the clean up Vercel task to Wednesday', { day: '2026-11-25' }],
    ['push the Vercel cleanup back to next Friday', { day: '2026-12-04' }],
    ['Can we move the Vercel cleanup to Wednesday at 2pm?', { day: '2026-11-25', time: '14:00' }],
    ['Could you please move the Vercel cleanup to 2pm on Wednesday?', { day: '2026-11-25', time: '14:00' }],
    ['Move Vercel to 2pm', { day: '2026-11-24', time: '14:00' }],
    ['Move Vercel to tomorrow', { day: '2026-11-24' }],
    ['Move Vercel on December 3 at noon', { day: '2026-12-03', time: '12:00' }],
    ['Reschedule Vercel to 2026-12-15', { day: '2026-12-15' }],
  ]) assert.deepEqual(parse(text, tasks), result('move', changes), text);
  assert.deepEqual(tasks, before);
});

test('new physical work and ordinary dated notes pass through to capture', () => {
  for (const text of ['move office furniture to storage', 'move office furniture to storage on Wednesday',
    'draft memo Wednesday', 'Prepare a plan to move workloads to storage', 'Design a dashboard for Friday']) {
    assert.deepEqual(parse(text), { kind: 'create' }, text);
  }
});

test('a missing or ambiguous planner target never becomes a new task or silently selects the first match', () => {
  const tasks = [vercel, task('launch', 'Launch Vercel preview')];
  const choices = parse('Move Vercel to Wednesday', tasks);
  assert.equal(choices.reason, 'ambiguous');
  assert.deepEqual(choices.candidates, tasks.map(({ id, title }) => ({ id, title })));
  assert.deepEqual(parse('Move Vercel to Wednesday', tasks, { chosenTaskId: 'launch' }), result('move', { day: '2026-11-25' }, ['launch']));
  assert.equal(parse('Move Vercel to Wednesday', tasks, { selectedTaskId: 'another' }).reason, 'stale-selection');
  assert.equal(parse('Move Vercel to Wednesday', [vercel], { selectedTaskId: 'launch' }).reason, 'stale-selection');
  assert.equal(parse('Move the missing audit task to Wednesday').reason, 'unmatched');
  assert.equal(parse('Move the task to Wednesday').reason, 'missing-target');
  for (const text of ['Move Vercel to 2026-02-31', 'Move Vercel to Wednesday afternoon', 'Move Vercel to 25:90', 'Move Vercel to Friday or to Wednesday']) {
    assert.equal(parse(text).reason, 'invalid-date', text);
  }
  assert.equal(parse('Move Vercel before the design review').reason, 'unmatched');
});

test('exact titles outrank a more verbose match, and the original wording can identify a renamed task', () => {
  const renamed = task('renamed', 'Prepare the deployment', { text: 'Audit the unique platform logs' });
  const short = task('short', 'Vercel cleanup');
  assert.deepEqual(parse('move the clean up Vercel task to Wednesday', [vercel, short]), result('move', { day: '2026-11-25' }, ['short']));
  assert.deepEqual(parse('mark the platform logs done', [renamed]), result('complete', { done: true }, ['renamed']));
  assert.deepEqual(parse('move Task A to Friday', [task('a', 'Task A'), task('b', 'Task B')]), result('move', { day: '2026-11-27' }, ['a']));
});

test('duration, completion, reopening and renaming use explicit changes without rewriting original notes', () => {
  for (const [text, action, changes] of [
    ['Give Vercel 10 more minutes', 'duration', { deltaMinutes: 10 }],
    ['Give the Vercel task five fewer minutes', 'duration', { deltaMinutes: -5 }],
    ['Add 5 minutes to Vercel', 'duration', { deltaMinutes: 5 }],
    ['Shorten Vercel by a quarter of an hour', 'duration', { deltaMinutes: -15 }],
    ['Set Vercel to 45 minutes', 'duration', { minutes: 45 }],
    ['Set the duration of Vercel to an hour and a half', 'duration', { minutes: 90 }],
    ['Mark Vercel done', 'complete', { done: true }],
    ['Check off Vercel', 'complete', { done: true }],
    ['Reopen Vercel', 'reopen', { done: false }],
    ['Rename Vercel to “Polish deployment”', 'rename', { title: 'Polish deployment' }],
  ]) assert.deepEqual(parse(text), result(action, changes), text);
  assert.equal(parse('Set Vercel to 0 minutes').reason, 'invalid-duration');
  assert.equal(parse('Shorten Vercel by 45 minutes').reason, 'invalid-duration');
  const to = task('memo', 'Notes to the board');
  assert.deepEqual(parse('rename “Notes to the board” to “What to do next”', [to]), result('rename', { title: 'What to do next' }, ['memo']));
});

test('explicit bulk moves select only unfinished editable tasks on the named source day', () => {
  const second = task('slides', 'Draft slides', { start: null, end: null, estimateOverrides: { day: '2026-11-24' } });
  const protectedRows = [task('meeting', 'Vercel standup', { remote: { calendarAppointment: true } }),
    task('manual', 'Personal Google appointment', { remote: { manualTime: true } }), task('all-day', 'All day', { remote: { allDay: true } }),
    task('done', 'A completed task', { done: true }), task('held', 'Held', { held: true }), task('unconfirmed', 'Unconfirmed write', { intent: {} }),
    task('later', 'Review a different day', { start: '2026-11-25T17:00:00Z' })];
  const tasks = [vercel, ...protectedRows, second];
  assert.deepEqual(parse('Move all my unfinished tasks from Tuesday to Friday', tasks),
    result('move', { day: '2026-11-27' }, ['deployment', 'slides']));
  assert.equal(parse('Move my Vercel standup to Thursday', tasks).reason, 'protected');
  assert.equal(parse('Move all my unfinished tasks from Thursday to Friday', tasks).reason, 'unmatched');
  assert.equal(parse('Move all my unfinished tasks from Tuesday to Friday at 2pm', tasks).reason, 'invalid-date');
  assert.equal(parse('Move all my unfinished tasks from Tuesday to Friday', tasks, { chosenTaskId: 'deployment' }).reason, 'stale-selection');
});

test('a command clock overrides earlier wording, distinguishes cached trials and never backdates before the command', () => {
  const settings = { timeZone: 'UTC', workDays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' };
  const day = '2026-11-25', at = clock => day + 'T' + clock + ':00.000Z';
  const original = { ...task('memo', 'Draft a memo at 9am'), start: null, end: null, earliestDay: day, latestDay: day };
  const amended = { ...original, estimateOverrides: { time: '14:00' }, commandMovedAt: at('12:00') };
  const search = createSlotSearch(settings), current = new Date(at('08:00'));
  assert.equal(search({ task: original, now: current }).start, at('09:00'));
  assert.equal(explicitStartFor(amended, 'UTC'), '14:00');
  assert.equal(search({ task: amended, now: current }).start, at('14:00'));
  assert.equal(findSlot({ task: { ...amended, commandMovedAt: at('14:05') }, settings, now: new Date(at('14:06')), allowInProgress: true }), null);
  const flex = { ...amended, text: 'Draft a memo', estimateOverrides: {}, commandMovedAt: at('12:05') };
  const { placements } = planTaskSlots({ tasks: [flex], settings, now: new Date(at('12:06')), busy: [{ start: at('11:30'), end: at('12:00') }] });
  assert.equal(placements.get('memo').start, at('12:06'));
});

test('relative order resolves both flexible tasks on their scheduled day or in Unscheduled', () => {
  const budget = task('budget', 'Review the budget');
  const tasks = [vercel, budget];
  for (const [text, placement] of [
    ['Move the Vercel cleanup before the budget review', 'before'],
    ['Could you put Vercel right after the budget?', 'after'],
    ['Prioritize Vercel ahead of the budget', 'before'],
    ['Place Vercel behind the budget review', 'after'],
  ]) assert.deepEqual(parse(text, tasks), result('order', { targetId: 'budget', placement }), text);
  const unscheduled = tasks.map((t, i) => ({ ...t, start: null, end: null, estimateOverrides: { day: i ? '2026-11-25' : '2026-11-26' } }));
  assert.deepEqual(parse('Move Vercel after budget', unscheduled), result('order', { targetId: 'budget', placement: 'after' }));
  assert.equal(parse('Move Vercel before budget', [vercel, unscheduled[1]]).reason, 'invalid-order');
  assert.equal(parse('Move Vercel before budget', [vercel, { ...budget, start: '2026-11-25T17:00:00Z' }]).reason, 'invalid-order');
  assert.equal(parse('Move Vercel before Vercel', tasks).reason, 'invalid-order');
  for (const protectedRow of [{ done: true }, { pendingEstimate: true }, { remote: { calendarAppointment: true } },
    { text: 'Review the budget at 11am' }, { end: '2026-11-23T18:00:00Z' }]) {
    assert.equal(parse('Move Vercel before budget', [vercel, { ...budget, ...protectedRow }]).reason, 'protected');
  }
  assert.equal(parse('Move Vercel before noon', tasks).reason, 'syntax');
  assert.deepEqual(parse('Move the Vercel task to day after tomorrow', tasks), result('move', { day: '2026-11-25' }));
  assert.deepEqual(parse('Put office furniture behind the door', tasks), { kind: 'create' });
  const session = task('session', 'Follow up after demo');
  assert.deepEqual(parse('Move “Follow up after demo” before budget', [session, budget]),
    result('order', { targetId: 'budget', placement: 'before' }, ['session']));
});

test('a single order choice resolves its original role and rechecks the opposite task identity', () => {
  const first = task('one', 'Design review'), second = task('two', 'Design notes'), tasks = [vercel, first, second];
  for (const [text, role, source, target] of [
    ['Move design after Vercel', 'source', 'two', 'deployment'],
    ['Move Vercel after design', 'target', 'deployment', 'two'],
  ]) {
    const choice = parse(text, tasks);
    assert.equal(choice.reason, 'ambiguous');
    assert.equal(choice.choiceRole, role);
    assert.equal(choice.counterpartId, 'deployment');
    assert.deepEqual(choice.candidates.map(item => item.id), ['one', 'two']);
    const selection = { chosenTaskId: 'two', choiceRole: role, counterpartId: choice.counterpartId };
    assert.deepEqual(parse(text, tasks, selection), result('order', { targetId: target, placement: 'after' }, [source]));
    assert.equal(parse(text, [{ ...vercel, id: 'replacement' }, first, second], selection).reason, 'stale-selection');
    assert.equal(parse(text, [vercel, first], selection).reason, 'stale-selection');
    assert.equal(parse(text, tasks, { ...selection, chosenTaskId: 'deployment' }).reason, 'stale-selection');
  }
  const both = parse('Move design before Vercel', [...tasks, task('launch', 'Launch Vercel preview')]);
  assert.equal(both.reason, 'ambiguous');
  assert.deepEqual(both.candidates, []);
  assert.equal(parse('Prioritize unknown ahead of Vercel', tasks).reason, 'unmatched');
});

test('a transposed presentation name, a work abbreviation, and an informal action identify the same task on the viewed day', () => {
  const presentation = task('investment-deck', 'Fill out IC presentation with all details and compare with Philip', {
    text:'Fill out the IC presentation with all details and compare with Philip.',
    subtasks:[{title:'Fill out the IC presentation with all details'},{title:'Compare supporting forecasts with Philip'}] });
  const unrelated = task('shipping', 'Carry supplies');
  const context = { contextDay:'2026-11-24' };
  for (const name of ['Ic presnetation preparation', 'IC slide deck prep', 'Investment committee deck prep',
    'IC presentation', 'I.C. slides', 'Philip’s supporting forecasts', 'Philip forecast comparison']) {
    assert.deepEqual(parse('Move the ' + name + ' to today', [unrelated,presentation], context),
      result('move', {day:'2026-11-23'}, [presentation.id]), name);
  }
  const expanded = task('expanded', 'Fill out the investment committee presentation with Philip');
  assert.deepEqual(parse('Move IC deck prep to today', [unrelated,expanded], context),
    result('move', {day:'2026-11-23'}, [expanded.id]));
  for (const name of ['IC presnetation for Sarah', 'payroll preparation', 'task', 'IC presentation preparation']) {
    const list = name === 'IC presentation preparation' ? [task('false-acronym','Invoice cleanup presentation')] :
      name === 'IC presnetation for Sarah' ? [presentation] : [unrelated];
    assert.equal(parse('Move the ' + name + ' to today', list, context).kind, 'clarify', name);
  }
});

test('the viewed date orders plausible choices, preserves off-day targets and yields to an explicit source day', () => {
  const tuesday = task('tue', 'Fill out IC presentation with Philip');
  const thursday = task('thu', 'Revise the IC slide deck with Tracy', {start:'2026-11-26T17:00:00Z',end:'2026-11-26T17:30:00Z'});
  const unrelated = task('other','Print tickets');
  const context = {contextDay:'2026-11-24'};
  const choice = parse('Move IC presnetation preparation to today', [thursday,unrelated,tuesday], context);
  assert.deepEqual(choice.candidates.map(t => t.id), [tuesday.id,thursday.id]);
  assert.deepEqual(parse('Move IC slides with Tracy to today', [thursday,unrelated,tuesday], context),
    result('move', {day:'2026-11-23'}, [thursday.id]));
  assert.deepEqual(parse('Move IC deck prep from Thursday to today', [thursday,unrelated,tuesday], context),
    result('move', {day:'2026-11-23'}, [thursday.id]));
  const budget = task('budget','Collect the budget figures');
  assert.equal(parse('Move budget preparation to today', [budget], {contextDay:'2026-11-26'}).reason, 'unmatched');
  assert.deepEqual(parse('Move budget preparation to today', [budget], context), result('move', {day:'2026-11-23'}, [budget.id]));
});
