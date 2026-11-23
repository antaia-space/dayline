import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarMonitor } from '../src/calendar-monitor.mjs';
import { getBusyByCalendar, readCalendarChangePage } from '../src/google.mjs';

const start = '2026-11-23T00:00:00.000Z', end = '2026-12-01T00:00:00.000Z';
const range = { start, end };
const event = (id, sub = 'work') => ({ sub, id, details: true });
const basic = (id, sub = 'work') => ({ sub, id, details: false });
const page = (nextSyncToken, hasChanges = false, etag = '"version"') => ({ nextSyncToken, nextPageToken: null, hasChanges, etag });
const laterPage = (nextPageToken, hasChanges = false) => ({ nextPageToken, nextSyncToken: null, hasChanges, etag: null });
const failure = (status, reason, more) => Object.assign(Error('Fixture failure'), { status, reason, ...more });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const emptyBusy = ids => ids.map(calendarId => ({ calendarId, busy: [] }));

function fixture(calendars, google, overrides = {}) {
  let clock = Date.parse(start);
  const config = { revision: 1, calendars, ranges: [range] };
  const monitor = new CalendarMonitor({ sources: () => config, token: sub => 'token-' + sub,
    google, now: () => clock, random: () => 0, intervalMs: 40, maxIntervalMs: 100, requestGapMs: 10,
    accountGapMs: 15, maxBackoffMs: 1000, ...overrides });
  return { monitor, config, advance(ms) { clock += ms; }, async tick(ms = 200) { clock += ms; return monitor.poll(); } };
}

test('the Google change probe observes a conditional 304 and requests only collection cursors and event versions', async () => {
  const calls = [];
  const replies = [
    json({ kind: 'calendar#events', etag: '"all"', nextPageToken: 'continue', items: [{ etag: '"one"', summary: 'hidden' }] }),
    json({ kind: 'calendar#events', etag: '"next"', nextSyncToken: 's1' }),
    new Response(null, { status: 304 }),
    json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 403, { 'Retry-After': '12' }),
    json({ kind: 'calendar#events', items: [] }),
  ];
  const request = async (url, init) => { calls.push([new URL(url), init]); return replies.shift(); };
  const params = { calendarId: 'team/calendar', timeMin: start };
  const first = await readCalendarChangePage('test', params, request);
  assert.deepEqual(first, { nextPageToken: 'continue', nextSyncToken: null, hasChanges: true, etag: '"all"' });
  await readCalendarChangePage('test', { ...params, pageToken: 'continue' }, request);
  const same = await readCalendarChangePage('test', { ...params, syncToken: 's1', etag: '"delta"' }, request);
  assert.deepEqual(same, { notModified: true });
  assert.equal(calls[0][0].pathname.split('/').at(-2), 'team%2Fcalendar');
  assert.equal(calls[0][0].searchParams.get('timeMin'), start);
  assert.equal(calls[1][0].searchParams.get('pageToken'), 'continue');
  assert.equal(calls[2][0].searchParams.has('timeMin'), false);
  assert.equal(calls[2][0].searchParams.get('syncToken'), 's1');
  assert.equal(calls[2][1].headers['If-None-Match'], '"delta"');
  for (const [url, init] of calls) {
    assert.equal(init.headers.Authorization, 'Bearer test');
    assert.equal(init.method || 'GET', 'GET');
    assert.equal(url.searchParams.get('singleEvents'), 'false');
    assert.equal(url.searchParams.get('showDeleted'), 'true');
    assert.equal(url.searchParams.get('fields'), 'kind,etag,nextPageToken,nextSyncToken,items(etag)');
  }
  await assert.rejects(readCalendarChangePage('test', params, request), { status: 403, reason: 'userRateLimitExceeded', retryAfterSeconds: 12 });
  await assert.rejects(readCalendarChangePage('test', params, request), { status: 502, reason: 'invalidResponse' });
});

