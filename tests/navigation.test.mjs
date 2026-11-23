import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationLabel, zonedDay } from '../web/ui.js';

test('agenda navigation labels the selected date relative to today in the planner time zone', () => {
  const today = zonedDay('2026-03-08T06:30:00Z', 'America/Los_Angeles');
  assert.equal(today, '2026-03-07');
  for (const [day, label] of [
    ['2026-03-06','Yesterday'], ['2026-03-07','Today'], ['2026-03-08','Tomorrow'], ['2026-03-09','In 2 days'],
    ['2026-03-05','2 days ago']
  ]) assert.equal(navigationLabel(day,today,'day'), label);
});

test('week navigation follows Monday boundaries across years', () => {
  const today = '2026-12-31';
  for (const [day, label] of [
    ['2027-01-03','This week'], ['2027-01-04','Next week'], ['2026-12-27','Last week'], ['2027-01-11','In 2 weeks']
  ]) assert.equal(navigationLabel(day,today,'week'), label);
});
