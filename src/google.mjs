// Google Calendar v3 and installed-app OAuth. The renderer never receives an access token.
// https://developers.google.com/identity/protocols/oauth2/native-app
// https://developers.google.com/workspace/calendar/api/guides/version-resources
import { DateTime } from 'luxon';
import { CATEGORIES } from './planner.mjs';

const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AVAILABILITY_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
];
const MEETING_SCOPES = [...AVAILABILITY_SCOPES, 'https://www.googleapis.com/auth/calendar.events.readonly'];
const SYNC_SCOPES = [...AVAILABILITY_SCOPES, 'https://www.googleapis.com/auth/calendar.events'];
const WRITABLE = new Set(['owner', 'writer', 'writerWithoutPrivateAccess']);
const EVENT_FIELDS = 'id,etag,status,summary,start,end,updated,transparency,colorId,extendedProperties/private,creator(email,self),organizer(email,self),attendees(self),attendeesOmitted,recurrence,recurringEventId,hangoutLink,conferenceData/conferenceId,eventType';
const CHECK = '(?:[✓✔☑]\\uFE0F?|\\[x\\])';
const LEADING_CHECK = new RegExp('^(?:' + CHECK + '\\s*)+', 'iu');
const TRAILING_CHECK = new RegExp('(?:\\s*' + CHECK + ')+$', 'iu');

export class GoogleError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = 'GoogleError';
    this.status = status;
    this.reason = reason;
  }
}

function invalidResponse(message) {
  return new GoogleError(502, 'invalidResponse', message);
}

const notModified = Symbol('not modified');

async function googleRequest(url, init = {}, request = fetch, conditional = false, emptySuccess = false) {
  let response;
  let data;
  try {
    response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (conditional && response.status === 304) return notModified;
    const body = await response.text();
    if (emptySuccess && response.ok && !body) return null;
    try {
      data = JSON.parse(body);
    } catch {
      data = null;
    }
  } catch {
    throw new GoogleError(503, 'networkError', 'Could not reach Google. Check your connection and sync again.');
  }

  if (!response.ok) {
    const providerError = data?.error;
    const reason = typeof providerError === 'string'
      ? providerError
      : providerError?.errors?.[0]?.reason ?? providerError?.status ?? 'requestFailed';
    const message = providerError?.message ?? data?.error_description ?? 'Google returned HTTP ' + response.status + '.';
    const error = new GoogleError(response.status, reason, message);
    const retry = response.headers.get('retry-after');
    if (retry) {
      const seconds = /^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
      if (Number.isFinite(seconds)) error.retryAfterSeconds = Math.max(0, seconds);
    }
    throw error;
  }
  if (response.status === 204) return null;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw invalidResponse('Google returned an unreadable response. Sync again to check the result.');
  }
  return data;
}

function authorized(accessToken, options = {}) {
  return {
    ...options,
    headers: { ...options.headers, Authorization: 'Bearer ' + accessToken },
  };
}

function scopesFor(mode) {
  if (mode === 'availability') return AVAILABILITY_SCOPES;
  if (mode === 'details') return MEETING_SCOPES;
  if (mode === 'sync') return SYNC_SCOPES;
  throw new GoogleError(400, 'invalidMode', 'Choose availability or calendar sync for this connection.');
}

