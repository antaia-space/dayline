// Google Calendar v3 and installed-app OAuth. The renderer never receives an access token.
// https://developers.google.com/identity/protocols/oauth2/native-app
// https://developers.google.com/workspace/calendar/api/guides/version-resources
import { CATEGORIES } from './planner.mjs';

const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AVAILABILITY_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
];
const SYNC_SCOPES = [...AVAILABILITY_SCOPES, 'https://www.googleapis.com/auth/calendar.events'];
const WRITABLE = new Set(['owner', 'writer', 'writerWithoutPrivateAccess']);
const EVENT_FIELDS = 'id,etag,status,summary,start,end,colorId,extendedProperties/private';
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

async function googleRequest(url, init = {}) {
  let response;
  let data;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
    const body = await response.text();
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
    if (retry && /^\d+$/.test(retry)) error.retryAfterSeconds = Number(retry);
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
  if (mode === 'sync') return SYNC_SCOPES;
  throw new GoogleError(400, 'invalidMode', 'Choose availability or calendar sync for this connection.');
}

export function authorizationUrl({ clientId, redirectUri, state, codeChallenge, mode = 'availability' }) {
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

async function paginatedItems(accessToken, url, kind) {
  const items = [];
  const seen = new Set();
  for (;;) {
    const page = await googleRequest(url.toString(), authorized(accessToken));
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
function canCheckAvailability(id) {
  return !/^[^#@\s]*#weeknum@group\.v\.calendar\.google\.com$/i.test(id);
}

export async function listCalendars(accessToken) {
  const url = new URL(API + '/users/me/calendarList');
  url.searchParams.set('showHidden', 'true');
  url.searchParams.set('maxResults', '250');
  url.searchParams.set('fields', 'kind,nextPageToken,items(id,summary,summaryOverride,backgroundColor,accessRole,primary,deleted)');
  const calendars = new Map();
  for (const item of await paginatedItems(accessToken, url, 'calendar#calendarList')) {
    if (item.deleted) continue;
    if (!item.id || !item.accessRole) throw invalidResponse('Google returned an incomplete calendar.');
    calendars.set(item.id, {
      id: item.id,
      name: item.summaryOverride || item.summary || item.id,
      canCheckAvailability: canCheckAvailability(item.id),
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

export async function getBusy(accessToken, { calendarIds, start, end }) {
  if (!Array.isArray(calendarIds) || !calendarIds.length || calendarIds.some(id => typeof id !== 'string' || !id)) {
    throw new GoogleError(400, 'missingCalendars', 'Select a calendar to check availability.');
  }
  if (!validInterval(start, end)) throw new GoogleError(400, 'invalidInterval', 'Choose a valid time range.');
  const ids = [...new Set(calendarIds)].filter(canCheckAvailability);
  if (!ids.length) throw new GoogleError(400, 'missingCalendars', 'Select at least one calendar that can report availability.');
  const intervals = [];

  // https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const data = await googleRequest(API + '/freeBusy', authorized(accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: start, timeMax: end, calendarExpansionMax: 50, items: batch.map(id => ({ id })) }),
    }));
    for (const id of batch) {
      const calendar = data.calendars?.[id];
      if (calendar?.errors?.length || !Array.isArray(calendar?.busy)) {
        const reason = calendar?.errors?.[0]?.reason ?? 'missingAvailability';
        const error = new GoogleError(503, reason, 'Google could not read availability for one of the selected calendars.');
        error.calendarId = id;
        throw error;
      }
      for (const period of calendar.busy) {
        if (!validInterval(period?.start, period?.end)) {
          const error = invalidResponse('Google returned an incomplete busy period.');
          error.calendarId = id;
          throw error;
        }
        intervals.push({ start: new Date(period.start).toISOString(), end: new Date(period.end).toISOString() });
      }
    }
  }
  return intervals.sort((a, b) => a.start.localeCompare(b.start));
}

function eventCollection(calendarId) {
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

function normalizeEvent(event, expectedTaskId) {
  const properties = event.extendedProperties?.private;
  const taskId = properties?.daylineTaskId ?? null;
  const owned = properties?.dayline === '1' && typeof taskId === 'string' && Boolean(taskId)
    && (expectedTaskId === undefined || taskId === expectedTaskId);
  const start = event.start?.dateTime ?? event.start?.date ?? null;
  const end = event.end?.dateTime ?? event.end?.date ?? null;
  if (!event.id || !event.etag || (owned && !validInterval(start, end))) {
    throw invalidResponse('Google returned an incomplete event. Sync again to check it.');
  }
  return { eventId: event.id, taskId, ...splitTitle(event.summary), start, end, etag: event.etag, owned };
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

export async function putTaskEvent(accessToken, { calendarId, eventId, task, actionUrl, expectedEtag }) {
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
  if (title !== previous.text || task.done !== previous.done) patch.summary = summary;
  if (color !== current.colorId) patch.colorId = color;
  const description = eventDescription(actionUrl, task.done, current.description);
  if (description !== current.description) patch.description = description;
  if (Date.parse(task.start) !== Date.parse(previous.start)) patch.start = { dateTime: task.start };
  if (Date.parse(task.end) !== Date.parse(previous.end)) patch.end = { dateTime: task.end };
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