test('Google free/busy keeps calendar identities, respects the 50-calendar limit and rejects an incomplete response', async () => {
  const calls = [], ids = Array.from({ length: 51 }, (_, i) => 'cal-' + i);
  const request = async (_url, opts) => {
    const data = JSON.parse(opts.body);
    calls.push(data.items.map(item => item.id));
    return json({ calendars: Object.fromEntries(data.items.map(({ id }) => [id, { busy: id === 'cal-50' ? [{ start, end }] : [] }])) });
  };
  const rows = await getBusyByCalendar('token', { ...range, calendarIds: ids }, request);
  assert.deepEqual(calls.map(group => group.length), [50, 1]);
  assert.deepEqual(rows.at(-1), { calendarId: 'cal-50', busy: [range] });
  assert.deepEqual(rows[0], { calendarId: 'cal-0', busy: [] });
  await assert.rejects(getBusyByCalendar('token', { ...range, calendarIds: ids.slice(0, 2) }, () =>
    json({ calendars: { 'cal-0': { busy: [] } } })), { calendarId: 'cal-1', reason: 'missingAvailability' });
});

test('paged bootstrap signals once, then detects a paged change and scopes conditional retrieval to a known-empty delta', async () => {
  const calls = [], replies = [laterPage('bootstrap-2', true), page('initial', true), page('after-empty'),
    { notModified: true }, laterPage('delta-2', true), page('after-move'), page('next')];
  const h = fixture([event('primary')], { readCalendarChangePage: (_token, params) => {
    calls.push(params);
    return replies.shift();
  } });
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await h.tick());
  assert.deepEqual(results.map(r => r.changed), [false, true, false, false, false, true, false]);
  assert.deepEqual(results.map(r => r.baseline), [false, true, false, false, false, false, false]);
  assert.deepEqual(calls[0], { calendarId: 'primary', timeMin: start });
  assert.deepEqual(calls[1], { calendarId: 'primary', timeMin: start, pageToken: 'bootstrap-2' });
  assert.deepEqual(calls[2], { calendarId: 'primary', syncToken: 'initial' });
  assert.deepEqual(calls[3], { calendarId: 'primary', syncToken: 'initial', etag: '"version"' });
  assert.deepEqual(calls[4], calls[3]);
  assert.deepEqual(calls[5], { calendarId: 'primary', syncToken: 'initial', pageToken: 'delta-2' });
  assert.deepEqual(calls[6], { calendarId: 'primary', syncToken: 'after-move' });
});

test('busy-only fingerprints are stable under reordering and offset formatting and detect an unchanged time moving between calendars', async () => {
  let reversed = false, moved = false, missing = false;
  const calls = [];
  const h = fixture([basic('a'), basic('b')], { getBusyByCalendar: (token, params) => {
    calls.push([token, params]);
    const busy = reversed ? [{ start: '2026-11-23T01:00:00+01:00', end: '2026-12-01T01:00:00+01:00' }] : [range];
    const rows = [{ calendarId: 'a', busy: moved ? [] : busy }, { calendarId: 'b', busy: moved ? busy : [] }];
    return missing ? rows.slice(0, 1) : reversed ? rows.reverse() : rows;
  }, readCalendarChangePage() { assert.fail('free/busy grants cannot read events'); } });
  assert.equal((await h.tick()).baseline, true);
  reversed = true;
  assert.equal((await h.tick()).changed, false);
  moved = true;
  assert.equal((await h.tick()).changed, true);
  missing = true;
  const incomplete = await h.tick();
  assert.equal(incomplete.changed, false);
  assert.equal(incomplete.failed, true);
  missing = false;
  assert.equal((await h.tick()).changed, true); // confirm recovery from an incomplete read
  assert.ok(calls.every(([token, { calendarIds }]) => token === 'token-work' && calendarIds.join(',') === 'a,b'));
});

