import assert from 'node:assert/strict';
import test from 'node:test';
import { CATEGORIES, estimateTask, explicitStartFor, findSlot, planningRange, resizedClockWindow } from '../src/planner.mjs';

const settings = { timeZone: 'America/Los_Angeles', workDays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' };
const monday = '2026-11-23T08:00:00-08:00';
const estimate = (text, now = monday) => estimateTask(text, { now, timeZone: settings.timeZone });
const slot = (task, busy = [], now = monday, hours = settings) => findSlot({ task, settings: hours, busy, now });
const utcRange = (start, end) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });

test('consistent task categories have distinct Google Calendar colors', () => {
  assert.deepEqual(Object.fromEntries(CATEGORIES.map(item => [item.id, item.googleColorId])), {
    focus: '9', writing: '3', people: '2', admin: '6', personal: '4',
  });
  const examples = [
    ['Draft an email to Morgan', 'people'], ['Reply to the customer', 'people'],
    ['Draft a partner proposal', 'writing'], ['Prepare slides for the board meeting', 'writing'],
    ['Design the prototype', 'focus'], ['Review monthly invoices', 'admin'],
    ['Pick up the kids', 'personal'],
  ];
  for (const [text, category] of examples) assert.equal(estimate(text).category, category, text);
  assert.ok(estimate('Quickly skim the agenda').minutes < estimate('Research a complex project').minutes);
  assert.ok(estimate('Review 24 pages').minutes > estimate('Review the introduction').minutes);
});

test('explicit durations survive compound units, fractions, written numbers, and short forms', () => {
  for (const [text, minutes] of [
    ['Design for 1h30m', 90], ['Write for an hour and a half', 90],
    ['Check for one and a half hours', 90], ['Call for a quarter of an hour', 15],
    ['Review for two hours and twenty-five minutes', 145], ['Schedule a 45-minute interview', 45],
    ['Read for 1½ hours', 90], ['Prototype for 12 hours', 720], ['Call Ana for 7 min', 7],
  ]) {
    const task = estimate(text);
    assert.equal(task.minutes, minutes, text);
    assert.equal(task.explicitMinutes, true);
  }
  assert.equal(estimate('Call at 10 AM').explicitMinutes, false);
  assert.throws(() => estimate('Write for 0 minutes'), RangeError);
});

test('dates use the work time zone and distinguish appointments from deadlines', () => {
  const task = estimate('Draft for half an hour tomorrow afternoon', '2026-11-24T02:00Z'); // still Monday in Los Angeles
  assert.deepEqual([task.earliestDay, task.latestDay, task.windowStart, task.windowEnd],
    ['2026-11-24', '2026-11-24', '12:00', '17:00']);
  assert.equal(estimate('Call next Tuesday').earliestDay, '2026-12-01');
  assert.equal(estimate('Write on 2027-02-03').latestDay, '2027-02-03');
  assert.equal(estimate('File the report by Friday').earliestDay, null);
  assert.equal(estimate('File the report before Friday').latestDay, '2026-11-26');
  assert.equal(estimate('Review from Monday to Friday').earliestDay, '2026-11-23');
  assert.throws(() => estimate('Write on 2027-02-30'), RangeError);
});

test('a deadline clock limits only the due date, keeping the full preceding workday available', () => {
  for (const text of ['Send a 30 minute email by Tuesday at 10am', 'Send a 30 minute email by 10am Tuesday']) {
    const task = estimate(text);
    assert.equal(task.deadlineTime, '10:00', text);
    assert.equal(task.windowStart, null);
    assert.deepEqual(slot(task, [], '2026-11-23T16:30:00-08:00'), utcRange('2026-11-24T00:30Z', '2026-11-24T01:00Z'));
    assert.equal(slot(task, [], '2026-11-24T09:45:00-08:00'), null);
  }
});

test('the scheduler combines unordered, overlapping busy intervals and treats endpoints as half-open', () => {
  const busy = [
    utcRange('2026-11-23T18:00Z', '2026-11-23T18:35Z'),
    utcRange('2026-11-23T19:00Z', '2026-11-23T20:00Z'),
    utcRange('2026-11-23T17:00Z', '2026-11-23T18:10Z'),
  ];
  assert.deepEqual(slot({ minutes: 25 }, busy), utcRange('2026-11-23T18:35Z', '2026-11-23T19:00Z'));
  assert.deepEqual(slot({ minutes: 26 }, busy), utcRange('2026-11-23T20:00Z', '2026-11-23T20:26Z'));
  assert.deepEqual(slot({ minutes: 20 }, [], '2026-11-23T10:12:24-08:00'),
    utcRange('2026-11-23T18:15Z', '2026-11-23T18:35Z'));
  assert.equal(slot({ minutes: 25 }, [{ start: 'unavailable', end: '2026-11-23T20:00Z' }]), null);
});

