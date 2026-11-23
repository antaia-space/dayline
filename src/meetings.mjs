import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { DateTime } from 'luxon';
import { eventCollection, GoogleError, paginatedItems } from './google.mjs';

const fields = [
  'id,iCalUID,recurringEventId,originalStartTime(date,dateTime,timeZone),status,summary',
  'start(date,dateTime,timeZone),end(date,dateTime,timeZone),transparency,visibility',
  'htmlLink,location,description,hangoutLink,conferenceData/entryPoints(entryPointType,uri)',
  'organizer(displayName,email,self),attendees(displayName,email,responseStatus,optional,self,organizer)',
  'guestsCanSeeOtherGuests,attendeesOmitted,extendedProperties/private',
].join(',');
const publicFields = ['id', 'title', 'start', 'end', 'allDay', 'startDate', 'endDate', 'calendarName',
  'joinUrl', 'calendarUrl', 'location', 'organizer', 'attendees', 'attendeesOmitted', 'visibility', 'transparent'];
const responses = new Set(['accepted', 'declined', 'tentative', 'needsAction']);
const readerRoles = new Set(['reader', 'writerWithoutPrivateAccess', 'writer', 'owner']);
const privateRoles = new Set(['owner', 'writer']);
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function line(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

export function meetingLink(value, kind) {
  if (typeof value !== 'string' || value.length > 8192 || !/^https:\/\//i.test(value)
    || /[\s\\\u0000-\u001f\u007f]/.test(value) || /^https:\/\/[^/?#]*@/i.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !host.includes('.')
    || isIP(host.replace(/^\[|\]$/g, '')) || !host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
    || /(?:^|\.)(?:localhost|local|localdomain|lan|internal|intranet|corp|home|arpa|test|example|invalid|onion)$/.test(host)
    || /(?:^|\.)(?:example\.(?:com|org|net)|localtest\.me|lvh\.me|localhost\.direct|nip\.io|sslip\.io)$/.test(host)) return null;
  if (kind === 'calendar') {
    return ['calendar.google.com', 'www.google.com'].includes(host) && /^\/calendar\/(?:u\/\d+\/)?(?:r\/)?event(?:edit)?(?:\/|$)/.test(url.pathname) ? url.href : null;
  }
  return kind === 'join' ? url.href : null;
}

function conventionalJoin(value) {
  const href = meetingLink(value, 'join');
  if (!href) return null;
  const { hostname: host, pathname: path } = new URL(href);
  if (host === 'meet.google.com' && /^\/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|lookup\/[\w-]+)\/?$/i.test(path)) return href;
  if (/(?:^|\.)(?:zoom\.us|zoomgov\.com|zoom\.com)$/.test(host) && /^\/(?:[jsw]\/\d+|my\/[\w.-]+|wc\/(?:join\/\d+|\d+\/join))(?:\/|$)/i.test(path)) return href;
  if (/^(?:[\w-]+\.)?teams\.(?:microsoft\.(?:com|us)|live\.com|cloud\.microsoft)$/.test(host) && /^\/(?:l\/meetup-join|meet)\/.+/i.test(path)) return href;
  if (/(?:^|\.)webex\.com$/.test(host) && /\/(?:meet\/[^/]+|join\/[^/]+|j\.php|w\.php)\/?$/i.test(path)) return href;
  if ((host === 'meet.jit.si' || /(?:^|\.)whereby\.com$/.test(host) || host === 'meet.goto.com') && /^\/[\w-]+\/?$/.test(path)) return href;
  return null;
}

function joinUrl(event) {
  for (const point of Array.isArray(event.conferenceData?.entryPoints) ? event.conferenceData.entryPoints : []) {
    if (point?.entryPointType !== 'video') continue;
    const video = meetingLink(point.uri, 'join');
    if (video) return video;
  }
  const hangout = conventionalJoin(event.hangoutLink);
  if (hangout) return hangout;
  for (const text of [event.location, event.description]) {
    if (typeof text !== 'string') continue;
    for (const [candidate] of text.matchAll(/https:\/\/[^\s<>"'\\]+/gi)) {
      const url = candidate.split(/&(?:lt|gt|quot);/i)[0].replace(/&(?:amp|#38|#x26);/gi, '&').replace(/[.,;!?)\]}]+$/, '');
      const href = conventionalJoin(url);
      if (href) return href;
    }
  }
  return null;
}

function endpoint(part, zone) {
  if (part?.date && !part.dateTime && dateOnly.test(part.date)) {
    const day = DateTime.fromISO(part.date, { zone }).startOf('day');
    if (day.isValid && day.toISODate() === part.date) return { date: part.date, instant: day.toUTC().toISO() };
  } else if (typeof part?.dateTime === 'string' && !part.date && timestamp.test(part.dateTime)) {
    const time = DateTime.fromISO(part.dateTime, { zone: part.timeZone || zone });
    if (time.isValid) return { date: null, instant: time.toUTC().toISO() };
  }
  return null;
}

function person(value) {
  if (!value || typeof value !== 'object') return null;
  const email = typeof value.email === 'string' && value.email.length <= 320 && /^[^\s<>@,;]+@[^\s<>@,;]+$/.test(value.email) ? value.email : null;
  const name = line(value.displayName, 256) || email;
  return name ? { name, email } : null;
}

function viewer(value, calendar) {
  return Boolean((typeof value?.email === 'string' && typeof calendar.accountEmail === 'string' && value.email.toLowerCase() === calendar.accountEmail.toLowerCase())
    || (calendar.primary === true && value?.self === true));
}

function eventId(event, calendarId, timeZone) {
  let key = ['calendar', calendarId, event.id];
  if (typeof event.iCalUID === 'string' && event.iCalUID) {
    const original = endpoint(event.originalStartTime, timeZone);
    // A moved exception keeps its original occurrence identity. If Google
    // omits it, keep distinct instance IDs even if their current starts match.
    key = ['uid', event.iCalUID, original?.date || original?.instant || (event.recurringEventId ? event.id : null)];
  }
  return createHash('sha256').update(JSON.stringify(key)).digest('base64url');
}

function normalize(event, calendar, calendarId, timeZone) {
  if (typeof event?.id !== 'string' || !event.id || event.status === 'cancelled') return null;
  const marker = event.extendedProperties?.private;
  if (marker?.dayline === '1' && typeof marker.daylineTaskId === 'string' && calendar.representedTaskIds?.has(marker.daylineTaskId)) return null;
  const start = endpoint(event.start, timeZone);
  const end = endpoint(event.end, timeZone);
  if (!start || !end || Boolean(start.date) !== Boolean(end.date) || start.instant >= end.instant) return null;
  const visibility = ['public', 'private', 'confidential'].includes(event.visibility) ? event.visibility : 'default';
  const guests = Array.isArray(event.attendees) ? event.attendees : [];
  // An explicit invitation can grant more than the shared calendar's ACL.
  // Google's "self" on somebody else's shared calendar refers to that copy.
  const invited = viewer(event.organizer, calendar) || guests.some(guest => viewer(guest, calendar));
  const redacted = (visibility === 'private' || visibility === 'confidential') && !privateRoles.has(calendar.accessRole) && !invited;
  const organizer = redacted ? null : person(event.organizer);
  const restrictedGuests = event.guestsCanSeeOtherGuests === false && !viewer(event.organizer, calendar);
  const attendees = [];
  for (const guest of redacted ? [] : guests) {
    const identity = person(guest);
    if (!identity) continue;
    const self = viewer(guest, calendar);
    const isOrganizer = guest.organizer === true || Boolean(identity.email && organizer?.email && identity.email.toLowerCase() === organizer.email.toLowerCase());
    if (restrictedGuests && !self && !isOrganizer) continue;
    attendees.push({ ...identity, response: responses.has(guest.responseStatus) ? guest.responseStatus : null, optional: guest.optional === true, self, organizer: isOrganizer });
  }
  const attendeesOmitted = redacted || restrictedGuests || event.attendeesOmitted === true;
  const result = {
    id: eventId(event, calendarId, timeZone),
    title: redacted ? 'Private event' : line(event.summary, 512) || 'Untitled event',
    start: start.instant, end: end.instant, allDay: Boolean(start.date), startDate: start.date, endDate: end.date,
    calendarName: line(calendar.name, 256) || 'Calendar', visibility, transparent: event.transparency === 'transparent',
    organizer, attendees, attendeesOmitted,
    location: redacted ? null : line(event.location, 512) || null,
    joinUrl: redacted ? null : joinUrl(event), calendarUrl: redacted ? null : meetingLink(event.htmlLink, 'calendar'),
  };
  const declined = attendees.some(guest => guest.self && guest.response === 'declined');
  const detailCount = [result.organizer, result.location, result.calendarUrl, attendees.length, !attendeesOmitted, event.summary && !redacted].filter(Boolean).length;
  // Prefer a visible, active invitation and a complete copy with a join
  // action. Never reconstruct a guest list by combining separate calendars.
  result.copyPriority = [Number(!redacted), Number(!declined), Number(Boolean(result.joinUrl)), detailCount, Number(Boolean(calendar.primary)), attendees.length];
  return result;
}

export async function readCalendarMeetings(accessToken, calendar, { start, end, timeZone }, request = fetch) {
  if (calendar?.accessRole && !readerRoles.has(calendar.accessRole)) return [];
  const first = DateTime.fromISO(start, { zone: timeZone });
  const last = DateTime.fromISO(end, { zone: timeZone });
  if (!first.isValid || !last.isValid || first >= last || !timestamp.test(start) || !timestamp.test(end)) {
    throw new GoogleError(400, 'invalidRange', 'Choose a valid meeting date range and time zone.');
  }
  const calendarId = calendar?.providerId || calendar?.id;
  const url = new URL(eventCollection(calendarId));
  // Google filters all-day dates in the source calendar's timezone. Include
  // both interpretations of the viewport and clip normalized instants below.
  const sourceStart = first.setZone(calendar.timeZone || timeZone, { keepLocalTime: true });
  const sourceEnd = last.setZone(calendar.timeZone || timeZone, { keepLocalTime: true });
  const queryStart = sourceStart.isValid && sourceStart < first ? sourceStart : first;
  const queryEnd = sourceEnd.isValid && sourceEnd > last ? sourceEnd : last;
  url.search = new URLSearchParams({ singleEvents: 'true', showDeleted: 'false', orderBy: 'startTime', timeZone,
    timeMin: queryStart.toUTC().toISO(), timeMax: queryEnd.toUTC().toISO(), maxResults: '250',
    fields: 'kind,nextPageToken,items(' + fields + ')' });
  const items = await paginatedItems(accessToken, url, 'calendar#events', request);
  const from = first.toUTC().toISO();
  const until = last.toUTC().toISO();
  return items.map(item => normalize(item, calendar, calendarId === 'primary' ? calendar.accountEmail || calendar.id : calendarId, timeZone))
    .filter(item => item && item.start < until && item.end > from);
}

function compareCopies(a, b) {
  const left = a.copyPriority || [];
  const right = b.copyPriority || [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (right[i] ?? -1) - (left[i] ?? -1);
    if (difference) return difference;
  }
  return a.calendarName.localeCompare(b.calendarName) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title);
}

export function mergeMeetingCopies(events) {
  const selected = new Map();
  for (const event of events) {
    const previous = selected.get(event.id);
    if (!previous || compareCopies(event, previous) < 0) selected.set(event.id, event);
  }
  return [...selected.values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.id.localeCompare(b.id))
    .map(event => Object.fromEntries(publicFields.map(field => [field, event[field]])));
}
