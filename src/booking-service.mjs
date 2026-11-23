// Booking links: which times a guest may book, and the calendar event a
// booking becomes. Google Calendar is the only store of bookings. Rules ported
// from antaia-space/meet (src/lib/booking.ts, booking.config.ts).
import { computeSlots, isValidTimeZone, WEEKDAYS } from './booking-slots.mjs';
import { explicitStartFor } from './planner.mjs';
import { invalid, withoutSlots } from './service.mjs';

const MINUTE = 60_000, DAY = 86_400_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REQUEST_ID = /^[0-9a-v]{24}$/;
const TOKEN = /^[0-9a-v]{24}\.[A-Za-z0-9_-]{27}$/;
// Event id prefixes. The meeting-notes job in antaia-brain (.claude/granola_sync.py)
// copies notes of "bkb" meetings to the company wiki and never copies "bkp" ones.
export const ID_PREFIX_WIKI = 'bkb';
export const ID_PREFIX_PRIVATE = 'bkp';
// A request that waited for a sleeping Mac is still confirmed this close to its start, not closer.
export const CONFIRM_LEAD = 30 * MINUTE;
const typeFields = ['slug', 'title', 'description', 'durationMin', 'slotStepMin', 'bufferMin', 'minNoticeMin', 'maxDaysAhead', 'hidden', 'notesToWiki', 'hours', 'accountSub'];
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const whole = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const line = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const iso = ms => new Date(ms).toISOString();

export function defaultBooking() {
  const type = (slug, title, description, durationMin, slotStepMin, extra = {}) => ({ slug, title, description, durationMin, slotStepMin,
    bufferMin: 15, minNoticeMin: 12 * 60, maxDaysAhead: 45, hidden: false, notesToWiki: true, hours: null, ...extra });
  return {
    enabled: false, published: false, owner: { name: '', headline: 'Antaia' }, accountSub: null, calendarId: null, notices: [],
    types: [
      type('intro', 'Intro call', 'A short first conversation.', 15, 15),
      type('meeting', 'Meeting', 'A regular working call.', 30, 30),
      type('deep-dive', 'Deep dive', 'A longer session for technical or commercial detail.', 60, 60),
      type('private', 'Private call', 'A confidential conversation.', 30, 30, { hidden: true, notesToWiki: false }),
    ],
  };
}

export function bookingState(service) {
  return service.data.booking ??= defaultBooking();
}

/** An account whose Google grant includes event writes. */
export function canWriteBookings(account) {
  return account?.booking === true || account?.mode === 'sync';
}

// Every meeting type is booked with one connected Google address: the meeting
// lands in that account's calendar and Google invites the guest from it. A type
// saved before addresses had their own types belongs to the first address chosen.
function firstAddress(service) {
  const state = service.data.booking, accounts = service.data.accounts;
  if (accounts.some(a => a.sub === state?.accountSub)) return state.accountSub;
  return (accounts.find(a => a.email?.toLowerCase().endsWith('@antaia.space')) ?? accounts[0])?.sub ?? null;
}

export function addressOf(service, type) {
  return service.data.accounts.some(a => a.sub === type.accountSub) ? type.accountSub : firstAddress(service);
}

/** True while this account's access token must be able to create booked meetings. */
export function writesBookings(service, account) {
  const state = service.data.booking;
  return Boolean(state?.enabled && canWriteBookings(account) && state.types.some(type => addressOf(service, type) === account.sub));
}

/**
 * For each connected address: the calendar its bookings go to, and whether
 * Dayline may write there. Without a choice, bookings go to the primary calendar.
 */
export function bookingTargets(service) {
  const state = bookingState(service);
  const chosen = { ...(state.accountSub && state.calendarId && { [state.accountSub]: state.calendarId }), ...state.calendars };
  return new Map(service.data.accounts.map(account => {
    const own = service.calendars.filter(c => c.sub === account.sub && c.writable);
    const calendar = own.find(c => c.id === chosen[account.sub]) ?? own.find(c => c.primary) ?? null;
    return [account.sub, { account, calendar, ready: Boolean(calendar && canWriteBookings(account)) }];
  }));
}

