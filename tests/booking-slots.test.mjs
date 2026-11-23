// Ported one for one from antaia-space/meet test/slots.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSlots, zonedParts, zonedToUtcMs } from '../src/booking-slots.mjs';

const LA = 'America/Los_Angeles';
const HOUR = 3_600_000;

const base = {
  slug: 'meeting', title: 'Meeting', description: '', durationMin: 30, slotStepMin: 30, bufferMin: 0,
  minNoticeMin: 0, maxDaysAhead: 60, hours: { fri: [{ start: '09:00', end: '11:00' }] }, dateOverrides: {},
};

// Friday 20 November 2026, a winter-time day in Los Angeles (UTC-8).
const friday = (hour, minute = 0) => zonedToUtcMs(2026, 11, 20, hour, minute, LA);
const dayStart = friday(0);
const dayEnd = dayStart + 24 * HOUR;
const longBefore = dayStart - 10 * 24 * HOUR;

function slotsOn(type, busy = [], nowMs = longBefore) {
  return computeSlots({ type, ownerTimeZone: LA, fromMs: dayStart, toMs: dayEnd, nowMs, busy });
}

test('wall-clock time converts to the right instant in winter and summer', () => {
  assert.equal(new Date(friday(9)).toISOString(), '2026-11-20T17:00:00.000Z');
  assert.equal(new Date(zonedToUtcMs(2026, 7, 1, 9, 0, LA)).toISOString(), '2026-07-01T16:00:00.000Z');
  assert.deepEqual(zonedParts(Date.parse('2026-11-20T17:00:00Z'), LA), { year: 2026, month: 11, day: 20, hour: 9, minute: 0 });
});

test('working hours produce one slot per step', () => {
  assert.deepEqual(slotsOn(base), [friday(9), friday(9, 30), friday(10), friday(10, 30)]);
});

test('a slot must end inside the working window', () => {
  assert.deepEqual(slotsOn({ ...base, durationMin: 45 }), [friday(9), friday(9, 30), friday(10)]);
});

test('busy time removes the slots it overlaps and no others', () => {
  const busy = [{ start: friday(9, 30), end: friday(10) }];
  assert.deepEqual(slotsOn(base, busy), [friday(9), friday(10), friday(10, 30)]);
});

test('the buffer keeps a gap on both sides of busy time', () => {
  const busy = [{ start: friday(10), end: friday(10, 30) }];
  // 09:30 would end, and 10:30 would start, with no gap to the busy block.
  assert.deepEqual(slotsOn({ ...base, bufferMin: 15 }, busy), [friday(9)]);
  const wide = { ...base, bufferMin: 15, hours: { fri: [{ start: '09:00', end: '12:00' }] } };
  assert.deepEqual(slotsOn(wide, busy), [friday(9), friday(11), friday(11, 30)]);
});

test('minimum notice hides slots that start too soon', () => {
  const now = friday(8);
  assert.deepEqual(slotsOn({ ...base, minNoticeMin: 120 }, [], now), [friday(10), friday(10, 30)]);
});

test('the booking horizon hides slots that are too far ahead', () => {
  assert.deepEqual(slotsOn({ ...base, maxDaysAhead: 5 }), []);
});

test('a date override replaces the weekly hours', () => {
  assert.deepEqual(slotsOn({ ...base, dateOverrides: { '2026-11-20': [] } }), []);
  const special = { ...base, dateOverrides: { '2026-11-20': [{ start: '14:00', end: '15:00' }] } };
  assert.deepEqual(slotsOn(special), [friday(14), friday(14, 30)]);
});

test('slots follow the clock change in spring', () => {
  // Sunday 8 March 2026: Los Angeles moves from UTC-8 to UTC-7 at 02:00.
  const type = { ...base, hours: { sun: [{ start: '09:00', end: '10:00' }] } };
  const from = zonedToUtcMs(2026, 3, 8, 0, 0, LA);
  const slots = computeSlots({ type, ownerTimeZone: LA, fromMs: from, toMs: from + 24 * HOUR, nowMs: from - 24 * HOUR, busy: [] });
  assert.deepEqual(slots.map(ms => new Date(ms).toISOString()), ['2026-03-08T16:00:00.000Z', '2026-03-08T16:30:00.000Z']);
});

test("a range in another time zone still finds the owner's working hours", () => {
  // A visitor in Tokyo asks for their Saturday 21 November: it holds the owner's Friday morning.
  const from = zonedToUtcMs(2026, 11, 21, 0, 0, 'Asia/Tokyo');
  const slots = computeSlots({ type: base, ownerTimeZone: LA, fromMs: from, toMs: from + 24 * HOUR, nowMs: longBefore, busy: [] });
  assert.deepEqual(slots, [friday(9), friday(9, 30), friday(10), friday(10, 30)]);
});

test('a one-millisecond range answers whether one exact start is bookable', () => {
  const ask = start => computeSlots({ type: base, ownerTimeZone: LA, fromMs: start, toMs: start + 1, nowMs: longBefore, busy: [] });
  assert.deepEqual(ask(friday(9, 30)), [friday(9, 30)]);
  assert.deepEqual(ask(friday(9, 31)), []);
});
