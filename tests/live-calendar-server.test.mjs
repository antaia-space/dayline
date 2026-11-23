import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/http.mjs';
import { MeetingAgenda } from '../src/meeting-agenda.mjs';
import { at, liveCalendarFixture, taskInput, week } from './fixtures/live-calendar.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const fastChecks = { intervalMs: 35, maxIntervalMs: 60, requestGapMs: 10, accountGapMs: 10 };

async function start(t, options) {
  const fixture = liveCalendarFixture();
  const app = await startServer({ service: fixture.service, webRoot, port: 0, intervalMs: 0, ...options });
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await app.close(); });
  const pair = async () => (await fetch(app.launchUrl(), { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const read = async (resource, cookie) => (await fetch(app.origin + resource, { headers: { cookie } })).json();
  const submit = (resource, cookie, origin = app.origin) => fetch(app.origin + resource, {
    method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' }, body: '{}'
  });
  async function* updates(cookie) {
    const stream = await fetch(app.origin + '/api/updates', { headers: { cookie },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    let buffered = '';
    for await (const chunk of stream.body.pipeThrough(new TextDecoderStream())) {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf('\n\n')) !== -1) {
        const packet = buffered.slice(0,end);
        buffered = buffered.slice(end + 2);
        if (!packet.includes('event: calendar')) continue;
        const data = JSON.parse(packet.split('\ndata: ')[1]);
        assert.deepEqual(Object.keys(data), ['revision']);
        yield data.revision;
      }
    }
  }
  return { ...fixture, app, pair, read, submit, updates };
}

test('paired planners see the moved meeting and replanned task in one revision, then receive RSVP edits and cancellation', async t => {
  const { service, calls, pair, updates, read, moved, update, attendee } = await start(t, { calendarMonitorOptions: fastChecks });
  const [desktop, browser] = await Promise.all([pair(), pair()]);
  const id = await service.run(() => service.createTask(taskInput));
  await service.queueSync();
  assert.equal(service.findTask(id).start, at('09:30'));
  const before = await read('/api/meetings' + week, desktop);
  const original = before.events[0].id;
  const streams = [updates(desktop), updates(browser)];
  await Promise.all(streams.map(s => s.next()));
  async function waitFor(stream, cookie, predicate) {
    for (;;) {
      const { value: revision, done } = await stream.next();
      assert.equal(done,false,'calendar stream ended before the expected update');
      const [state, meetings] = await Promise.all([read('/api/state',cookie),read('/api/meetings'+week,cookie)]);
      if (predicate(state, meetings.events)) return revision;
    }
  }
  moved();
  const correctMove = (state, events) => state.tasks.length === 1 && state.tasks[0].id === id &&
    state.tasks[0].start === at('09:00') && events.length === 1 && events[0].id === original &&
    events[0].start === at('10:30') && events[0].title === 'Revised studio review' && events[0].location === 'South room';
  const seen = await Promise.all([waitFor(streams[0],desktop,correctMove),waitFor(streams[1],browser,correctMove)]);
  update({ attendees: attendee('tentative') });
  assert.ok(await waitFor(streams[0],desktop,(_,events) => events[0]?.attendees[0]?.response === 'tentative') > seen[0]);
  update(null);
  assert.ok(await waitFor(streams[1],browser,(state,events) => events.length === 0 && state.busy.length === 0) > seen[1]);
  assert.deepEqual(calls.writes, []);
});

test('a change that arrives during a Google read schedules a new reconciliation before notifying listeners', async t => {
  const { service, pair, submit, moved, calls, controls } = await start(t);
  const cookie = await pair();
  await service.queueSync();
  const before = calls.busy.length;
  controls.busyGate = { entered: Promise.withResolvers(), proceed: Promise.withResolvers() };
  const first = submit('/api/sync',cookie);
  await controls.busyGate.entered.promise;
  moved();
  const second = submit('/api/sync',cookie);
  await delay(50);
  controls.busyGate.proceed.resolve();
  assert.deepEqual((await Promise.all([first,second])).map(response => response.status), [200,200]);
  assert.ok(calls.busy.length >= before + 4);
  assert.equal(service.busy[0].start,at('10:30'));
});

test('only paired clients may subscribe and only local paired actions may request a check', async t => {
  const { app, pair, submit } = await start(t);
  const cookie = await pair();
  assert.equal((await fetch(app.origin + '/api/updates')).status,401);
  assert.equal((await fetch(app.origin + '/api/updates',{headers:{cookie,origin:'https://foreign.example'}})).status,403);
  assert.equal((await submit('/api/calendar/check','')).status,401);
  assert.equal((await submit('/api/calendar/check',cookie,'https://foreign.example')).status,403);
  assert.equal((await submit('/api/calendar/check',cookie)).status,202);
});

test('an old meeting request cannot repopulate a cache expired by a notification', async () => {
  const cache = new MeetingAgenda(), range = { start: at('09:00'), end: at('17:00'), timeZone:'UTC' };
  const response = Promise.withResolvers();
  const old = cache.read([{id:'team'}],range,() => response.promise);
  cache.expire();
  const fresh = await cache.read([{id:'team'}],range,async () => [{id:'new',title:'New time',start:at('10:30'),end:at('11:00')}]);
  response.resolve([{id:'old',title:'Old time',start:at('09:00'),end:at('09:30')}]);
  assert.equal((await old).events.length,0);
  assert.equal(fresh.events[0].id,'new');
  assert.equal((await cache.read([{id:'team'}],range,() => assert.fail('expected fresh cache'))).events[0].id,'new');
});
