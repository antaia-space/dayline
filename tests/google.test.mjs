import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizationUrl, exchangeCode, refreshToken, getProfile, listCalendars, getBusy,
  getTaskEvent, listTaskEvents, putTaskEvent, deleteTaskEvent, hasOtherBusyEvent, busyWithoutReservations,
} from '../src/google.mjs';

const token = 'test-access';
const eventId = '0123456789abcdeffedcba9876543210';
const calendarId = 'team/name@example.test';
const start = '2026-11-24T09:00:00.000Z';
const end = '2026-11-24T10:00:00.000Z';
const task = { id: eventId, text: 'Review the brief', done: false, category: 'focus', start, end };
const actionUrl = 'http://127.0.0.1:43127/action/' + eventId + '?done=1';
const write = { calendarId, eventId, task, actionUrl, expectedEtag: null };
const availabilityScopes = [
  'openid', 'email',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
];
const eventScope = 'https://www.googleapis.com/auth/calendar.events';
const syncScopes = [...availabilityScopes, eventScope];

function event(overrides = {}) {
  return {
    id: eventId, etag: '"v1"', summary: task.text, colorId: '9',
    start: { dateTime: start }, end: { dateTime: end },
    extendedProperties: { private: { dayline: '1', daylineTaskId: task.id } }, ...overrides,
  };
}

function reply(data, status = 200, headers) {
  return new Response(status === 204 ? null : JSON.stringify(data), { status, headers });
}

function failure(status, reason) {
  return reply({ error: { code: status, message: reason, errors: [{ reason }] } }, status);
}

function simulate(t, ...handlers) {
  let index = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const handler = handlers[index++];
    assert.ok(handler, 'Unexpected request to ' + new URL(url).pathname);
    return typeof handler === 'function' ? handler(new URL(url), init) : handler;
  });
  t.after(() => assert.equal(index, handlers.length));
}

test('desktop authorization is offline, uses PKCE and posts secrets only to the token endpoint', async t => {
  const redirectUri = 'http://127.0.0.1:43127/oauth/callback';
  const url = new URL(authorizationUrl({ clientId: 'client', redirectUri, state: 'state', codeChallenge: 'challenge' }));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('state'), 'state');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(url.searchParams.has('client_secret'), false);
  const scope = url.searchParams.get('scope');
  assert.deepEqual(new Set(scope.split(' ')), new Set(availabilityScopes));
  assert.notEqual(url.searchParams.get('include_granted_scopes'), 'true');

  simulate(t,
    (endpoint, init) => {
      assert.equal(endpoint.href, 'https://oauth2.googleapis.com/token');
      assert.equal(init.method, 'POST');
      assert.equal(init.body.get('grant_type'), 'authorization_code');
      assert.equal(init.body.get('code_verifier'), 'verifier');
      assert.equal(init.body.get('client_secret'), 'test-secret');
      const canonicalScope = scope.replace(' email ', ' https://www.googleapis.com/auth/userinfo.email ');
      return reply({ access_token: token, refresh_token: 'test-refresh', expires_in: 3600, scope: canonicalScope });
    },
    (endpoint, init) => {
      assert.equal(init.body.get('grant_type'), 'refresh_token');
      assert.equal(init.body.get('refresh_token'), 'test-refresh');
      assert.equal(init.body.has('client_secret'), false);
      assert.deepEqual(new Set(init.body.get('scope').split(' ')), new Set(availabilityScopes));
      return reply({ access_token: 'refreshed', expires_in: 3600 });
    },
    (endpoint, init) => {
      assert.equal(endpoint.href, 'https://openidconnect.googleapis.com/v1/userinfo');
      assert.equal(init.headers.Authorization, 'Bearer ' + token);
      return reply({ sub: 'abc', email: 'person@example.test', email_verified: true });
    },
    reply({ sub: 'abc', email: 'person@example.test', email_verified: false }),
  );
  const tokens = await exchangeCode({ clientId: 'client', clientSecret: 'test-secret', redirectUri, code: 'code', verifier: 'verifier' });
  assert.equal(tokens.refresh_token, 'test-refresh');
  const refreshed = await refreshToken({ clientId: 'client', refreshToken: tokens.refresh_token });
  assert.equal(refreshed.access_token, 'refreshed');
  assert.deepEqual(await getProfile(token), { sub: 'abc', email: 'person@example.test' });
  await assert.rejects(getProfile(token), { status: 403, reason: 'unverifiedProfile' });
});

