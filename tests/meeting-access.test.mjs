import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { defaultSettings } from '../src/store.mjs';
import { DaylineService } from '../src/service.mjs';
import { authorizationUrl, exchangeCode, refreshToken } from '../src/google.mjs';
import { readCalendarMeetings } from '../src/meetings.mjs';
import { meetingRange } from '../src/meeting-agenda.mjs';
import { startServer } from '../src/http.mjs';

const dates = { from: '2026-11-23', to: '2026-11-30' };
const joinUrl = 'https://meet.google.com/abc-defg-hij';
const detailScope = 'https://www.googleapis.com/auth/calendar.events.readonly';
const writeScope = 'https://www.googleapis.com/auth/calendar.events';

function fixture({ details = true, read, list } = {}) {
  const reads = [];
  const refreshes = [];
  const store = { state: { settings: { ...defaultSettings(), timeZone: 'UTC' }, tasks: [],
    accounts: ['work', 'home'].map(sub => ({ sub, email: sub + '@example.test', secret: sub,
      mode: 'availability', meetingDetails: sub === 'work' && details })) }, save() {} };
  const google = {
    authorizationUrl, exchangeCode: async ({ code }) => ({ refresh_token: code, access_token: code }),
    getProfile: async sub => ({ sub, email: sub + '@example.test' }),
    refreshToken: async ({ refreshToken, mode }) => {
      refreshes.push([refreshToken, mode]);
      return { access_token: refreshToken };
    },
    listCalendars: list || (async account => [
      { id: account, name: account, primary: true, accessRole: 'owner' },
      { id: account + '-room', name: 'Room', accessRole: 'freeBusyReader' }
    ]),
    getBusy: async () => [{ start: '2026-11-23T09:00:00Z', end: '2026-11-23T10:00:00Z' }],
  };
  const meeting = { id: 'm', iCalUID: 'm@example.test', summary: 'Synthetic design review', status: 'confirmed',
    start: { dateTime: '2026-11-23T09:00:00Z' }, end: { dateTime: '2026-11-23T10:00:00Z' },
    hangoutLink: joinUrl, attendees: [{ email: 'guest@example.test', responseStatus: 'accepted' }] };
  const service = new DaylineService({ store, google, bundledClient: { clientId: 'example' },
    clock: () => new Date('2026-11-23T08:00:00Z'), vault: { open: async s => s, seal: async s => s },
    readMeetings: async (access, calendar, range) => {
      reads.push(calendar.providerId);
      if (read) await read(calendar);
      return readCalendarMeetings(access, calendar, range, async () => Response.json({ kind: 'calendar#events', items: [meeting] }));
    },
  });
  service.origin = 'http://127.0.0.1:43127';
  return { service, store, refreshes, reads };
}

test('a meeting grant requests read-only events and rejects a write grant or an incomplete read grant', async t => {
  const params = { clientId: 'example', redirectUri: 'http://127.0.0.1/return', mode: 'details',
    state: 'opaque', codeChallenge: 'challenge', loginHint: 'work@example.test' };
  const url = new URL(authorizationUrl(params));
  const scopes = url.searchParams.get('scope').split(' ');
  assert.equal(url.searchParams.get('login_hint'), params.loginHint);
  assert.ok(scopes.includes(detailScope) && !scopes.includes(writeScope));
  let granted = [...scopes];
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    if (body.get('grant_type') === 'refresh_token') assert.deepEqual(body.get('scope').split(' '), scopes);
    return Response.json({ access_token: 'mock', scope: granted.join(' ') });
  });
  await exchangeCode({ ...params, verifier: 'verifier', code: 'test' });
  await refreshToken({ ...params, refreshToken: 'refresh' });
  granted = [...scopes, writeScope];
  await assert.rejects(exchangeCode({ ...params, verifier: 'verifier', code: 'test' }), { reason: 'unexpectedScopes' });
  granted = scopes.filter(scope => scope !== detailScope);
  await assert.rejects(refreshToken({ ...params, refreshToken: 'refresh' }), { reason: 'insufficientScopes' });
});

test('an existing free/busy account opts into details independently, using its original address and read-only refresh', async () => {
  const { service, store, reads, refreshes } = fixture({ details: false });
  assert.deepEqual(await service.meetings(dates), { events: [], warnings: [] });
  assert.deepEqual(reads, []);
  const begin = async () => {
    const { url } = await service.beginConnection({ mode: 'details', expectedMode: 'availability', accountSub: 'work' });
    const params = new URL(url).searchParams;
    assert.equal(params.get('login_hint'), 'work@example.test');
    return params.get('state');
  };
  await assert.rejects(service.finishConnection({ state: await begin(), code: 'home' }), /different account/i);
  assert.equal(service.snapshot().connection.accounts.filter(a => a.meetingDetails).length, 0);
  await service.finishConnection({ state: await begin(), code: 'work' });
  assert.equal(store.state.settings.calendarMode, 'availability');
  assert.deepEqual(service.snapshot().connection.accounts.map(a => [a.mode, a.meetingDetails]),
    [['availability', true], ['availability', false]]);
  service.tokens.clear();
  const week = await service.meetings(dates);
  assert.deepEqual(week.events.map(event => event.title), ['Synthetic design review']);
  assert.deepEqual(reads, ['work']);
  assert.ok(refreshes.some(([sub, mode]) => sub === 'work' && mode === 'details'));
  await assert.rejects(service.eventToken('work'), /switched off/);
});