export function authorizationUrl({ clientId, redirectUri, state, codeChallenge, mode = 'availability', loginHint }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopesFor(mode).join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

async function requestToken({ clientId, clientSecret, mode, ...grant }) {
  const required = scopesFor(mode);
  const body = new URLSearchParams({ client_id: clientId, ...grant });
  if (clientSecret) body.set('client_secret', clientSecret);
  // An older refresh token can carry more permission than the account's current mode.
  if (grant.grant_type === 'refresh_token') body.set('scope', required.join(' '));
  const tokens = await googleRequest(TOKEN_URL, { method: 'POST', body });
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw invalidResponse('Google did not return an access token.');
  }
  if (tokens.scope !== undefined) {
    if (typeof tokens.scope !== 'string') throw invalidResponse('Google returned an unreadable permission list.');
    const granted = new Set(tokens.scope.trim().split(/\s+/).filter(Boolean));
    // Google can expand the OpenID email shorthand in the token response.
    if (granted.delete('https://www.googleapis.com/auth/userinfo.email')) granted.add('email');
    for (const scope of granted) {
      if (!required.includes(scope)) {
        throw new GoogleError(403, 'unexpectedScopes', 'Google returned access beyond the selected connection mode. Reconnect with the permissions shown in Dayline.');
      }
    }
    if (required.some(scope => !granted.has(scope))) {
      throw new GoogleError(403, 'insufficientScopes', 'Reconnect Google and allow the requested calendar permissions.');
    }
  }
  return tokens;
}

export function exchangeCode({ clientId, clientSecret, redirectUri, code, verifier, mode = 'availability' }) {
  return requestToken({
    clientId, clientSecret, mode, grant_type: 'authorization_code', redirect_uri: redirectUri,
    code, code_verifier: verifier,
  });
}

export function refreshToken({ clientId, clientSecret, refreshToken: refresh, mode = 'availability' }) {
  return requestToken({ clientId, clientSecret, mode, grant_type: 'refresh_token', refresh_token: refresh });
}

export async function getProfile(accessToken) {
  const profile = await googleRequest('https://openidconnect.googleapis.com/v1/userinfo', authorized(accessToken));
  if (profile.email_verified !== true || !profile.email || !profile.sub) {
    throw new GoogleError(403, 'unverifiedProfile', 'A verified Google email address is required to connect this account.');
  }
  return { sub: profile.sub, email: profile.email };
}

export async function paginatedItems(accessToken, url, kind, request = fetch) {
  const items = [];
  const seen = new Set();
  for (;;) {
    const page = await googleRequest(url.toString(), authorized(accessToken), request);
    if (Array.isArray(page.items)) {
      items.push(...page.items);
    } else if (page.items !== undefined || page.kind !== kind) {
      throw invalidResponse('Google returned an incomplete list.');
    }
    if (!page.nextPageToken) return items;
    if (seen.has(page.nextPageToken)) throw invalidResponse('Google returned a repeated page.');
    seen.add(page.nextPageToken);
    url.searchParams.set('pageToken', page.nextPageToken);
  }
}