test('event access is requested and accepted only for an explicit sync connection', async t => {
  const options = { clientId: 'client', redirectUri: 'http://127.0.0.1/oauth/callback', mode: 'sync' };
  const granted = syncScopes.join(' ');
  const url = new URL(authorizationUrl({ ...options, state: 'state', codeChallenge: 'challenge' }));
  assert.deepEqual(new Set(url.searchParams.get('scope').split(' ')), new Set(syncScopes));
  simulate(t,
    reply({ access_token: token, scope: granted }),
    (_url, init) => {
      assert.deepEqual(new Set(init.body.get('scope').split(' ')), new Set(syncScopes));
      return reply({ access_token: token, scope: granted });
    },
    reply({ access_token: token, scope: availabilityScopes.join(' ') }),
  );
  assert.equal((await exchangeCode({ ...options, code: 'code', verifier: 'verifier' })).access_token, token);
  assert.equal((await refreshToken({ ...options, refreshToken: 'test-refresh' })).access_token, token);
  await assert.rejects(refreshToken({ ...options, refreshToken: 'reduced-grant' }), { reason: 'insufficientScopes' });
});

test('an availability exchange and refresh reject broader, incomplete, or malformed returned grants', async t => {
  const options = { clientId: 'client', redirectUri: 'http://127.0.0.1/oauth/callback', mode: 'availability' };
  const exchange = () => exchangeCode({ ...options, code: 'code', verifier: 'verifier' });
  simulate(t,
    reply({ access_token: token, scope: syncScopes.join(' ') }),
    reply({ access_token: token, scope: [...availabilityScopes, 'https://www.googleapis.com/auth/calendar'].join(' ') }),
    reply({ access_token: token, scope: availabilityScopes.filter(scope => scope !== 'email').join(' ') }),
    reply({ access_token: token, scope: null }),
  );
  await assert.rejects(exchange(), { reason: 'unexpectedScopes' });
  await assert.rejects(refreshToken({ ...options, refreshToken: 'old-refresh' }), { reason: 'unexpectedScopes' });
  await assert.rejects(exchange(), { reason: 'insufficientScopes' });
  await assert.rejects(exchange(), { reason: 'invalidResponse' });
});

test('an unknown connection mode fails before sending an OAuth request', async t => {
  simulate(t);
  const options = { clientId: 'client', mode: 'full' };
  assert.throws(() => authorizationUrl(options), { reason: 'invalidMode' });
  await assert.rejects(exchangeCode(options), { reason: 'invalidMode' });
  await assert.rejects(refreshToken(options), { reason: 'invalidMode' });
});

test('a revoked refresh grant and a partially authorized scope set surface actionable errors', async t => {
  simulate(t, reply({ error: 'invalid_grant', error_description: 'Token was revoked.' }, 400),
    reply({ access_token: token, scope: 'openid email' }));
  await assert.rejects(refreshToken({ clientId: 'client', refreshToken: 'revoked' }),
    { status: 400, reason: 'invalid_grant', message: 'Token was revoked.' });
  await assert.rejects(exchangeCode({ clientId: 'client', redirectUri: 'http://127.0.0.1', code: 'code', verifier: 'verifier' }),
    { status: 403, reason: 'insufficientScopes' });
});

test('calendar discovery includes hidden and availability-only calendars, across pages', async t => {
  simulate(t,
    url => {
      assert.equal(url.searchParams.get('showHidden'), 'true');
      assert.equal(url.searchParams.has('minAccessRole'), false);
      return reply({ items: [{ id: 'z', summary: 'Zulu', accessRole: 'freeBusyReader', hidden: true }], nextPageToken: 'next/+?' });
    },
    url => {
      assert.equal(url.searchParams.get('pageToken'), 'next/+?');
      return reply({ items: [
        { id: 'primary-id', summary: 'Work', accessRole: 'owner', primary: true, backgroundColor: '#779999' },
        { id: 'room', summaryOverride: 'A room', summary: 'Room', accessRole: 'writerWithoutPrivateAccess' },
        { id: 'removed', deleted: true },
      ] });
    },
  );
  const list = await listCalendars(token);
  assert.deepEqual(list.map(({ id, writable }) => [id, writable]), [['primary-id', true], ['room', true], ['z', false]]);
  assert.equal(list[1].name, 'A room');
});