function checkedTypes(service, input) {
  if (!Array.isArray(input) || !input.length || input.length > 20) throw invalid('Keep between 1 and 20 meeting types.');
  const seen = new Set();
  return input.map(t => {
    if (!t || typeof t !== 'object' || Object.keys(t).some(key => !typeFields.includes(key))) throw invalid('Unknown meeting type setting.');
    const title = line(t.title, 80);
    if (!title) throw invalid('Give every meeting type a title.');
    if (typeof t.slug !== 'string' || !SLUG.test(t.slug) || t.slug === 'booking') throw invalid('“' + title + '” needs a link name made of a–z, 0–9 and “-”.');
    if (seen.has(t.slug)) throw invalid('Two meeting types share the link name “' + t.slug + '”.');
    seen.add(t.slug);
    if (!whole(t.durationMin, 5, 480)) throw invalid('“' + title + '” needs a length between 5 minutes and 8 hours.');
    if (!whole(t.slotStepMin, 5, 240)) throw invalid('“' + title + '” needs a time step between 5 minutes and 4 hours.');
    if (!whole(t.bufferMin, 0, 240)) throw invalid('“' + title + '” needs a gap between 0 minutes and 4 hours.');
    if (!whole(t.minNoticeMin, 0, 30 * 24 * 60)) throw invalid('“' + title + '” needs a minimum notice of at most 30 days.');
    if (!whole(t.maxDaysAhead, 1, 90)) throw invalid('“' + title + '” can be booked between 1 and 90 days ahead.');
    if (t.accountSub != null && !service.data.accounts.some(a => a.sub === t.accountSub)) throw invalid('Choose a connected Google address for “' + title + '”.');
    return { slug: t.slug, title, description: line(t.description, 300), durationMin: t.durationMin, slotStepMin: t.slotStepMin,
      bufferMin: t.bufferMin, minNoticeMin: t.minNoticeMin, maxDaysAhead: t.maxDaysAhead, hidden: t.hidden === true, notesToWiki: t.notesToWiki !== false,
      hours: checkedHours(t.hours, title), accountSub: t.accountSub ?? firstAddress(service) };
  });
}

// A meeting type can keep its own weekly hours. Without them it follows the
// planner's working hours. Either way, busy calendars still block time.
function checkedHours(input, title) {
  if (input == null) return null;
  const problem = invalid('“' + title + '” needs weekly hours with a start before the end on at least one day.');
  if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(day => !WEEKDAYS.includes(day))) throw problem;
  const hours = {};
  for (const day of WEEKDAYS) {
    const windows = input[day] ?? [];
    if (!Array.isArray(windows) || windows.length > 3) throw problem;
    for (const window of windows) {
      if (!window || !CLOCK.test(window.start) || !(CLOCK.test(window.end) || window.end === '24:00') || window.start >= window.end) throw problem;
    }
    if (windows.length) hours[day] = windows.map(({ start, end }) => ({ start, end }));
  }
  if (!Object.keys(hours).length) throw problem;
  return hours;
}

const hoursFor = (type, settings) => type.hours ?? bookingHours(settings);

export function updateBooking(service, input) {
  const state = bookingState(service);
  if (!input || Object.keys(input).some(key => !['enabled', 'owner', 'calendarId', 'calendars', 'types'].includes(key))) throw invalid('Unknown booking setting.');
  const next = { ...state, calendars: { ...state.calendars } };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw invalid('Choose whether to offer booking links.');
    next.enabled = input.enabled;
  }
  if (input.owner !== undefined) next.owner = { name: line(input.owner?.name, 100), headline: line(input.owner?.headline, 100) };
  if (input.types !== undefined) next.types = checkedTypes(service, input.types);
  const writable = id => {
    const calendar = service.calendars.find(c => c.id === id);
    if (!calendar?.writable) throw invalid('Choose a calendar you can add meetings to.');
    return calendar;
  };
  if (input.calendarId !== undefined && input.calendarId !== state.calendarId) {
    const calendar = writable(input.calendarId);
    Object.assign(next, { calendarId: calendar.id, accountSub: calendar.sub });
    next.calendars[calendar.sub] = calendar.id;
  }
  // One calendar per address: where the meetings booked with that address go.
  if (input.calendars !== undefined) {
    if (!input.calendars || typeof input.calendars !== 'object' || Array.isArray(input.calendars)) throw invalid('Choose a calendar you can add meetings to.');
    for (const [sub, id] of Object.entries(input.calendars)) {
      if (writable(id).sub !== sub) throw invalid('Choose a calendar of that Google address.');
      next.calendars[sub] = id;
    }
  }
  if (next.enabled && !next.owner.name) throw invalid('Enter the name guests should see.');
  if (next.enabled && !service.data.accounts.length) throw invalid('Connect a Google account under Settings → Calendars first.');
  Object.assign(state, next);
  service.store.save();
}