// Google's virtual Week Numbers feed has a locale-dependent prefix. Its
// generated labels are never appointments and its freeBusy item returns notFound.
export function canCheckAvailability(id) {
  return !/^[^#@\s]*#weeknum@group\.v\.calendar\.google\.com$/i.test(id);
}

export async function listCalendars(accessToken) {
  const url = new URL(API + '/users/me/calendarList');
  url.searchParams.set('showHidden', 'true');
  url.searchParams.set('maxResults', '250');
  url.searchParams.set('fields', 'kind,nextPageToken,items(id,summary,summaryOverride,backgroundColor,accessRole,primary,deleted,timeZone)');
  const calendars = new Map();
  for (const item of await paginatedItems(accessToken, url, 'calendar#calendarList')) {
    if (item.deleted) continue;
    if (!item.id || !item.accessRole) throw invalidResponse('Google returned an incomplete calendar.');
    calendars.set(item.id, {
      id: item.id,
      name: item.summaryOverride || item.summary || item.id,
      accessRole: item.accessRole,
      timeZone: item.timeZone || null,
      canCheckAvailability: canCheckAvailability(item.id),
      canInspectReservations: item.accessRole === 'owner' || item.accessRole === 'writer',
      writable: canCheckAvailability(item.id) && WRITABLE.has(item.accessRole),
      primary: item.primary === true,
      color: item.backgroundColor ?? null,
    });
  }
  return [...calendars.values()].sort((a, b) =>
    Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function validInterval(start, end) {
  return Number.isFinite(Date.parse(start)) && Date.parse(start) < Date.parse(end);
}

export async function getBusyByCalendar(accessToken, { calendarIds, start, end }, request = fetch) {
  if (!Array.isArray(calendarIds) || !calendarIds.length || calendarIds.some(id => typeof id !== 'string' || !id)) {
    throw new GoogleError(400, 'missingCalendars', 'Select a calendar to check availability.');
  }
  if (!validInterval(start, end)) throw new GoogleError(400, 'invalidInterval', 'Choose a valid time range.');
  const ids = [...new Set(calendarIds)].filter(canCheckAvailability);
  if (!ids.length) throw new GoogleError(400, 'missingCalendars', 'Select at least one calendar that can report availability.');
  const results = [];

  // https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const data = await googleRequest(API + '/freeBusy', authorized(accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: start, timeMax: end, calendarExpansionMax: 50, items: batch.map(id => ({ id })) }),
    }), request);
    for (const id of batch) {
      const calendar = data.calendars?.[id];
      if (calendar?.errors?.length || !Array.isArray(calendar?.busy)) {
        const reason = calendar?.errors?.[0]?.reason ?? 'missingAvailability';
        const error = new GoogleError(503, reason, 'Google could not read availability for one of the selected calendars.');
        error.calendarId = id;
        throw error;
      }
      const busy = [];
      for (const period of calendar.busy) {
        if (!validInterval(period?.start, period?.end)) {
          const error = invalidResponse('Google returned an incomplete busy period.');
          error.calendarId = id;
          throw error;
        }
        busy.push({ start: new Date(period.start).toISOString(), end: new Date(period.end).toISOString() });
      }
      results.push({ calendarId: id, busy });
    }
  }
  return results;
}

export async function getBusy(accessToken, params) {
  return (await getBusyByCalendar(accessToken, params)).flatMap(calendar => calendar.busy).sort((a, b) => a.start.localeCompare(b.start));
}

// Google permits a lower time limit for the bootstrap, then syncToken alone
// carries updates, deletions and recurring exceptions. No event content is needed.
// https://developers.google.com/workspace/calendar/api/guides/sync
export async function readCalendarChangePage(accessToken, { calendarId, timeMin, syncToken, pageToken, etag }, request = fetch) {
  const url = new URL(eventCollection(calendarId));
  url.searchParams.set('maxResults', '2500');
  url.searchParams.set('singleEvents', 'false');
  url.searchParams.set('showDeleted', 'true');
  url.searchParams.set('fields', 'kind,etag,nextPageToken,nextSyncToken,items(etag)');
  if (syncToken) url.searchParams.set('syncToken', syncToken);
  else if (timeMin) url.searchParams.set('timeMin', timeMin);
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  const options = authorized(accessToken, { headers: etag ? { 'If-None-Match': etag } : {} });
  const page = await googleRequest(url.toString(), options, request, Boolean(etag));
  if (page === notModified) return { notModified: true };
  if (page.kind !== 'calendar#events' || (page.items !== undefined && !Array.isArray(page.items)) ||
      ![page.nextPageToken, page.nextSyncToken].some(value => typeof value === 'string' && value)) {
    throw invalidResponse('Google returned an incomplete calendar change cursor.');
  }
  return { etag: typeof page.etag === 'string' ? page.etag : null, nextPageToken: page.nextPageToken || null,
    nextSyncToken: page.nextSyncToken || null, hasChanges: Boolean(page.items?.length) };
}