test('free/busy queries deduplicate IDs, batch by 50, and return UTC intervals', async t => {
  const ids = Array.from({ length: 54 }, (_, index) => 'cal-' + index);
  const calls = [ids.slice(0, 50), ids.slice(50)].map(batch => (url, init) => {
    assert.equal(url.pathname, '/calendar/v3/freeBusy');
    const body = JSON.parse(init.body);
    assert.equal(body.timeMin, start);
    assert.equal(body.timeMax, end);
    assert.deepEqual(body.items, batch.map(id => ({ id })));
    const calendars = Object.fromEntries(batch.map(id => [id, { busy: [] }]));
    if (batch.includes('cal-53')) calendars['cal-53'].busy.push({ start: '2026-11-24T10:00:00+01:00', end });
    return reply({ calendars });
  });
  simulate(t, ...calls);
  assert.deepEqual(await getBusy(token, { calendarIds: [...ids, ids[0]], start, end }), [{ start, end }]);
});

test('incomplete availability never silently frees a slot', async t => {
  simulate(t,
    reply({ calendars: { a: { busy: [] } } }),
    reply({ calendars: { a: { busy: [] }, b: { errors: [{ reason: 'notFound' }] } } }),
    reply({ calendars: { a: { busy: [{ start, end: 'unreadable' }] }, b: { busy: [] } } }),
  );
  const request = () => getBusy(token, { calendarIds: ['a', 'b'], start, end });
  await assert.rejects(request(), { status: 503, reason: 'missingAvailability' });
  await assert.rejects(request(), { status: 503, reason: 'notFound' });
  await assert.rejects(request(), { status: 502, reason: 'invalidResponse' });
});

test('insert uses a persistent ID, category color, task marker, and local calendar action', async t => {
  simulate(t, (url, init) => {
    assert.ok(url.pathname.includes('team%2Fname%40example.test'));
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.equal(body.id, task.id);
    assert.equal(body.colorId, '9');
    assert.equal(body.summary, task.text);
    assert.deepEqual(body.extendedProperties.private, { dayline: '1', daylineTaskId: task.id });
    assert.ok(body.description.includes('<a href="' + actionUrl + '">Mark complete</a>'));
    assert.deepEqual(body.start, { dateTime: start });
    return reply({ ...body, etag: '"new"' });
  });
  const result = await putTaskEvent(token, { ...write, eventId: undefined });
  assert.deepEqual(result, { eventId, taskId: task.id, done: false, text: task.text, owned: true, start, end, etag: '"new"' });
});

test('an uncertain insertion adopts the original event and preserves later edits in Google', async t => {
  const later = event({ summary: 'Changed by teammate ✓', etag: '"new"' });
  simulate(t, failure(409, 'duplicate'), reply(later));
  const result = await putTaskEvent(token, write);
  assert.equal(result.text, 'Changed by teammate');
  assert.equal(result.done, true);
  assert.equal(result.etag, '"new"');
});

test('colliding IDs and mismatched ownership never change another event', async t => {
  const foreign = event({ extendedProperties: { private: { dayline: '1', daylineTaskId: 'another-task' } } });
  simulate(t, failure(409, 'duplicate'), reply(foreign), reply(foreign), reply(foreign));
  await assert.rejects(putTaskEvent(token, write), { status: 409, reason: 'ownershipMismatch' });
  await assert.rejects(putTaskEvent(token, { ...write, expectedEtag: '"v1"' }), { reason: 'ownershipMismatch' });
  await assert.rejects(deleteTaskEvent(token, { calendarId, eventId, taskId: task.id, expectedEtag: '"v1"' }),
    { reason: 'ownershipMismatch' });
});