test('respects the requested day, clock windows and full duration even when no slot exists', () => {
  const exact = estimate('Call tomorrow at 10:17 for 20 minutes');
  assert.deepEqual(slot(exact), utcRange('2026-11-24T18:17Z', '2026-11-24T18:37Z'));
  assert.equal(slot(exact, [utcRange('2026-11-24T18:30Z', '2026-11-24T19:00Z')]), null);
  assert.equal(slot(estimate('Write on Sunday morning for 2h')), null);
  assert.equal(slot(estimate('Research for 9h')), null);
  assert.equal(slot(estimate('Call today between 10 and 11 for 80 minutes')), null);
  assert.deepEqual(slot(estimate('Draft after 2pm for 35m')), utcRange('2026-11-23T22:00Z', '2026-11-23T22:35Z'));
  assert.equal(slot(estimate('Work on 2026-10-01')), null);
});

test('the free/busy query covers explicit future dates beyond the default horizon', () => {
  const task = estimate('Call on Jan 15, 2027 for 15m');
  assert.deepEqual(planningRange({ task, settings, now: monday }), utcRange('2027-01-15T08:00Z', '2027-01-16T08:00Z'));
  const allDay = [utcRange('2027-01-15T08:00Z', '2027-01-16T08:00Z')];
  assert.equal(slot(task, allDay), null);
  assert.deepEqual(slot(task), utcRange('2027-01-15T17:00Z', '2027-01-15T17:15Z'));
  assert.equal(planningRange({ task: estimate('Write on 2030-01-01'), settings, now: monday }), null);
});

test('identifies an exact clock from original wording independently of a title or model window', () => {
  const pin = text => explicitStartFor({ text, title: 'A call at 3pm', windowStart: '15:00', windowEnd: '15:30' }, settings.timeZone);
  for (const text of ['Discuss the launch at 10:15', '10:15 for 30 min', 'Review notes: 30 min starting at 10:15',
    'Design review tomorrow, 10:15', 'Besprechung um 10.15 Uhr', 'Session starts at 10:15 until 12:00']) {
    assert.equal(pin(text), '10:15', text);
  }
  for (const text of ['Review the hiring plan', 'File by Friday at 10:15', 'File by Tuesday 10:15',
    'Deadline at 10:15', 'Send before the team meeting at 10:15', 'After 10:15', 'By 10:15 tomorrow',
    'Between 10:15 and 11', 'From 10:15 to 12', 'Read 10:15–11:00', 'Call at 10:15 or later',
    'Call at 10:15 or 11:30', 'Review around 10:15', 'Meet at 10:15 if possible',
    'Check the 1:1 channel', 'Review v10.15 on 2027-10-15', 'Look at 10 slides', 'Check the ratio of 10:15',
    'Look at 10-15 tickets', 'Call on 10/15', 'Bis Dienstag um 10:15 Uhr']) {
    assert.equal(pin(text), null, text);
  }
  const german = estimate('Besprechung morgen um 10:15 Uhr für 20 Minuten');
  assert.deepEqual([german.earliestDay, german.windowStart, german.windowEnd, german.minutes],
    ['2026-11-24', '10:15', '10:35', 20]);
  assert.equal(explicitStartFor({ text: 'Call at 09:00, send the recap by Friday at 10:15' }, settings.timeZone), '09:00');
});

test('an exact source clock overrides stale model windows, respects real bounds and never slides after a conflict', () => {
  const task = { ...estimate('10:17 today for 30 minutes'), windowStart: '13:00', windowEnd: '17:00' };
  const expected = utcRange('2026-11-23T18:17Z', '2026-11-23T18:47Z');
  assert.deepEqual(slot(task), expected);
  assert.deepEqual(slot(task, [utcRange('2026-11-23T17:00Z', expected.start), utcRange(expected.end, '2026-11-23T21:00Z')]), expected);
  assert.equal(slot(task, [utcRange('2026-11-23T18:20Z', '2026-11-23T18:21Z')]), null);
  assert.equal(slot(task, [], monday, { ...settings, startTime: '10:18' }), null);
  assert.equal(slot(task, [], '2026-11-23T10:18:00-08:00'), null);
  const longer = { ...task, minutes: 55 };
  assert.equal(resizedClockWindow(task, 55, settings.timeZone), '11:12');
  assert.deepEqual(slot(longer), utcRange(expected.start, '2026-11-23T19:12Z'));
  const capped = { ...longer, text: 'Review at 10:17, finish by 11:00' };
  assert.equal(resizedClockWindow(capped, 55, settings.timeZone), '11:00');
  assert.equal(slot(capped), null);
  const undated = { ...estimate('Call at 10:17 for 30 min'), windowEnd: '17:00' };
  assert.deepEqual(slot(undated, [], '2026-11-23T10:18:00-08:00'),
    utcRange('2026-11-24T18:17Z', '2026-11-24T18:47Z'));
});