test('busy probes batch, merge overlapping weeks, and fairly revisit the planner horizon and distant visible weeks', async () => {
  const calls = [], ids = Array.from({ length: 52 }, (_, i) => basic('id-' + String(i).padStart(2, '0')));
  const h = fixture([...ids, { ...basic('weeknumbers'), canCheckAvailability: false },
    basic('e_2_de#weeknum@group.v.calendar.google.com'), basic('other', 'home')], {
    getBusyByCalendar: (token, params) => { calls.push({ token, ...params }); return emptyBusy(params.calendarIds); },
  });
  h.config.ranges = [range, { start: '2026-11-29T00:00:00Z', end: '2026-12-05T00:00:00Z' },
    { start: '2027-06-01T00:00:00Z', end: '2027-06-08T00:00:00Z' }];
  let baselines = 0;
  for (let i = 0; i < 24; i++) {
    const result = await h.monitor.poll();
    if (result.baseline) baselines++;
    h.advance(Math.max(1, result.nextDelayMs));
  }
  assert.equal(baselines, 1);
  assert.ok(calls.every(c => c.calendarIds.length <= 50 && !c.calendarIds.some(id => /weeknum/.test(id))));
  const distinct = new Set(calls.map(c => keyFor(c)));
  function keyFor(c) { return c.token + '|' + c.start + '|' + c.calendarIds[0]; }
  assert.equal(distinct.size, 6);
  assert.ok(calls.some(c => c.start === start && c.end === '2026-12-05T00:00:00.000Z'));
  assert.ok(calls.some(c => c.start.startsWith('2027-06')));
  for (const id of distinct) assert.ok(calls.filter(c => keyFor(c) === id).length >= 2, id);
});

test('newer views keep a details cursor, older views establish an earlier floor, and an expired token reboots safely', async () => {
  const calls = [];
  let error;
  const h = fixture([event('personal')], { readCalendarChangePage: (_token, params) => {
    calls.push(params);
    if (error) { const next = error; error = null; throw next; }
    return page('s-' + calls.length);
  } });
  await h.tick();
  h.config.ranges.push({ start: '2027-06-01T00:00:00Z', end: '2027-06-08T00:00:00Z' });
  assert.equal((await h.tick()).baseline, false);
  assert.equal(calls.at(-1).syncToken, 's-1');
  h.config.ranges.push({ start: '2026-01-01T00:00:00Z', end: '2026-01-08T00:00:00Z' });
  assert.equal((await h.tick()).baseline, true);
  assert.equal(calls.at(-1).timeMin, '2026-01-01T00:00:00.000Z');
  error = failure(410, 'fullSyncRequired');
  assert.equal((await h.tick()).failed, true);
  assert.equal((await h.tick()).baseline, true);
  assert.equal(calls.at(-1).syncToken, undefined);
  assert.equal(calls.at(-1).timeMin, '2026-01-01T00:00:00.000Z');
});

test('selected calendar and grant changes or stop invalidate a request in flight, while simultaneous polls share one call', async () => {
  let resolve, started;
  const running = new Promise(r => { started = r; });
  const calls = [];
  const h = fixture([event('old')], { readCalendarChangePage: async (_token, params) => {
    calls.push(params);
    if (params.calendarId === 'old') { started(); return new Promise(r => { resolve = r; }); }
    return page('new');
  } });
  const a = h.monitor.poll(), b = h.monitor.poll();
  assert.equal(a, b);
  await running;
  h.config.calendars = [event('new')];
  resolve(page('discard', true));
  assert.equal((await a).changed, false);
  assert.equal((await h.tick()).baseline, true);
  assert.deepEqual(calls.map(c => c.calendarId), ['old', 'new']);
  h.config.revision++;
  await h.tick();
  assert.equal(calls.at(-1).syncToken, undefined);
  h.monitor.stop();
  assert.equal((await h.tick()).checked, 0);
  assert.equal(calls.length, 3);
});

test('quota errors back off without changing permissions, honor Retry-After, and forbidden details fall back to availability', async () => {
  let fail = failure(403, 'userRateLimitExceeded', { retryAfterSeconds: 3 }), count = 0, busy = 0;
  const h = fixture([event('personal')], {
    readCalendarChangePage() { count++; if (fail) throw fail; return page('s'); },
    getBusyByCalendar(_token, params) { busy++; return emptyBusy(params.calendarIds); },
  });
  const denied = await h.tick();
  assert.equal(denied.changed, false);
  assert.equal(denied.nextDelayMs, 3000);
  assert.equal((await h.tick(2999)).checked, 0);
  fail = null;
  assert.equal((await h.tick(1)).baseline, true);
  assert.equal(busy, 0);
  fail = failure(403, 'forbidden');
  assert.equal((await h.tick()).failed, true);
  assert.equal((await h.tick()).baseline, true);
  assert.equal(busy, 1);
  assert.equal(count, 3);
});