// Watches contain a receiver-chosen opaque secret; the Google access token is
// sent only to Google. The relay never needs calendar IDs or event content.
// https://developers.google.com/workspace/calendar/api/v3/reference/events/watch
export async function watchCalendar(accessToken, { calendarId, channelId, channelToken, address, ttlSeconds = 604800 }, request = fetch) {
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || typeof channelId !== 'string' || !channelId ||
      channelId.length > 64 || typeof channelToken !== 'string' || !channelToken || channelToken.length > 256 ||
      !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 604800) {
    throw new GoogleError(400, 'invalidWatch', 'Invalid calendar notification channel.');
  }
  const response = await googleRequest(eventCollection(calendarId) + '/watch', authorized(accessToken, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: channelId, type: 'web_hook', token: channelToken, address: url.href, params: { ttl: String(ttlSeconds) } }),
  }), request);
  const expiration = Number(response.expiration);
  if (response.id !== channelId || typeof response.resourceId !== 'string' || !response.resourceId || !Number.isSafeInteger(expiration) || expiration <= 0) {
    throw invalidResponse('Google returned an incomplete notification channel.');
  }
  return { channelId, resourceId: response.resourceId, expiration };
}

export async function stopCalendarWatch(accessToken, { channelId, resourceId }, request = fetch) {
  if (!channelId || !resourceId) throw new GoogleError(400, 'invalidWatch', 'Missing calendar notification channel.');
  try {
    await googleRequest(API + '/channels/stop', authorized(accessToken, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: channelId, resourceId }) }), request, false, true);
  } catch (error) {
    if (error.status !== 404 && error.status !== 410) throw error;
  }
}

export function eventCollection(calendarId) {
  if (!calendarId || calendarId === '.' || calendarId === '..') {
    throw new GoogleError(400, 'invalidCalendar', 'Choose a destination calendar.');
  }
  return API + '/calendars/' + encodeURIComponent(calendarId) + '/events';
}

function checkEventId(id) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new GoogleError(400, 'invalidEventId', 'The calendar event ID is invalid.');
}

function splitTitle(summary) {
  const original = String(summary ?? '').trim();
  const text = original.replace(LEADING_CHECK, '').replace(TRAILING_CHECK, '').trim();
  return { text, done: text !== original };
}

function eventTime(endpoint) {
  if (!endpoint?.dateTime) return endpoint?.date ?? null;
  if (/(?:Z|[+-]\d\d:\d\d)$/i.test(endpoint.dateTime)) return endpoint.dateTime;
  // Google permits a local dateTime when the endpoint supplies its IANA zone.
  if (!endpoint.timeZone) return null;
  return DateTime.fromISO(endpoint.dateTime, { zone: endpoint.timeZone }).toUTC().toISO();
}

function normalizeEvent(event, expectedTaskId) {
  const properties = event.extendedProperties?.private;
  const taskId = properties?.daylineTaskId ?? null;
  const owned = properties?.dayline === '1' && typeof taskId === 'string' && Boolean(taskId)
    && (expectedTaskId === undefined || taskId === expectedTaskId);
  const start = eventTime(event.start);
  const end = eventTime(event.end);
  if (!event.id || !event.etag || (owned && !validInterval(start, end))) {
    throw invalidResponse('Google returned an incomplete event. Sync again to check it.');
  }
  const calendarAppointment = Boolean((event.organizer && !event.organizer.self) || (event.creator && !event.creator.self) ||
    event.attendeesOmitted || event.attendees?.some(person => !person.self) ||
    event.recurrence?.length || event.recurringEventId || event.hangoutLink || event.conferenceData?.conferenceId ||
    (event.eventType && event.eventType !== 'default'));
  return { eventId: event.id, taskId, ...splitTitle(event.summary), start, end, etag: event.etag, owned,
    ...(calendarAppointment && { calendarAppointment: true }), ...(event.transparency === 'transparent' && { transparent: true }),
    ...(Number.isFinite(Date.parse(event.updated)) && { updated: event.updated }) };
}