test('a completion patch preserves calendar notes, guests, and time-zone representation', async t => {
  const previous = event({
    description: 'Handwritten note<br><a href="' + actionUrl + '">Mark complete</a> in Dayline on this Mac.',
    start: { dateTime: '2026-11-24T10:00:00+01:00', timeZone: 'Europe/Zurich' },
    attendees: [{ email: 'person@example.test' }],
  });
  simulate(t, reply(previous), (url, init) => {
    assert.equal(init.method, 'PATCH');
    assert.equal(init.headers['If-Match'], previous.etag);
    const changes = JSON.parse(init.body);
    assert.deepEqual(Object.keys(changes).sort(), ['description', 'summary']);
    assert.equal(changes.summary, '✓ ' + task.text);
    assert.ok(changes.description.includes('Handwritten note<br>'));
    assert.ok(changes.description.includes('?done=0">Reopen task</a>'));
    return reply({ ...previous, ...changes, etag: '"next"' });
  });
  const updated = await putTaskEvent(token, { ...write, task: { ...task, done: true }, expectedEtag: '"v1"' });
  assert.equal(updated.done, true);
});

test('timed events using separate IANA zones do not depend on the Mac’s current zone', async t => {
  simulate(t, reply(event({ start: { dateTime: '2026-11-24T10:00:00', timeZone: 'Europe/Zurich' },
    end: { dateTime: '2026-11-24T11:00:00', timeZone: 'Europe/Zurich' } })),
  reply(event({ start: { dateTime: '2026-11-24T10:00:00' } })));
  const found = await getTaskEvent(token, { calendarId, eventId });
  assert.deepEqual([found.start, found.end], [start, end]);
  await assert.rejects(getTaskEvent(token, { calendarId, eventId }), { reason: 'invalidResponse' });
});

test('checking an owned time slice sees concurrent recurring instances without requesting their titles', async t => {
  const own = { id: eventId, status: 'confirmed' };
  simulate(t, url => {
    assert.equal(url.searchParams.get('timeMin'), start);
    assert.equal(url.searchParams.get('timeMax'), end);
    assert.equal(url.searchParams.get('singleEvents'), 'true');
    assert.equal(url.searchParams.get('fields'), 'kind,nextPageToken,items(id,status,transparency)');
    return reply({ items: [own], nextPageToken: 'next' });
  }, reply({ items: [{ id: 'other-instance', status: 'tentative' }] }),
  reply({ items: [own, { id: 'cancelled', status: 'cancelled' }, { id: 'free', transparency: 'transparent' }] }),
  reply({ kind: 'calendar#events' }));
  const slice = { calendarId, eventId, start, end };
  assert.equal(await hasOtherBusyEvent(token, slice), true);
  assert.equal(await hasOtherBusyEvent(token, slice), false);
  assert.equal(await hasOtherBusyEvent(token, slice), true);
});

test('a task event turned into an invitation or a recurring meeting is no longer a flexible reservation',async t => {
  simulate(t,reply(event({attendees:[{self:true},{}]})),reply(event({recurrence:['RRULE:FREQ=WEEKLY']})),reply(event({attendees:[{self:true}]})));
  const read = () => getTaskEvent(token,{calendarId,eventId,taskId:task.id});
  assert.equal((await read()).calendarAppointment,true);
  assert.equal((await read()).calendarAppointment,true);
  assert.equal((await read()).calendarAppointment,undefined);
});

test('clearing overlapping owned blocks requires every expected event and no other opaque event',async t => {
  const second = '22222222222222222222222222222222';
  const both = [{id:eventId},{id:second}];
  simulate(t,reply({items:both}),reply({items:both.slice(0,1)}),reply({items:[...both,{id:'another'}]}));
  const query = () => hasOtherBusyEvent(token,{calendarId,eventIds:[eventId,second],start,end});
  assert.equal(await query(),false);
  assert.equal(await query(),true);
  assert.equal(await query(),true);
});