export function dismissBookingNotice(service, id) {
  const state = bookingState(service);
  state.notices = state.notices.filter(notice => notice.id !== id);
  service.store.save();
}

/** What the Bookings tab shows. Nothing here is a secret. */
export function publicBooking(service) {
  const state = bookingState(service);
  return {
    enabled: state.enabled, owner: { ...state.owner }, notices: structuredClone(state.notices),
    types: state.types.map(type => ({ ...structuredClone(type), accountSub: addressOf(service, type) })),
    // One section per connected address in the Bookings tab.
    addresses: [...bookingTargets(service).values()].map(({ account, calendar }) => ({
      sub: account.sub, email: account.email, access: canWriteBookings(account), calendarId: calendar?.id ?? null,
      calendars: service.calendars.filter(c => c.sub === account.sub && c.writable).map(c => ({ id: c.id, name: c.name })),
    })),
  };
}

function bookingHours(settings) {
  const hours = {};
  // Dayline counts Monday as 1 and Sunday as 7.
  for (const day of settings.workDays) hours[WEEKDAYS[day % 7]] = [{ start: settings.startTime, end: settings.endTime }];
  return hours;
}

function fixedTasks(service) {
  const zone = service.data.settings.timeZone;
  return service.data.tasks.filter(t => t.start && t.end && !t.deleting && !t.done && !t.pendingEstimate && explicitStartFor(t, zone));
}

// Busy time for bookings: the calendars Dayline checks for conflicts, read as
// free/busy only, plus tasks pinned to an exact time. Flexible tasks do not
// block a booking; Dayline replans them around it as it does for any meeting.
export async function bookingBusy(service, fromMs, toMs, { confirm = false } = {}) {
  const syncing = service.data.settings.calendarMode === 'sync';
  const movable = syncing ? service.data.tasks.filter(t => t.remote && service.movableFlexibleEvent(t)) : [];
  let busy = [];
  if (confirm && movable.length) {
    // Before a write, Dayline's own task events are told apart from real meetings by event id.
    const range = { start: iso(fromMs), end: iso(toMs) };
    const inside = movable.filter(t => Date.parse(t.start) < toMs && Date.parse(t.end) > fromMs);
    busy = await service.availability(range, undefined, inside.map(t => ({ ...t.remote, taskId: t.id, start: t.start, end: t.end })), 'confirm');
  } else {
    for (let cursor = fromMs; cursor < toMs; cursor += 28 * DAY) {
      busy.push(...await service.availability({ start: iso(cursor), end: iso(Math.min(toMs, cursor + 28 * DAY)) }));
    }
    busy = withoutSlots(busy, movable);
  }
  return [...busy, ...fixedTasks(service)].map(({ start, end }) => ({ start: Date.parse(start), end: Date.parse(end) }));
}

const transient = error => !error?.status || error.status >= 500 || error.status === 429 || error.status === 423 || error.status === 412;
const publicType = ({ slug, title, description, durationMin, bufferMin, minNoticeMin, maxDaysAhead, hidden }) =>
  ({ slug, title, description, durationMin, bufferMin, minNoticeMin, maxDaysAhead, hidden });

