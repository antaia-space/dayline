// Stand-in for Google's token endpoint and Calendar API, ported from
// antaia-space/meet (test/fake-google.mjs) as an in-process fetch handler.
// It enforces scopes, so a test proves which permission each call needs.

const API = 'https://www.googleapis.com/calendar/v3';
const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const denied = () => json(403, { error: { code: 403, message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] } });

export function fakeGoogle({ accounts, clientId, identity = async () => undefined }) {
  const grants = new Map(accounts.map(account => [account.refresh, { account, revoked: false }]));
  const access = new Map();
  const events = new Map();
  const requests = [];
  let issued = 0;

  async function handle(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    const text = init.body == null ? '' : String(init.body);
    requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: text });

    if (url.href === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(text);
      const grant = grants.get(form.get('refresh_token'));
      if (form.get('client_id') !== clientId) return json(401, { error: 'invalid_client' });
      if (form.get('grant_type') !== 'refresh_token' || !grant || grant.revoked) {
        return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      }
      const wanted = (form.get('scope') || grant.account.scope).split(' ');
      // As Google does: a refresh may narrow the grant, and one that names a scope outside it is refused.
      if (wanted.some(s => !grant.account.scope.split(' ').includes(s))) return json(400, { error: 'invalid_scope', error_description: 'Bad Request' });
      const scope = wanted.join(' ');
      const token = 'access-' + grant.account.key + '-' + ++issued;
      access.set(token, { account: grant.account, scope });
      return json(200, { access_token: token, expires_in: 3600, scope, token_type: 'Bearer', id_token: await identity(grant.account) });
    }

    const session = access.get((init.headers?.Authorization ?? '').replace('Bearer ', ''));
    if (!session || grants.get(session.account.refresh).revoked) return json(401, { error: { code: 401, message: 'Invalid Credentials' } });
    const allowed = scope => session.scope.split(' ').some(s => s.endsWith('/auth/' + scope));
    const account = session.account;
    if (!url.href.startsWith(API)) return json(404, { error: { message: 'No such endpoint: ' + url.pathname } });
    const path = url.pathname.replace('/calendar/v3', '');

    if (path === '/users/me/calendarList') {
      if (!allowed('calendar.calendarlist.readonly')) return denied();
      return json(200, { kind: 'calendar#calendarList', items: account.calendars });
    }

    if (path === '/freeBusy') {
      if (!allowed('calendar.events.freebusy') && !allowed('calendar.events')) return denied();
      const body = JSON.parse(text), calendars = {};
      for (const { id } of body.items) {
        if (!account.calendars.some(c => c.id === id)) { calendars[id] = { errors: [{ domain: 'global', reason: 'notFound' }] }; continue; }
        const own = account.calendars.find(c => c.id === id).primary ? account.busy : [];
        const booked = [...events.values()].filter(e => e.calendar === id).map(e => ({ start: e.start.dateTime, end: e.end.dateTime }));
        calendars[id] = { busy: [...own, ...booked].filter(b => Date.parse(b.start) < Date.parse(body.timeMax) && Date.parse(b.end) > Date.parse(body.timeMin)) };
      }
      return json(200, { kind: 'calendar#freeBusy', calendars });
    }

    const match = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (match) {
      // Reading or writing an event's content needs event access; free/busy alone is not enough.
      if (!allowed('calendar.events')) return denied();
      const calendar = decodeURIComponent(match[1]), id = match[2];
      if (!account.calendars.some(c => c.id === calendar)) return json(404, { error: { code: 404, message: 'Not Found' } });
      if (method === 'GET' && !id) {
        const [name, value] = (url.searchParams.get('privateExtendedProperty') || '=').split('=');
        const items = [...events.values()].filter(e => e.calendar === calendar && (!name || e.extendedProperties?.private?.[name] === value) &&
          (!url.searchParams.get('timeMin') || Date.parse(e.end.dateTime) > Date.parse(url.searchParams.get('timeMin'))));
        return json(200, { kind: 'calendar#events', items });
      }
      if (method === 'POST') {
        const body = JSON.parse(text);
        if (events.has(body.id)) return json(409, { error: { code: 409, message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } });
        const event = { ...body, calendar, status: 'confirmed', etag: '"1"', hangoutLink: 'https://meet.google.com/fake-' + body.id.slice(3, 9),
          sendUpdates: url.searchParams.get('sendUpdates'), conferenceDataVersion: url.searchParams.get('conferenceDataVersion') };
        events.set(body.id, event);
        return json(200, event);
      }
      const event = events.get(id);
      if (!event || event.calendar !== calendar) return json(404, { error: { code: 404, message: 'Not Found' } });
      if (method === 'GET') return json(200, event);
      if (method === 'PATCH') {
        Object.assign(event, JSON.parse(text), { sendUpdates: url.searchParams.get('sendUpdates') });
        return json(200, event);
      }
      if (method === 'DELETE') {
        events.delete(id);
        return json(204);
      }
    }
    return json(404, { error: { message: 'No such endpoint: ' + url.pathname } });
  }

  return {
    fetch: handle, events, requests,
    revoke(refresh) { grants.get(refresh).revoked = true; },
    /** A meeting the owner made elsewhere, visible to free/busy only. */
    occupy(key, start, end) { accounts.find(a => a.key === key).busy.push({ start, end }); },
  };
}
