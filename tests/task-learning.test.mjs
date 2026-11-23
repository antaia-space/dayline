import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { estimateSchema, TaskAgents } from '../src/agents/manager.mjs';
import { makeEstimator } from '../src/estimate.mjs';
import { openStore } from '../src/store.mjs';
import { durationCalibration, durationNotes, localTaskTitle, recordDurationFeedback, verifiedTaskTitle } from '../src/task-learning.mjs';

const context = { now: new Date('2026-11-23T17:00:00Z'), timeZone: 'America/Los_Angeles' };
const modelSelection = { provider: 'codex', model: 'fixture-model', effort: 'low' };
const base = { category: 'writing', minutes: 30, reason: 'One drafting pass.', earliestDay: null, latestDay: null,
  windowStart: null, windowEnd: null, deadlineTime: null };
const task = (id, text, minutes = 30) => ({ id, text, category: 'writing', minutes });
function edit(state, before, minutes) {
  const after = { ...before, minutes };
  assert.equal(recordDurationFeedback(state, before, after), true);
  return after;
}

test('local titles retain named people, brands, qualifiers and the original language without any provider', () => {
  assert.equal(localTaskTitle('Please add Rowan to google workspace, GitLab, and GitLab.'), 'Add Rowan to Google Workspace and GitLab');
  assert.equal(localTaskTitle('I have to clean out Robin from the staging workspace only.'), 'Remove Robin from the staging workspace only');
  assert.equal(localTaskTitle('Would you please buy paint, brushes and paint?'), 'Buy paint and brushes');
  assert.equal(localTaskTitle('I need to clean out the garage.'), 'Clean out the garage');
  assert.equal(localTaskTitle('Tengo que llamar a Lucía sobre la versión de prueba.'), 'Llamar a Lucía sobre la versión de prueba');
  assert.equal(localTaskTitle('J’ai besoin d’appeler Océane demain.'), 'Appeler Océane demain');
  assert.equal(localTaskTitle('Bitte den Zugang für Maja prüfen.'), 'Den Zugang für Maja prüfen');
  assert.equal(localTaskTitle('確認する項目を田中さんに送る'), '確認する項目を田中さんに送る');
  assert.equal(localTaskTitle('iOS release notes'), 'iOS release notes');
  assert.equal(localTaskTitle('npm audit'), 'npm audit');
  assert.ok([...localTaskTitle('Summarize ' + 'the onboarding checklist '.repeat(12))].length <= 120);
});

test('unmentioned names, omitted named participants, and clear language changes use the faithful local title', () => {
  const note = 'I need to write the follow-up for Lena.';
  assert.equal(verifiedTaskTitle('Draft Lena’s follow-up', note), 'Draft Lena’s follow-up');
  assert.equal(verifiedTaskTitle('Draft Leo’s follow-up', note), 'Write the follow-up for Lena');
  assert.equal(verifiedTaskTitle('Draft the follow-up', note), 'Write the follow-up for Lena');
  assert.equal(verifiedTaskTitle('Draft 12 follow-ups for Lena', note), 'Write the follow-up for Lena');
  assert.equal(verifiedTaskTitle('Archive staging reports', 'Archive only staging reports'), 'Archive only staging reports');
  assert.equal(verifiedTaskTitle('Archive production reports', 'Archive staging reports'), 'Archive staging reports');
  assert.equal(verifiedTaskTitle('Read the invoices', 'Read 12 invoices'), 'Read 12 invoices');
  assert.equal(verifiedTaskTitle('Call Inés', 'Necesito llamar a Inés.'), 'Llamar a Inés');
  assert.equal(verifiedTaskTitle('Send the notes', '会議のメモを送る'), '会議のメモを送る');
});

test('each task contributes one correction, keeps its initial baseline, and can undo its own profile note', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dayline-duration-note-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  const reference = task('private-id-a', 'Draft a note for PrivatePartner about the spring campaign');
  let adjusted = edit(store.state, reference, 35);
  adjusted = edit(store.state, adjusted, 40);
  assert.deepEqual([adjusted.baseMinutes, adjusted.estimatedMinutes], [30, 30]);
  assert.equal(store.state.durationLearning.examples.length, 1);
  assert.deepEqual(durationNotes(store.state), ['Your edits to writing suggest 10 minutes longer (1 task).']);
  assert.deepEqual(store.state.durationLearning.notes, durationNotes(store.state));
  assert.doesNotMatch(JSON.stringify(store.state.durationLearning), /PrivatePartner|spring campaign/);
  store.save();
  const restored = openStore(dir).state;
  assert.equal(durationCalibration(restored, 'Write an update', 'writing').changeMinutes, 10);
  assert.equal(durationCalibration(restored, 'Write an update', 'writing', reference.id), null);
  assert.equal(durationCalibration(restored, 'Debug the parser', 'focus'), null);
  adjusted = edit(restored, adjusted, 25);
  assert.equal(durationCalibration(restored, 'Draft a review', 'writing').changeMinutes, -5);
  edit(restored, adjusted, 30);
  assert.deepEqual(durationNotes(restored), []);
  assert.equal(durationCalibration(restored, 'Draft a review', 'writing'), null);
});

test('compares corrections to raw baselines and removes feedback when a personalized suggestion is restored', () => {
  const state = {};
  edit(state, task('a', 'Write a newsletter'), 35);
  const shown = { ...task('b', 'Draft a post', 35), baseMinutes: 30, estimatedMinutes: 35 };
  const revised = edit(state, shown, 40);
  assert.equal(state.durationLearning.examples.at(-1).baseMinutes, 30);
  assert.equal(durationCalibration(state, 'Draft the agenda', 'writing').changeMinutes, 10);
  edit(state, revised, 35);
  assert.equal(state.durationLearning.examples.length, 1);
  assert.equal(durationCalibration(state, 'Draft the agenda', 'writing').changeMinutes, 5);
  const large = edit(state, task('long-task', 'Draft a book', 2000), 2005);
  assert.equal(large.baseMinutes, 2000);
  assert.equal(state.durationLearning.examples.at(-1).correctedMinutes, 2005);
  edit(state, large, 2000);
  assert.equal(state.durationLearning.examples.length, 1);
});