test('compaction verifies the owned event version and keeps exact overlapping foreign busy intervals without titles',async t => {
  const stamp = hhmm => '2026-11-24T' + hhmm + ':00.000Z';
  const interval = (a,b) => ({start:stamp(a),end:stamp(b)});
  const raw = () => reply({calendars:{[calendarId]:{busy:[interval('09:00','11:00')]}}});
  const own = event({start:{dateTime:stamp('09:00')},end:{dateTime:stamp('10:30')}});
  const foreign = {id:'unrelated',status:'confirmed',start:{dateTime:stamp('09:15')},end:{dateTime:stamp('09:45')}};
  simulate(t,raw(),url => {
    const fields = url.searchParams.get('fields');
    assert.ok(!fields.includes('summary') && !fields.includes('description'));
    assert.equal(url.searchParams.get('singleEvents'),'true');
    return reply({items:[own,foreign]});
  },raw(),reply({items:[{...own,etag:'changed'}]}));
  const query = {calendarId,...interval('09:00','11:00'),timeZone:'UTC',
    reservations:[{eventId,taskId:task.id,etag:own.etag,...interval('09:00','10:30')}]};
  assert.deepEqual(await busyWithoutReservations(token,query),[interval('10:30','11:00'),interval('09:15','09:45')]);
  await assert.rejects(busyWithoutReservations(token,query),{status:412});
});

test('a final move check respects a newly observed meeting even when the preceding free/busy call has not seen it yet',async t => {
  const own = event(), later = '2026-11-24T10:10:00.000Z', until = '2026-11-24T10:20:00.000Z';
  simulate(t,reply({calendars:{[calendarId]:{busy:[{start,end}]}}}),
    reply({items:[own,{id:'just-created',start:{dateTime:later},end:{dateTime:until}}]}));
  const query = {calendarId,start,end:until,timeZone:'UTC',confirm:true,
    reservations:[{eventId,taskId:task.id,etag:own.etag,start,end}]};
  assert.deepEqual(await busyWithoutReservations(token,query),[{start:later,end:until}]);
});

test('an all-day event stays all-day on completion and clears date-only endpoints on an explicit move', async t => {
  const allDay = event({ start: { date: '2026-11-24' }, end: { date: '2026-11-25' } });
  simulate(t, reply(allDay), (_, init) => {
    const patch = JSON.parse(init.body);
    assert.deepEqual(Object.keys(patch).sort(), ['description', 'summary']);
    return reply({ ...allDay, ...patch });
  }, reply(allDay), (_, init) => {
    const patch = JSON.parse(init.body);
    assert.deepEqual(patch.start, { date: null, dateTime: start });
    assert.deepEqual(patch.end, { date: null, dateTime: end });
    return reply({ ...allDay, ...patch });
  });
  const done = { ...task, done: true, start: allDay.start.date, end: allDay.end.date };
  assert.equal((await putTaskEvent(token, { ...write, task: done, expectedEtag: allDay.etag })).start, allDay.start.date);
  assert.equal((await putTaskEvent(token, { ...write, expectedEtag: allDay.etag })).start, start);
});

test('personal completion toggles Google transparency with If-Match and never changes another organizer’s reservation',async t => {
  const original = event(), free = event({summary:'✓ ' + task.text,transparency:'transparent'});
  simulate(t,reply(original),(_,init) => {
    const patch = JSON.parse(init.body);
    assert.equal(init.headers['If-Match'],original.etag);
    assert.equal(patch.transparency,'transparent');
    assert.equal(patch.start,undefined);
    assert.equal(patch.end,undefined);
    return reply({...original,...patch});
  },reply(free),(_,init) => {
    const patch = JSON.parse(init.body);
    assert.equal(patch.transparency,'opaque');
    return reply({...free,...patch});
  },reply(event({organizer:{email:'external@example.test'}})));
  assert.equal((await putTaskEvent(token,{...write,expectedEtag:original.etag,task:{...task,done:true},completionAction:'free'})).transparent,true);
  assert.equal(Boolean((await putTaskEvent(token,{...write,expectedEtag:free.etag,completionAction:'book'})).transparent),false);
  await assert.rejects(putTaskEvent(token,{...write,expectedEtag:original.etag,completionAction:'trim'}),{reason:'sharedAppointment'});
});

test('concurrent calendar edits survive app writes and deletions', async t => {
  simulate(t, reply(event({ etag: '"later"' })), reply(event()), failure(412, 'conditionNotMet'), reply(event({ etag: '"later"' })));
  const patch = { ...write, task: { ...task, done: true }, expectedEtag: '"v1"' };
  await assert.rejects(putTaskEvent(token, patch), { status: 412 });
  await assert.rejects(putTaskEvent(token, patch), { status: 412 });
  await assert.rejects(deleteTaskEvent(token, { calendarId, eventId, taskId: task.id, expectedEtag: '"v1"' }), { status: 412 });
});