/**
 * Everything the public page needs, and nothing else: the display name, the
 * meeting types, and the start times that are free. When the calendars cannot
 * be read the page is paused: offering times blind could double-book.
 */
export async function bookingSnapshot(service, now = service.clock().getTime()) {
  const state = bookingState(service), settings = service.data.settings;
  const page = { owner: { ...state.owner }, types: state.types.map(publicType), slots: {}, paused: null };
  try {
    if (service.data.accounts.length && !service.calendars.length) await service.discover();
    const targets = bookingTargets(service);
    const used = [...new Set(state.types.map(type => addressOf(service, type)))].map(sub => targets.get(sub)).filter(target => target?.ready);
    if (!used.length) return { page: { ...page, paused: 'setup' } };
    const horizon = Math.max(...state.types.map(t => t.maxDaysAhead));
    // Busy time is the same whichever address a guest books: every calendar checked for conflicts counts.
    const busy = await bookingBusy(service, now, now + (horizon + 1) * DAY);
    for (const type of state.types) {
      // A type whose address may not write events yet offers no times.
      // The receiver stores at most 3,000 start times per type; the nearest ones come first.
      page.slots[type.slug] = !targets.get(addressOf(service, type))?.ready ? []
        : computeSlots({ type: { ...type, hours: hoursFor(type, settings), dateOverrides: {} }, ownerTimeZone: settings.timeZone,
          fromMs: now, toMs: now + type.maxDaysAhead * DAY, nowMs: now, busy }).slice(0, 3000);
    }
    const titles = new Map(state.types.map(t => [t.slug, t.title]));
    const bookings = [], upcoming = [];
    for (const { account, calendar } of used) {
      const events = await service.google.listBookingEvents(await service.token(account.sub), { calendarId: calendar.providerId, timeMin: iso(now) });
      bookings.push(...events.filter(e => SLUG.test(e.type)).map(e => ({ id: e.eventId.slice(3), type: e.type, start: e.start, end: e.end })));
      // For the Bookings tab on this Mac only: who booked what. The receiver gets `bookings`, which names nobody.
      upcoming.push(...events.map(e => ({ id: e.eventId, type: titles.get(e.type) || 'Meeting', start: e.start, end: e.end, name: e.name, email: e.email,
        address: account.email })));
    }
    upcoming.sort((a, b) => a.start - b.start);
    return { page, bookings, upcoming };
  } catch (error) {
    if (transient(error)) throw error; // The last published times stay until Google answers again.
    const reconnect = error.status === 401 || error.status === 409 || /invalid_grant|insufficientScopes|unexpectedScopes/.test(error.reason || '');
    return { page: { ...page, slots: {}, paused: reconnect ? 'reconnect' : 'unavailable' }, problem: error.message };
  }
}

function notice(service, kind, reason, request, type) {
  const state = bookingState(service);
  if (state.notices.some(n => n.id === request.id)) return;
  state.notices = [...state.notices, { id: request.id, at: iso(service.clock().getTime()), kind, reason,
    name: line(request.guest?.name, 100), email: line(request.guest?.email, 254), type: type?.title || line(request.type, 80),
    start: Number.isSafeInteger(request.start) ? iso(request.start) : null }].slice(-20);
  service.store.save();
}

const notReady = () => invalid('Booked meetings need a calendar with event access. Check the Bookings tab.', 409);

// A booked event is looked up by its id in the given addresses' calendars.
async function findBooking(service, targets, id, first = ID_PREFIX_WIKI) {
  for (const target of targets) {
    const token = await service.token(target.account.sub), calendarId = target.calendar.providerId;
    for (const prefix of first === ID_PREFIX_WIKI ? [ID_PREFIX_WIKI, ID_PREFIX_PRIVATE] : [ID_PREFIX_PRIVATE, ID_PREFIX_WIKI]) {
      const event = await service.google.getBookingEvent(token, { calendarId, eventId: prefix + id });
      if (event) return { event, token, calendarId };
    }
  }
  return null;
}