test('queue catch-up only permits an active exact appointment captured no later than its start', () => {
  const task = { ...estimate('Office hours today at 10:15 for 30 min'), createdAt: '2026-11-23T18:14Z' };
  const now = '2026-11-23T18:25Z';
  const check = (candidate, overrides = {}) => findSlot({ task: candidate, now, settings, allowInProgress: true, ...overrides });
  const expected = utcRange('2026-11-23T18:15Z', '2026-11-23T18:45Z');
  assert.deepEqual(check(task), expected);
  assert.deepEqual(check({ ...task, createdAt: expected.start }), expected);
  assert.equal(check(task, { allowInProgress: false }), null);
  assert.equal(check(task, { now: expected.end }), null);
  assert.equal(check(task, { busy: [utcRange('2026-11-23T18:17Z', '2026-11-23T18:18Z')] }), null);
  assert.equal(check({ ...task, createdAt: null }), null);
  assert.equal(check({ ...task, estimateRequestedAt: '2026-11-23T18:16Z' }), null);
  assert.equal(check({ ...task, text: 'Process forms' }), null);
});

test('exact clocks survive DST folds, reject missing starts and use elapsed duration across the gap', () => {
  const hours = { ...settings, workDays: [7], startTime: '00:00', endTime: '05:00' };
  const spring = '2026-03-08T08:00Z';
  assert.equal(slot(estimate('Class today at 02:15 for 30 min', spring), [], spring, hours), null);
  assert.deepEqual(slot(estimate('Class today at 01:45 for 30 min', spring), [], spring, hours),
    utcRange('2026-03-08T09:45Z', '2026-03-08T10:15Z'));
  const autumn = '2026-11-01T07:00Z';
  const repeated = estimate('Class today at 01:17 for 15 min', autumn);
  const first = utcRange('2026-11-01T08:17Z', '2026-11-01T08:32Z');
  assert.deepEqual(slot(repeated, [], autumn, hours), first);
  assert.deepEqual(slot(repeated, [first], autumn, hours), utcRange('2026-11-01T09:17Z', '2026-11-01T09:32Z'));
});

test('spring daylight saving time preserves elapsed task duration and excludes nonexistent hours', () => {
  const hours = { ...settings, workDays: [7], startTime: '01:30', endTime: '04:00' };
  const now = '2026-03-08T08:00Z';
  const task = { minutes: 90, earliestDay: '2026-03-08', latestDay: '2026-03-08' };
  assert.deepEqual(planningRange({ task, settings: hours, now }), utcRange('2026-03-08T08:00Z', '2026-03-09T07:00Z'));
  assert.deepEqual(slot(task, [], now, hours), utcRange('2026-03-08T09:30Z', '2026-03-08T11:00Z'));
  assert.equal(slot({ ...task, minutes: 91 }, [], now, hours), null);
  assert.equal(slot({ ...task, minutes: 10 }, [], now, { ...hours, startTime: '02:00', endTime: '02:30' }), null);
});

test('the repeated hour in autumn offers two separate copies of a narrow work window', () => {
  const hours = { ...settings, workDays: [7], startTime: '01:10', endTime: '01:50' };
  const now = '2026-11-01T07:00Z';
  const task = { minutes: 20, earliestDay: '2026-11-01', latestDay: '2026-11-01' };
  assert.deepEqual(slot(task, [], now, hours), utcRange('2026-11-01T08:10Z', '2026-11-01T08:30Z'));
  assert.deepEqual(slot(task, [utcRange('2026-11-01T08:00Z', '2026-11-01T09:00Z')], now, hours),
    utcRange('2026-11-01T09:10Z', '2026-11-01T09:30Z'));
  assert.equal(slot({ ...task, minutes: 50 }, [], now, hours), null);
});

test('a skipped local midnight never makes the scheduler search beyond the queried free/busy range', () => {
  const hours = { ...settings, timeZone: 'America/Santiago', workDays: [1, 2, 3, 4, 5, 6, 7] };
  // September 6 begins at 01:00, while September 7 begins at 00:00.
  const input = { task: { minutes: 20 }, settings: hours, now: '2026-09-06T04:00Z', horizonDays: 1 };
  const range = utcRange('2026-09-06T04:00Z', '2026-09-07T03:00Z');
  assert.deepEqual(planningRange(input), range);
  assert.equal(findSlot({ ...input, busy: [range] }), null);
});