test('weekly reads coalesce, maintain refreshable in-memory links and forget excluded calendars', async () => {
  const { service, reads, store } = fixture();
  const [one, two] = await Promise.all([service.meetings(dates), service.meetings(dates)]);
  assert.deepEqual(one, two);
  assert.deepEqual(reads, ['work']);
  assert.equal(one.events[0].attendees[0].response, 'accepted');
  assert.equal(service.meetingAgenda.containsLink(joinUrl), true);
  assert.equal(service.meetingAgenda.containsLink(joinUrl + '?other'), false);
  assert.doesNotMatch(JSON.stringify([service.snapshot(), store.state]), /Synthetic design review|guest@example|abc-defg-hij/);
  await service.meetings(dates);
  assert.equal(reads.length, 1);
  service.meetingAgenda.expire();
  await service.meetings(dates);
  assert.equal(reads.length, 2);
  service.updateSettings({ excludedCalendarIds: [service.calendars.find(c => c.providerId === 'work').id] });
  assert.equal(service.meetingAgenda.containsLink(joinUrl), false);
  assert.deepEqual(await service.meetings(dates), { events: [], warnings: [] });
});

test('disconnecting during a details refresh discards the response and prevents opening its links', async () => {
  const started = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  const { service } = fixture({ read: async () => { started.resolve(); await proceed.promise; } });
  const request = service.meetings(dates);
  await started.promise;
  service.disconnect('work');
  proceed.resolve();
  assert.deepEqual(await request, { events: [], warnings: [] });
  assert.equal(service.meetingAgenda.containsLink(joinUrl), false);
});

test('meeting read failures leave free/busy intact and other calendars can still load', async () => {
  const { service } = fixture({ read: async calendar => {
    if (calendar.sub === 'work') throw Object.assign(new Error('private provider diagnostic'), { status: 403 });
  } });
  service.data.accounts[1].meetingDetails = true;
  await service.queueSync();
  assert.equal(service.busy.length > 0, true);
  const { events, warnings } = await service.meetings(dates);
  assert.deepEqual(events.map(e => e.title), ['Synthetic design review']);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /private provider diagnostic/);
  assert.equal(service.error, null);
});

test('a revoked calendar list cannot hide meetings on a second healthy account or allow unverified scheduling', async () => {
  const { service } = fixture({ list: async sub => {
    if (sub === 'work') throw new Error('Connection expired');
    return [{ id: sub, name: 'Home', primary: true, accessRole: 'owner' }];
  } });
  service.data.accounts[1].meetingDetails = true;
  await service.queueSync();
  assert.match(service.error, /expired/);
  assert.deepEqual(service.busy, []);
  const { events, warnings } = await service.meetings(dates);
  assert.equal(events.length, 1);
  assert.match(warnings.join(' '), /work@example.test/);
});

test('paired local sessions alone can read bounded calendar weeks, including DST transitions', async t => {
  assert.deepEqual(meetingRange('2026-03-08', '2026-03-09', 'America/Los_Angeles'), {
    start: '2026-03-08T08:00:00.000Z', end: '2026-03-09T07:00:00.000Z', timeZone: 'America/Los_Angeles'
  });
  const { service } = fixture();
  const app = await startServer({ service, webRoot: fileURLToPath(new URL('../web', import.meta.url)), port: 0, intervalMs: 0 });
  t.after(() => app.close());
  const url = app.origin + '/api/meetings?from=2026-11-23&to=2026-11-30';
  assert.equal((await fetch(url)).status, 401);
  const pair = await fetch(app.launchUrl(), { redirect: 'manual' });
  const headers = { Cookie: pair.headers.get('set-cookie').split(';')[0] };
  const paired = await fetch(url, { headers });
  assert.equal(paired.headers.get('cache-control'), 'no-store');
  assert.equal((await paired.json()).events.length, 1);
  for (const query of ['', '?from=2026-11-30&to=2026-11-23', '?from=2026-01-01&to=2026-12-01', '?from=2026-02-30&to=2026-03-01']) {
    assert.equal((await fetch(app.origin + '/api/meetings' + query, { headers })).status, 400);
  }
});
