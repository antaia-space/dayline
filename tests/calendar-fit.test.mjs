import test from 'node:test';
import assert from 'node:assert/strict';
import { canFitDuration, fullTaskMinutes, shorterDurations } from '../src/calendar-fit.mjs';
import { setManualDuration } from '../src/duration.mjs';
import { recordDurationFeedback } from '../src/task-learning.mjs';

const item = { id:'a', text:'Outline the review', category:'writing', minutes:30, createdAt:'2026-11-23T08:00:00Z' };

test('calendar fitting is bounded against the original estimate and excludes explicit or manually locked work', () => {
  assert.ok(canFitDuration(item,'UTC'));
  assert.deepEqual(shorterDurations(item),[29,28,27,26,25,24,23]);
  assert.deepEqual(shorterDurations({...item,minutes:23,calendarFit:{originalMinutes:30}}),shorterDurations(item));
  assert.equal(shorterDurations({...item,minutes:120}).at(-1),105);
  assert.deepEqual(shorterDurations({...item,minutes:5}),[]);
  assert.equal(fullTaskMinutes({...item,minutes:25,calendarFit:{originalMinutes:30}}),30);
  for (const patch of [{text:'Write for half an hour'},{text:'Write at 10:20'},{estimateOverrides:{minutes:30}},
    {reason:'Duration set by you.'},{done:true},{remote:{manualTime:true}},{remote:{allDay:{}}}]) {
    assert.equal(canFitDuration({...item,...patch},'UTC'), false);
  }
});

test('a user duration change locks the chosen value, while calendar adjustments never become training examples', () => {
  const before = {...item,minutes:22,calendarProgressMinutes:4,calendarFit:{originalMinutes:26},estimatedMinutes:30,baseMinutes:30,dirty:{}};
  const after=structuredClone(before);
  setManualDuration(after,27,'UTC');
  assert.equal(after.calendarFit,undefined);
  assert.equal(canFitDuration(after,'UTC'),false);
  const state={};
  recordDurationFeedback(state,before,after);
  assert.equal(state.durationLearning.examples[0].correctedMinutes,31);
  assert.equal(state.durationLearning.examples[0].estimatedMinutes,30);
  const undo=structuredClone(after);
  setManualDuration(undo,26,'UTC');
  recordDurationFeedback(state,after,undo);
  assert.deepEqual(state.durationLearning.examples,[]);
  const locked=structuredClone(before);
  setManualDuration(locked,22,'UTC');
  assert.equal(locked.reason,'Duration set by you.');
  assert.equal(locked.calendarFit,undefined);
});