async function readEvent(accessToken, calendarId, eventId) {
  checkEventId(eventId);
  const url = new URL(eventCollection(calendarId) + '/' + eventId);
  url.searchParams.set('fields', EVENT_FIELDS + ',description');
  let event;
  try {
    event = await googleRequest(url.toString(), authorized(accessToken));
  } catch (error) {
    if (error.status === 410) return null;
    if (error.status !== 404) throw error;
    // A missing event and an inaccessible calendar can both produce 404.
    const calendarUrl = new URL(API + '/users/me/calendarList/' + encodeURIComponent(calendarId));
    calendarUrl.searchParams.set('fields', 'id,accessRole,deleted');
    let calendar;
    try {
      calendar = await googleRequest(calendarUrl.toString(), authorized(accessToken));
    } catch (calendarError) {
      if (calendarError.status !== 404 && calendarError.status !== 410) throw calendarError;
      throw new GoogleError(403, 'calendarUnavailable', 'The destination calendar is no longer accessible.');
    }
    if (calendar.deleted || !['writer', 'owner'].includes(calendar.accessRole)) {
      throw new GoogleError(403, 'calendarUnavailable', 'Dayline cannot confirm access to the destination event.');
    }
    return null;
  }
  if (event.id !== eventId) throw invalidResponse('Google returned an unexpected event.');
  return event.status === 'cancelled' ? null : event;
}

export async function getTaskEvent(accessToken, { calendarId, eventId, taskId }) {
  const event = await readEvent(accessToken, calendarId, eventId);
  return event ? normalizeEvent(event, taskId) : null;
}

export async function listTaskEvents(accessToken, { calendarId }) {
  const url = new URL(eventCollection(calendarId));
  url.searchParams.set('privateExtendedProperty', 'dayline=1');
  url.searchParams.set('maxResults', '2500');
  url.searchParams.set('fields', 'kind,nextPageToken,items(' + EVENT_FIELDS + ')');
  const entries = await paginatedItems(accessToken, url, 'calendar#events');
  return entries.filter(event => event.status !== 'cancelled').map(event => normalizeEvent(event)).filter(event => event.owned);
}

// Used only on a fully visible sync destination to test an edited reservation.
// Basic identifiers and visibility are sufficient to detect another busy event.
export async function hasOtherBusyEvent(accessToken, { calendarId, eventId, eventIds = [eventId], start, end }) {
  const expected = new Set(eventIds);
  if (!expected.size) throw new GoogleError(400, 'missingEvent', 'Choose the reservation to check.');
  for (const id of expected) checkEventId(id);
  if (!validInterval(start, end)) throw new GoogleError(400, 'invalidInterval', 'Choose a valid time range.');
  const url = new URL(eventCollection(calendarId));
  url.searchParams.set('timeMin', start);
  url.searchParams.set('timeMax', end);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('maxResults', '2500');
  url.searchParams.set('fields', 'kind,nextPageToken,items(id,status,transparency)');
  const events = await paginatedItems(accessToken, url, 'calendar#events');
  const live = events.filter(event => event?.status !== 'cancelled');
  const seen = new Set(live.map(event => event?.id));
  return [...expected].some(id => !seen.has(id)) || live.some(event => !expected.has(event?.id) && event?.transparency !== 'transparent');
}