test('Google title checkmarks and removing the marker both round-trip', async t => {
  const titles = ['✓ Triage', 'Triage ✔️', '☑️ Triage', '[X] Triage', 'Triage [x]', 'Triage'];
  simulate(t, ...titles.map(summary => reply(event({ summary }))));
  for (const title of titles) {
    const result = await getTaskEvent(token, { calendarId, eventId, taskId: task.id });
    assert.equal(result.text, 'Triage');
    assert.equal(result.done, title !== 'Triage');
  }
});

test('reconciliation pages through owned events, including an empty final page', async t => {
  simulate(t, url => {
    assert.equal(url.searchParams.get('privateExtendedProperty'), 'dayline=1');
    return reply({ items: [event(), event({ status: 'cancelled' }), event({ extendedProperties: {} })], nextPageToken: 'page2' });
  }, url => {
    assert.equal(url.searchParams.get('pageToken'), 'page2');
    return reply({ kind: 'calendar#events' });
  });
  const events = await listTaskEvents(token, { calendarId });
  assert.deepEqual(events.map(e => e.taskId), [task.id]);
});

test('confirmed deletion, lost calendar access, and temporary provider failures stay distinct', async t => {
  simulate(t,
    failure(404, 'notFound'), reply({ id: calendarId, accessRole: 'owner' }),
    failure(404, 'notFound'), failure(404, 'notFound'),
    reply({ id: eventId, status: 'cancelled' }), failure(410, 'deleted'),
    reply({ error: { errors: [{ reason: 'rateLimitExceeded' }], message: 'Slow down' } }, 429, { 'Retry-After': '60' }),
  );
  const read = () => getTaskEvent(token, { calendarId, eventId });
  assert.equal(await read(), null);
  await assert.rejects(read(), { status: 403, reason: 'calendarUnavailable' });
  assert.equal(await read(), null);
  assert.equal(await read(), null);
  await assert.rejects(read(), { status: 429, reason: 'rateLimitExceeded', retryAfterSeconds: 60 });
});

test('explicit deletion uses a verified version and can be retried after success', async t => {
  simulate(t, reply(event()), (url, init) => {
    assert.equal(init.method, 'DELETE');
    assert.equal(init.headers['If-Match'], '"v1"');
    return reply(null, 204);
  }, failure(404, 'notFound'), reply({ id: calendarId, accessRole: 'owner' }));
  const remove = () => deleteTaskEvent(token, { calendarId, eventId, taskId: task.id, expectedEtag: '"v1"' });
  await remove();
  await remove();
});

test('virtual Week Numbers feeds have no availability while user calendars with the same name remain eligible', async t => {
  const german = 'e_2_de#weeknum@group.v.calendar.google.com';
  const chinese = 'e_2_zh_TW#weeknum@group.v.calendar.google.com';
  const unlocalized = 'p#weeknum@group.v.calendar.google.com';
  const real = 'weeknum@group.calendar.google.com';
  const shared = 'e_2_de#weeknum@example.test';
  const items = [german, chinese, unlocalized, real, shared].map(id => ({ id, summary: 'Week Numbers', accessRole: 'reader' }));
  simulate(t, reply({ items }), (url, init) => {
    assert.deepEqual(JSON.parse(init.body).items, [{ id: real }, { id: shared }]);
    return reply({ calendars: { [real]: { busy: [] }, [shared]: { errors: [{ reason: 'notFound' }] } } });
  });
  const entries = await listCalendars(token);
  for (const id of [german, chinese, unlocalized]) {
    assert.equal(entries.find(c => c.id === id).canCheckAvailability, false);
  }
  for (const id of [real, shared]) assert.equal(entries.find(c => c.id === id).canCheckAvailability, true);
  await assert.rejects(getBusy(token, { calendarIds: [german, chinese, real, shared], start, end }), error =>
    error.reason === 'notFound' && error.calendarId === shared && !error.message.includes(shared));
  await assert.rejects(getBusy(token, { calendarIds: [unlocalized], start, end }), { reason: 'missingCalendars' });
});