async function stillFree(service, type, start, end, now) {
  const settings = service.data.settings, gap = type.bufferMin * MINUTE;
  const busy = await bookingBusy(service, start - gap, end + gap, { confirm: true });
  // The guest met the minimum notice when asking; a Mac that slept must not undo that.
  return computeSlots({ type: { ...type, minNoticeMin: 0, hours: hoursFor(type, settings), dateOverrides: {} }, ownerTimeZone: settings.timeZone,
    fromMs: start, toMs: start + 1, nowMs: now, busy }).includes(start);
}

/**
 * Answers one request the receiver handed over: create, move or delete the
 * calendar event. The receiver is not trusted: every field is checked again and
 * the calendar is read again. A thrown error leaves the request waiting.
 */
export async function settleBooking(service, request, { pageUrl, now = service.clock().getTime() }) {
  if (!request || !REQUEST_ID.test(request.id || '')) throw invalid('Invalid booking request.');
  const state = bookingState(service), { id, kind } = request;
  const targets = bookingTargets(service), ready = [...targets.values()].filter(target => target.ready);
  if (!state.enabled || !ready.length) throw notReady();

  if (kind === 'cancel') {
    const found = await findBooking(service, ready, id);
    if (found) await service.google.cancelBookingEvent(found.token, { calendarId: found.calendarId, eventId: found.event.eventId });
    return { id, kind, ok: true };
  }

  const { start, end } = request;
  const timed = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < end;
  if (kind === 'move') {
    const refused = { id, kind, ok: false, start, end };
    const found = await findBooking(service, ready, id);
    if (!found || !timed) return refused;
    const { event } = found;
    if (event.start === start && event.end === end) return { id, kind, ok: true, start, end };
    const type = state.types.find(t => t.slug === event.type);
    if (!type || end - start !== type.durationMin * MINUTE || start - now < CONFIRM_LEAD || !await stillFree(service, type, start, end, now)) return refused;
    const moved = await service.google.moveBookingEvent(found.token, { calendarId: found.calendarId, eventId: event.eventId, start, end });
    return { id, kind, ok: true, start: moved.start, end: moved.end };
  }

  if (kind !== 'book') throw invalid('Unknown booking request.');
  const type = state.types.find(t => t.slug === request.type);
  // The meeting goes to the calendar of the address this type is booked with.
  const target = type ? targets.get(addressOf(service, type)) : ready[0];
  if (!target?.ready) throw notReady();
  const { account } = target, calendarId = target.calendar.providerId;
  const token = await service.token(account.sub);
  const prefix = type?.notesToWiki === false ? ID_PREFIX_PRIVATE : ID_PREFIX_WIKI;
  // A retry after a lost answer finds the event it already made.
  const existing = (await findBooking(service, [target], id, prefix))?.event;
  if (existing) return { id, kind, ok: true, start: existing.start, end: existing.end };
  const guest = { name: line(request.guest?.name, 100), email: line(request.guest?.email, 254).toLowerCase(), timeZone: line(request.guest?.timeZone, 64) };
  const notes = typeof request.guest?.notes === 'string' ? request.guest.notes.trim().slice(0, 2000) : '';
  const refuse = reason => {
    notice(service, reason === 'expired' ? 'expired' : 'declined', reason, request, type);
    return { id, kind, ok: false, reason };
  };
  if (!timed || !type || end - start !== type.durationMin * MINUTE || guest.name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(guest.email) ||
      !isValidTimeZone(guest.timeZone) || !TOKEN.test(request.token || '') || !request.token.startsWith(id + '.')) return refuse('unavailable');
  if (request.expired === true || start - now < CONFIRM_LEAD) return refuse('expired');
  if (!await stillFree(service, type, start, end, now)) return refuse('taken');
  const event = await service.google.createBookingEvent(token, {
    calendarId, eventId: prefix + id, title: type.title + ': ' + guest.name + ' and ' + state.owner.name,
    description: service.google.bookingDescription({ about: type.description, guest, notes, manageUrl: pageUrl + '/booking/' + request.token }),
    start, end, ownerEmail: account.email, guest, type: type.slug,
  });
  return { id, kind, ok: true, start: event.start, end: event.end };
}