// Free/busy merges simultaneous events. Remove the known reservation intervals
// from that union only after matching their IDs, private markers and ETags.
// Other opaque events can put part of an interval straight back into the result.
export async function busyWithoutReservations(accessToken, { calendarId, start, end, timeZone, reservations, confirm = false }) {
  const raw = await getBusy(accessToken, { calendarIds: [calendarId], start, end });
  const url = new URL(eventCollection(calendarId));
  url.search = new URLSearchParams({ timeMin: start, timeMax: end, singleEvents: 'true', maxResults: '2500',
    fields: 'kind,nextPageToken,items(id,etag,status,start,end,transparency,eventType,attendees(self,responseStatus),extendedProperties/private)' });
  const events = (await paginatedItems(accessToken, url, 'calendar#events')).filter(e => e.status !== 'cancelled');
  const byId = new Map(events.map(e => [e.id, e]));
  const intervals = raw.map(b => [Date.parse(b.start), Date.parse(b.end)]);
  let result = [...intervals];
  for (const ref of reservations) {
    const event = byId.get(ref.eventId), props = event?.extendedProperties?.private;
    if (!event || event.etag !== ref.etag || props?.dayline !== '1' || props.daylineTaskId !== ref.taskId ||
        Date.parse(eventTime(event.start)) !== Date.parse(ref.start) || Date.parse(eventTime(event.end)) !== Date.parse(ref.end)) {
      throw new GoogleError(412, 'conditionNotMet', 'A Dayline reservation changed in Google Calendar. Sync again to check its latest time.');
    }
    byId.delete(ref.eventId);
    const from = Date.parse(ref.start), until = Date.parse(ref.end);
    result = result.flatMap(([a,b]) => b <= from || a >= until ? [[a,b]] :
      [[a,Math.min(b,from)],[Math.max(a,until),b]].filter(([l,r]) => l < r));
  }
  const instant = endpoint => endpoint?.date && timeZone
    ? DateTime.fromISO(endpoint.date, { zone: timeZone }).toMillis() : Date.parse(endpoint?.dateTime && eventTime(endpoint));
  for (const event of byId.values()) {
    if (event.transparency === 'transparent' || event.eventType === 'workingLocation' ||
        event.attendees?.some(a => a.self && a.responseStatus === 'declined')) continue;
    const a = instant(event.start), b = instant(event.end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw invalidResponse('Google returned an incomplete busy period.');
    // On the last check, a new meeting seen by events.list can be newer than
    // the free/busy response above. It must veto the write immediately.
    const bounds = confirm ? [[Date.parse(start), Date.parse(end)]] : intervals;
    for (const [left,right] of bounds) {
      const from = Math.max(a,left), until = Math.min(b,right);
      if (from < until) result.push([from,until]);
    }
  }
  return result.map(([a,b]) => ({ start: new Date(a).toISOString(), end: new Date(b).toISOString() }));
}

function actionLink(actionUrl, done) {
  const url = new URL(actionUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new GoogleError(400, 'invalidActionUrl', 'The event needs a valid Dayline link.');
  }
  url.searchParams.set('done', done ? '0' : '1');
  const href = url.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return '<a href="' + href + '">' + (done ? 'Reopen task' : 'Mark complete') + '</a>';
}

function eventDescription(actionUrl, done, existing = '') {
  const link = actionLink(actionUrl, done);
  if (!existing) {
    return link + ' in Dayline on this Mac.<br>You can also add or remove ✓ at either end of the event title.';
  }
  if (existing.includes(link)) return existing;
  const previous = actionLink(actionUrl, !done);
  if (existing.includes(previous)) return existing.replace(previous, link);
  return existing + '<br>' + link;
}

function ownedResult(event, taskId, eventId) {
  const result = normalizeEvent(event, taskId);
  if (result.eventId !== eventId || !result.owned) {
    throw new GoogleError(409, 'ownershipMismatch', 'That calendar event belongs to another task.');
  }
  return result;
}

export async function putTaskEvent(accessToken, { calendarId, eventId, task, actionUrl, expectedEtag, completionAction, adjustingOverrun }) {
  const id = eventId ?? task.id.replaceAll('-', '');
  checkEventId(id);
  const color = CATEGORIES.find(category => category.id === task.category)?.googleColorId;
  const title = splitTitle(task.text).text;
  if (!task.id || !title || !color || !validInterval(task.start, task.end)) {
    throw new GoogleError(400, 'invalidTask', 'The task needs a title, category and time block.');
  }
  const collection = eventCollection(calendarId);
  const summary = (task.done ? '✓ ' : '') + title;
  const headers = { 'Content-Type': 'application/json' };

  if (expectedEtag == null) {
    const url = new URL(collection);
    url.searchParams.set('fields', EVENT_FIELDS);
    try {
      const event = await googleRequest(url.toString(), authorized(accessToken, {
        method: 'POST', headers,
        body: JSON.stringify({
          id, summary, colorId: color, description: eventDescription(actionUrl, task.done),
          start: { dateTime: task.start }, end: { dateTime: task.end },
          extendedProperties: { private: { dayline: '1', daylineTaskId: task.id } },
        }),
      }));
      return ownedResult(event, task.id, id);
    } catch (error) {
      if (error.status !== 409 || error.reason === 'ownershipMismatch') throw error;
      const existing = await readEvent(accessToken, calendarId, id);
      if (!existing) throw error;
      // A retry may follow a successful write with a lost response. Keep subsequent calendar edits.
      return ownedResult(existing, task.id, id);
    }
  }

  const current = await readEvent(accessToken, calendarId, id);
  if (!current) throw new GoogleError(410, 'eventDeleted', 'This calendar event was removed.');
  const previous = ownedResult(current, task.id, id);
  if (previous.etag !== expectedEtag) {
    throw new GoogleError(412, 'conditionNotMet', 'The event changed in Google Calendar. Sync its latest version.');
  }

  const patch = {};
  if (completionAction && previous.calendarAppointment) {
    throw new GoogleError(409, 'sharedAppointment', 'This shared calendar appointment keeps its existing time and availability.');
  }
  if (adjustingOverrun && (previous.calendarAppointment || previous.done || previous.transparent || current.start?.date)) {
    throw new GoogleError(409, 'fixedAppointment', 'This calendar appointment can no longer be extended automatically.');
  }
  if (completionAction === 'free' && !previous.transparent) patch.transparency = 'transparent';
  if (completionAction === 'book' && previous.transparent) patch.transparency = 'opaque';
  if (title !== previous.text || task.done !== previous.done) patch.summary = summary;
  if (color !== current.colorId) patch.colorId = color;
  const description = eventDescription(actionUrl, task.done, current.description);
  if (description !== current.description) patch.description = description;
  if (current.start?.date && task.start.includes('T')) {
    // Both dates must be cleared together when rescheduling an all-day block.
    patch.start = { date: null, dateTime: task.start };
    patch.end = { date: null, dateTime: task.end };
  } else {
    if (Date.parse(task.start) !== Date.parse(previous.start)) patch.start = { dateTime: task.start };
    if (Date.parse(task.end) !== Date.parse(previous.end)) patch.end = { dateTime: task.end };
  }
  if (!Object.keys(patch).length) return previous;

  const url = new URL(collection + '/' + id);
  url.searchParams.set('fields', EVENT_FIELDS);
  const updated = await googleRequest(url.toString(), authorized(accessToken, {
    method: 'PATCH', headers: { ...headers, 'If-Match': expectedEtag }, body: JSON.stringify(patch),
  }));
  return ownedResult(updated, task.id, id);
}

export async function deleteTaskEvent(accessToken, { calendarId, eventId, taskId, expectedEtag }) {
  if (!taskId) throw new GoogleError(400, 'missingTaskId', 'Choose the task to remove.');
  const current = await readEvent(accessToken, calendarId, eventId);
  if (!current) return;
  const event = ownedResult(current, taskId, eventId);
  if (expectedEtag != null && event.etag !== expectedEtag) {
    throw new GoogleError(412, 'conditionNotMet', 'The event changed in Google Calendar. Sync its latest version.');
  }
  try {
    await googleRequest(eventCollection(calendarId) + '/' + eventId, authorized(accessToken, {
      method: 'DELETE', headers: { 'If-Match': event.etag },
    }));
  } catch (error) {
    if (error.status !== 404 && error.status !== 410) throw error;
    // Another client can delete the event between our read and conditional delete.
    if (await readEvent(accessToken, calendarId, eventId)) throw error;
  }
}