test('generic actions match locally without storing the action or another task’s text', () => {
  const state = {};
  edit(state, { ...task('a', 'Index a private archive'), category: 'focus' }, 25);
  assert.equal(durationCalibration(state, 'Index a second document', 'focus').changeMinutes, -5);
  assert.equal(durationCalibration(state, 'Polish a second document', 'focus'), null);
  assert.doesNotMatch(JSON.stringify(state.durationLearning), /index|private|archive/i);
});

test('matches the primary activity when instructions mention several kinds of work', () => {
  const state = {};
  edit(state, task('mail', 'Draft an email that lists invoices'), 35);
  assert.equal(durationCalibration(state, 'Email the new team', 'people').changeMinutes, 5);
  assert.equal(durationCalibration(state, 'Draft a training manual', 'writing'), null);
  assert.equal(durationCalibration(state, 'Review invoices and email the team', 'admin'), null);
  edit(state, task('invoice', 'Review the monthly invoices and email the team'), 25);
  assert.equal(durationCalibration(state, 'Submit receipts', 'admin').changeMinutes, -5);
});

test('one subscription call produces an action title and baseline; only abstract history reaches the provider', async () => {
  const calls = [];
  const state = { settings: { workDays: [6], startTime: '10:00', endTime: '18:00' }, agent: { provider: 'local' } };
  edit(state, task('private-sample', 'Write a confidential memo for The Other Team'), 35);
  const engine = new TaskAgents({ store: { state, save() {} }, adapters: { codex: {
    async estimate(request) { calls.push(request); return { model: request.model, effort: 'low', output: { ...base, title: 'Draft Ana’s update' } }; }
  } } });
  const now = { ...context, selection: modelSelection, taskId: 'current', workHours: { workDays: [1], startTime: '08:00', endTime: '16:00' } };
  const result = await engine.estimate('I need to write an update for Ana at 3pm.', now);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, modelSelection.model);
  assert.equal(calls[0].schema, estimateSchema);
  assert.ok(calls[0].schema.required.includes('title'));
  assert.deepEqual(calls[0].input.durationHistory, { activity: 'writing', sampleCount: 1 });
  assert.doesNotMatch(JSON.stringify(calls[0].input), /confidential|Other Team|private-sample|changeMinutes|correctedMinutes/);
  assert.deepEqual([calls[0].input.workDays, calls[0].input.startTime, calls[0].input.endTime], [[1], '08:00', '16:00']);
  assert.deepEqual([result.title, result.baseMinutes, result.estimatedMinutes, result.minutes, result.windowEnd], ['Draft Ana’s update', 30, 35, 35, '15:35']);
  assert.equal(state.agent.lastRun, undefined);
  const explicit = await engine.estimate('Write an update for Ana at 3pm for 12 minutes.', now);
  assert.deepEqual([explicit.minutes, explicit.baseMinutes, explicit.windowEnd], [12, 12, '15:12']);
  assert.ok(!Object.hasOwn(calls[1].input, 'durationHistory'));
  const same = await engine.estimate('Draft an update for Ana', { ...now, taskId: 'private-sample' });
  assert.equal(same.minutes, 30);
  assert.equal(calls.length, 3);
});

test('local estimates personalize in both directions and older adapters still supply valid estimates', async () => {
  const state = { settings: { workDays: [1], startTime: '09:00', endTime: '17:00' }, agent: { provider: 'local' } };
  const cases = [{ ...base }, { ...base, title: 'a\nsecond line' }, { ...base, title: ' ' }, { ...base, title: 'a'.repeat(121) }];
  const engine = new TaskAgents({ store: { state, save() {} }, adapters: { codex: { estimate: async () => ({ model: modelSelection.model, effort: 'low', output: cases.shift() }) } } });
  edit(state, task('a', 'Write a short memo'), 25);
  const local = await engine.estimate('Please draft the weekly notes at 3pm.', context);
  assert.deepEqual([local.title, local.baseMinutes, local.minutes, local.windowEnd], ['Draft the weekly notes at 3pm', 60, 55, '15:55']);
  for (const outcome of ['success', 'pending', 'pending', 'pending']) {
    const value = await engine.estimate('Please draft the weekly notes.', { ...context, selection: modelSelection });
    assert.equal(value.agent.outcome, outcome);
    assert.equal(value.title, 'Draft the weekly notes');
    if (outcome === 'pending') assert.equal(value.baseMinutes, undefined);
  }
});

test('Apple’s helper title and its legacy fallback share the same local validation without a model call', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dayline-title-helper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = path.join(root, 'estimator');
  const input = 'Please draft the minutes for Liam.';
  for (const [title, expected] of [['Draft Liam’s minutes', 'Draft Liam’s minutes'], [undefined, 'Draft the minutes for Liam']]) {
    await writeFile(helper, '#!' + process.execPath + '\nprocess.stdin.resume(); process.stdin.on("end", () => console.log(' +
      JSON.stringify(JSON.stringify({ category: 'writing', minutes: 35, reason: 'Minutes need editing.', title })) + '));', { mode: 0o700 });
    const result = await makeEstimator(helper)(input, context);
    assert.equal(result.engine, 'apple');
    assert.equal(result.title, expected);
  }
});
