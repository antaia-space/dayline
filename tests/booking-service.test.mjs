// Booking links on the Mac: settings, which times are offered, and how
// Dayline's own tasks count, with tasks kept local and with tasks synced.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DaylineService } from '../src/service.mjs';
import { bookingSnapshot, bookingState, canWriteBookings, defaultBooking, publicBooking, settleBooking, updateBooking } from '../src/booking-service.mjs';
import { defaultSettings } from '../src/store.mjs';

const MINUTE = 60_000;
// Monday 23 November 2026, 08:00 UTC; working hours 09:00–17:00 UTC.
const now = Date.parse('2026-11-23T08:00:00Z');
const at = (clock, day = 24) => Date.parse('2026-11-' + day + 'T' + clock + ':00Z');
const iso = ms => new Date(ms).toISOString();
const failure = (status, reason) => Object.assign(new Error(reason), { status, reason });

class MemoryStore {
  constructor(state) { this.state = structuredClone(state); }
  save() { this.saved = structuredClone(this.state); }
}

// Models what booking needs from Google: free/busy per calendar, Dayline's own
// task events told apart by id, and the booking events themselves.
class Google {
  meetings = [];
  taskEvents = new Map();
  bookings = new Map();
  refreshModes = [];
  failRefresh = null;
  refreshToken({ refreshToken, mode }) {
    if (this.failRefresh) throw this.failRefresh;
    this.refreshModes.push(refreshToken + ':' + mode);
    return { access_token: refreshToken, expires_in: 3600 };
  }
  listCalendars(account) {
    return [{ id: account + '-primary', name: account, primary: true, writable: true, accessRole: 'owner', canCheckAvailability: true, canInspectReservations: true }];
  }
  occupied(account, start, end, withTasks) {
    const blocks = [...this.meetings.filter(m => m.account === account), ...[...this.bookings.values()].filter(b => b.account === account),
      ...(withTasks && account === 'work' ? this.taskEvents.values() : [])];
    return blocks.filter(b => Date.parse(b.end) > Date.parse(start) && Date.parse(b.start) < Date.parse(end)).map(b => ({ start: b.start, end: b.end }));
  }
  getBusy(account, { start, end }) { return this.occupied(account, start, end, true); }
  busyWithoutReservations(account, { start, end, reservations }) {
    for (const ref of reservations) assert.equal(this.taskEvents.get(ref.eventId)?.start, ref.start);
    return this.occupied(account, start, end, false);
  }
  // A booked event lives in one account's calendar and is visible only through that account.
  held(access, calendarId) { return [...this.bookings.values()].filter(b => b.account === access && b.calendarId === calendarId); }
  found(b) { return { eventId: b.eventId, type: b.type, name: b.name, email: b.email, start: Date.parse(b.start), end: Date.parse(b.end) }; }
  listBookingEvents(access, { calendarId }) { return this.held(access, calendarId).map(b => this.found(b)); }
  getBookingEvent(access, { calendarId, eventId }) {
    const b = this.held(access, calendarId).find(event => event.eventId === eventId);
    return b ? this.found(b) : null;
  }
  bookingDescription({ manageUrl }) { return manageUrl; }
  createBookingEvent(access, { calendarId, eventId, start, end, type, title, description, ownerEmail, guest }) {
    this.bookings.set(eventId, { account: access, calendarId, eventId, type, title, description, ownerEmail, name: guest.name, email: guest.email, start: iso(start), end: iso(end) });
    return { eventId, type, start, end };
  }
  moveBookingEvent(access, { calendarId, eventId, start, end }) {
    const [b] = this.held(access, calendarId).filter(event => event.eventId === eventId);
    Object.assign(b, { start: iso(start), end: iso(end) });
    return this.found(b);
  }
  cancelBookingEvent(access, { calendarId, eventId }) {
    if (this.held(access, calendarId).some(event => event.eventId === eventId)) this.bookings.delete(eventId);
  }
}

function planner({ calendarMode = 'availability', tasks = [], accounts } = {}) {
  const google = new Google();
  const store = new MemoryStore({ version: 1, tasks, lastSync: null, agent: { provider: 'local' }, client: JSON.stringify({ clientId: 'c', clientSecret: '' }),
    settings: { ...defaultSettings(), timeZone: 'UTC', calendarMode },
    accounts: accounts ?? [{ sub: 'work', email: 'urs@antaia.space', secret: 'work', mode: calendarMode, booking: calendarMode !== 'sync' },
      { sub: 'home', email: 'urs@example.test', secret: 'home', mode: 'availability' }] });
  const service = new DaylineService({ store, google, vault: { seal: async v => v, open: async v => v }, clock: () => new Date(now) });
  return { service, google };
}

async function ready(options) {
  const p = planner(options);
  await p.service.discover();
  const work = p.service.calendars.find(c => c.sub === 'work');
  updateBooking(p.service, { owner: { name: 'Urs Wilcke', headline: 'Antaia' }, calendarId: work.id, enabled: true });
  return p;
}

const tuesday = slots => slots.filter(ms => ms < at('00:00', 25)).map(ms => iso(ms).slice(11, 16));
const request = (start, extra = {}) => ({ kind: 'book', id: 'a'.repeat(24), token: 'a'.repeat(24) + '.' + 'S'.repeat(27), type: 'meeting', start, end: start + 30 * MINUTE,
  guest: { name: 'Ada Guest', email: 'ada@example.test', timeZone: 'Europe/Zurich', notes: '' }, createdAt: now, expired: false, ...extra });
const pageUrl = 'https://book.example.invalid/urs';

test('booking settings start from the meet defaults and are validated', async () => {
  const { service } = planner();
  const state = bookingState(service);
  assert.deepEqual(state.types.map(t => [t.slug, t.durationMin, t.bufferMin, t.minNoticeMin, t.maxDaysAhead, t.hidden, t.notesToWiki]), [
    ['intro', 15, 15, 720, 45, false, true], ['meeting', 30, 15, 720, 45, false, true],
    ['deep-dive', 60, 15, 720, 45, false, true], ['private', 30, 15, 720, 45, true, false]]);
  assert.equal(state.enabled, false);

  const bad = (input, message) => assert.throws(() => updateBooking(service, input), message);
  bad({ enabled: true }, /Enter the name guests should see/);
  assert.throws(() => updateBooking(planner({ accounts: [] }).service, { owner: { name: 'Urs' }, enabled: true }), /Connect a Google account/);
  bad({ calendarId: 'unknown' }, /Choose a calendar you can add meetings to/);
  bad({ secret: 'x' }, /Unknown booking setting/);
  const type = defaultBooking().types[0];
  bad({ types: [] }, /between 1 and 20/);
  bad({ types: [{ ...type, slug: 'Intro Call' }] }, /link name/);
  bad({ types: [{ ...type, slug: 'booking' }] }, /link name/);
  bad({ types: [type, { ...type }] }, /share the link name/);
  bad({ types: [{ ...type, durationMin: 2 }] }, /length between 5 minutes/);
  bad({ types: [{ ...type, maxDaysAhead: 400 }] }, /between 1 and 90 days/);
  bad({ types: [{ ...type, colour: 'red' }] }, /Unknown meeting type setting/);
  assert.equal(service.store.saved, undefined, 'a refused change saves nothing');

  await service.discover();
  const work = service.calendars.find(c => c.sub === 'work');
  updateBooking(service, { owner: { name: '  Urs   Wilcke ', headline: 'Antaia' }, calendarId: work.id, enabled: true,
    types: [{ ...type, title: ' Intro ', notesToWiki: false }] });
  assert.deepEqual(service.store.saved.booking.owner, { name: 'Urs Wilcke', headline: 'Antaia' });
  assert.deepEqual([service.store.saved.booking.accountSub, service.store.saved.booking.types[0].title], ['work', 'Intro']);
  const shown = publicBooking(service);
  assert.deepEqual(shown.addresses.map(a => [a.sub, a.email, a.access, a.calendarId === work.id || a.calendars.length]), [['work', 'urs@antaia.space', true, true], ['home', 'urs@example.test', false, 1]]);
  assert.deepEqual(shown.types.map(t => t.accountSub), ['work']);
});

test('booking asks Google for event access on the booking account only', async () => {
  const { service, google } = await ready();
  // The calendars were listed before booking links were switched on; only the booking account then asks for more.
  await bookingSnapshot(service, now);
  assert.deepEqual(google.refreshModes, ['work:availability', 'home:availability', 'work:booking']);
  // Without booking links the same account keeps its narrow permission.
  const off = planner();
  await off.service.discover();
  assert.deepEqual(off.google.refreshModes, ['work:availability', 'home:availability']);
  assert.equal(canWriteBookings({ mode: 'availability' }), false);
  assert.equal(canWriteBookings({ mode: 'sync' }), true);
});

test('Allow booked meetings adds event access to one account and keeps its other choices', async () => {
  const { service, google } = planner({ accounts: [{ sub: 'work', email: 'urs@antaia.space', secret: 'work', mode: 'availability', meetingDetails: true }] });
  const asked = [];
  let grant = 0;
  service.origin = 'http://127.0.0.1:43127';
  google.authorizationUrl = ({ mode, loginHint, state }) => { asked.push([mode, loginHint]); return 'https://accounts.google.com/o?state=' + state; };
  google.exchangeCode = ({ mode }) => ({ access_token: 'work', refresh_token: 'grant-' + mode + '-' + ++grant, expires_in: 3600 });
  google.getProfile = () => ({ sub: 'work', email: 'urs@antaia.space' });
  const signIn = async options => {
    const { url } = await service.beginConnection(options);
    await service.finishConnection({ state: new URL(url).searchParams.get('state'), code: 'code' });
    const { mode, meetingDetails, booking, secret } = service.data.accounts[0];
    return { mode, meetingDetails, booking, secret };
  };
  await assert.rejects(service.beginConnection({ mode: 'booking' }), /Choose the connected account that receives booked meetings/);
  assert.deepEqual(await signIn({ mode: 'booking', accountSub: 'work' }), { mode: 'availability', meetingDetails: true, booking: true, secret: 'grant-booking-1' });
  assert.deepEqual(asked, [['booking', 'urs@antaia.space']]);
  assert.equal(service.snapshot().connection.accounts[0].bookingAccess, true);
  // Tasks stay local: the planner's own calendar mode did not change.
  assert.equal(service.data.settings.calendarMode, 'availability');
  // A later, narrower sign-in replaces the grant, so booking access ends with it.
  assert.deepEqual(await signIn({ mode: 'details', accountSub: 'work' }), { mode: 'availability', meetingDetails: true, booking: false, secret: 'grant-details-2' });
});

test('local tasks: a flexible task leaves its time bookable, a task pinned to a time does not', async () => {
  const tasks = [
    { id: 'f'.repeat(32), text: 'Draft the proposal', minutes: 60, start: iso(at('09:00')), end: iso(at('10:00')), createdAt: iso(now), dirty: {}, done: false },
    { id: 'e'.repeat(32), text: 'Call the supplier at 14:00', minutes: 30, start: iso(at('14:00')), end: iso(at('14:30')), createdAt: iso(now), dirty: {}, done: false },
  ];
  const { service, google } = await ready({ tasks });
  google.meetings.push({ account: 'work', start: iso(at('11:00')), end: iso(at('12:00')) }, { account: 'home', start: iso(at('15:30')), end: iso(at('16:00')) });
  const { page, bookings } = await bookingSnapshot(service, now);
  assert.equal(page.paused, null);
  assert.deepEqual(bookings, []);
  // 12 h notice hides Monday. Gaps of 15 minutes surround the meeting, the private block and the pinned task.
  assert.deepEqual(tuesday(page.slots.meeting), ['09:00', '09:30', '10:00', '12:30', '13:00', '16:30']);
  assert.deepEqual(page.types.find(t => t.slug === 'meeting'), { slug: 'meeting', title: 'Meeting', description: 'A regular working call.',
    durationMin: 30, bufferMin: 15, minNoticeMin: 720, maxDaysAhead: 45, hidden: false });
  assert.ok(!JSON.stringify(page).includes('proposal') && !JSON.stringify(page).includes('supplier') && !JSON.stringify(page).includes('notesToWiki'));

  // A booking over the flexible task is created; over the pinned task or a meeting it is refused.
  assert.equal((await settleBooking(service, request(at('09:30')), { pageUrl, now })).ok, true);
  assert.deepEqual(await settleBooking(service, request(at('14:00'), { id: 'b'.repeat(24), token: 'b'.repeat(24) + '.' + 'S'.repeat(27) }), { pageUrl, now }),
    { id: 'b'.repeat(24), kind: 'book', ok: false, reason: 'taken' });
  assert.equal(google.bookings.get('bkb' + 'a'.repeat(24)).title, 'Meeting: Ada Guest and Urs Wilcke');
  assert.equal(google.bookings.get('bkb' + 'a'.repeat(24)).description, pageUrl + '/booking/' + 'a'.repeat(24) + '.' + 'S'.repeat(27));
});

test("synced tasks: Dayline's own flexible task events do not block a booking", async () => {
  const remote = id => ({ sub: 'work', calendarId: 'work-primary', eventId: id, etag: '"1"' });
  const tasks = [
    { id: 'f'.repeat(32), text: 'Draft the proposal', minutes: 60, start: iso(at('09:00')), end: iso(at('10:00')), createdAt: iso(now), dirty: {}, done: false, remote: remote('f'.repeat(32)) },
    { id: 'e'.repeat(32), text: 'Call the supplier at 14:00', minutes: 30, start: iso(at('14:00')), end: iso(at('14:30')), createdAt: iso(now), dirty: {}, done: false, remote: remote('e'.repeat(32)) },
  ];
  const { service, google } = await ready({ calendarMode: 'sync', tasks });
  for (const task of tasks) google.taskEvents.set(task.id, { start: task.start, end: task.end });
  google.meetings.push({ account: 'work', start: iso(at('11:00')), end: iso(at('12:00')) });
  const { page } = await bookingSnapshot(service, now);
  // The flexible block at 09:00 is offered although Google reports it busy; the pinned 14:00 task is not.
  assert.deepEqual(tuesday(page.slots.meeting), ['09:00', '09:30', '10:00', '12:30', '13:00', '15:00', '15:30', '16:00', '16:30']);
  // Before the write the task event is told apart from a real meeting by its id.
  assert.equal((await settleBooking(service, request(at('09:00')), { pageUrl, now })).ok, true);
  assert.equal((await settleBooking(service, request(at('11:00'), { id: 'b'.repeat(24), token: 'b'.repeat(24) + '.' + 'S'.repeat(27) }), { pageUrl, now })).reason, 'taken');
});

test('a meeting type can keep its own weekly hours instead of the working hours', async () => {
  const { service } = await ready();
  const [intro, meeting] = defaultBooking().types;
  const bad = hours => assert.throws(() => updateBooking(service, { types: [{ ...meeting, hours }] }), /needs weekly hours/, JSON.stringify(hours));
  bad({});
  bad({ funday: [{ start: '09:00', end: '10:00' }] });
  bad({ tue: [{ start: '15:00', end: '13:00' }] });
  bad({ tue: [{ start: '9', end: '10:00' }] });
  bad({ tue: 'all day' });
  bad([]);
  // Tuesday afternoon and Saturday only, although Saturday is not a working day; the other type keeps working hours.
  updateBooking(service, { types: [intro, { ...meeting, hours: { tue: [{ start: '13:00', end: '15:00' }], sat: [{ start: '10:00', end: '11:00' }], mon: [] } }] });
  assert.deepEqual(service.data.booking.types.map(t => t.hours), [null, { tue: [{ start: '13:00', end: '15:00' }], sat: [{ start: '10:00', end: '11:00' }] }]);
  const { page } = await bookingSnapshot(service, now);
  const days = slots => [...new Set(slots.filter(ms => ms < at('00:00', 30)).map(ms => iso(ms).slice(0, 10)))];
  assert.deepEqual(tuesday(page.slots.meeting), ['13:00', '13:30', '14:00', '14:30']);
  assert.deepEqual(days(page.slots.meeting), ['2026-11-24', '2026-11-28']);
  assert.deepEqual(days(page.slots.intro), ['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']);
  // The page object never receives the hours themselves, only the start times they allow.
  assert.ok(!JSON.stringify(page.types).includes('hours'));
  // A request outside the type's own hours is refused even inside working hours.
  assert.equal((await settleBooking(service, request(at('10:00')), { pageUrl, now })).reason, 'taken');
  assert.equal((await settleBooking(service, request(at('13:30')), { pageUrl, now })).ok, true);
});

test('each address has its own meeting types, and a booking lands in the calendar of the address it was booked with', async () => {
  const both = [{ sub: 'work', email: 'urs@antaia.space', secret: 'work', mode: 'availability', booking: true },
    { sub: 'home', email: 'urs@example.test', secret: 'home', mode: 'availability', booking: true }];
  const { service, google } = await ready({ accounts: both });
  const [intro, meeting] = defaultBooking().types;
  assert.throws(() => updateBooking(service, { types: [{ ...intro, accountSub: 'nobody' }] }), /Choose a connected Google address/);
  const workCalendar = service.calendars.find(c => c.sub === 'work').id, homeCalendar = service.calendars.find(c => c.sub === 'home').id;
  assert.throws(() => updateBooking(service, { calendars: { home: workCalendar } }), /Choose a calendar of that Google address/);
  // A type saved without an address belongs to the first one; the other is booked with the private address.
  updateBooking(service, { types: [intro, { ...meeting, accountSub: 'home' }], calendars: { home: homeCalendar } });
  const shown = publicBooking(service);
  assert.deepEqual(shown.types.map(t => [t.slug, t.accountSub]), [['intro', 'work'], ['meeting', 'home']]);
  assert.deepEqual(shown.addresses.map(a => [a.email, a.access, a.calendarId]), [['urs@antaia.space', true, workCalendar], ['urs@example.test', true, homeCalendar]]);

  // Both addresses now need event access, and each type gets times from the same shared busy time.
  google.meetings.push({ account: 'work', start: iso(at('11:00')), end: iso(at('12:00')) });
  const before = await bookingSnapshot(service, now);
  assert.deepEqual(google.refreshModes.slice(-2).sort(), ['home:booking', 'work:booking']);
  assert.ok(tuesday(before.page.slots.meeting).includes('10:00') && !tuesday(before.page.slots.meeting).includes('11:00'), 'a work meeting blocks the private address too');

  const viaHome = await settleBooking(service, request(at('10:00')), { pageUrl, now });
  const viaWork = await settleBooking(service, request(at('13:00'), { id: 'b'.repeat(24), token: 'b'.repeat(24) + '.' + 'S'.repeat(27), type: 'intro', end: at('13:15') }), { pageUrl, now });
  assert.deepEqual([viaHome.ok, viaWork.ok], [true, true]);
  const booked = id => { const { account, calendarId, ownerEmail } = google.bookings.get('bkb' + id.repeat(24)); return [account, calendarId, ownerEmail]; };
  assert.deepEqual(booked('a'), ['home', 'home-primary', 'urs@example.test']);
  assert.deepEqual(booked('b'), ['work', 'work-primary', 'urs@antaia.space']);

  // The Bookings tab lists both, each with the address it was booked with; the page object gets no address at all.
  const after = await bookingSnapshot(service, now);
  assert.deepEqual(after.upcoming.map(m => [m.type, m.address]), [['Meeting', 'urs@example.test'], ['Intro call', 'urs@antaia.space']]);
  assert.deepEqual(after.bookings.map(b => b.id).sort(), ['a'.repeat(24), 'b'.repeat(24)]);
  assert.ok(!JSON.stringify(after.page).includes('example.test') && !JSON.stringify(after.page).includes('accountSub'));
  assert.ok(!tuesday(after.page.slots.intro).includes('10:00'), 'a booking with one address blocks that time for the other');

  // Reschedule and cancel find the event in whichever calendar holds it.
  const moved = await settleBooking(service, { kind: 'move', id: 'a'.repeat(24), start: at('15:00'), end: at('15:30') }, { pageUrl, now });
  assert.deepEqual([moved.ok, google.bookings.get('bkb' + 'a'.repeat(24)).start], [true, iso(at('15:00'))]);
  assert.equal((await settleBooking(service, { kind: 'cancel', id: 'a'.repeat(24) }, { pageUrl, now })).ok, true);
  assert.deepEqual([...google.bookings.keys()], ['bkb' + 'b'.repeat(24)]);

  // An address that may not write events offers no times, and a request for it waits instead of landing elsewhere.
  service.data.accounts.find(a => a.sub === 'home').booking = false;
  const partly = await bookingSnapshot(service, now);
  assert.deepEqual([partly.page.paused, partly.page.slots.meeting, partly.page.slots.intro.length > 0], [null, [], true]);
  await assert.rejects(settleBooking(service, request(at('16:00'), { id: 'c'.repeat(24), token: 'c'.repeat(24) + '.' + 'S'.repeat(27) }), { pageUrl, now }), /event access/);
  assert.equal(google.bookings.size, 1);
});

test('a meeting type that is switched off is not published and cannot be booked', async () => {
  const { service, google } = await ready();
  const types = defaultBooking().types;
  updateBooking(service, { types: types.map(type => ({ ...type, active: type.slug !== 'meeting' })) });
  assert.deepEqual(service.data.booking.types.map(type => type.active), [true, false, true, true]);
  const { page } = await bookingSnapshot(service, now);
  assert.deepEqual(page.types.map(type => type.slug), ['intro', 'deep-dive', 'private']);
  assert.deepEqual(Object.keys(page.slots), ['intro', 'deep-dive', 'private']);
  // A request that was already waiting for it is refused, not created.
  assert.equal((await settleBooking(service, request(at('10:00')), { pageUrl, now })).reason, 'unavailable');
  assert.equal(google.bookings.size, 0);
  // With every type off the page says so instead of offering an empty list as if it were a busy week.
  updateBooking(service, { types: types.map(type => ({ ...type, active: false })) });
  const none = await bookingSnapshot(service, now);
  assert.deepEqual([none.page.paused, none.page.types], ['off', []]);
});

test('requests are checked again on the Mac, whatever the receiver says', async () => {
  const { service, google } = await ready();
  const refused = async (extra, reason) => assert.equal((await settleBooking(service, request(at('10:00'), extra), { pageUrl, now })).reason, reason, JSON.stringify(extra));
  await refused({ type: 'missing' }, 'unavailable');
  await refused({ end: at('11:30') }, 'unavailable');
  await refused({ guest: { name: 'Ada Guest', email: 'nobody', timeZone: 'UTC' } }, 'unavailable');
  await refused({ token: 'c'.repeat(24) + '.' + 'S'.repeat(27) }, 'unavailable');
  await refused({ expired: true }, 'expired');
  await refused({ start: at('18:00'), end: at('18:30') }, 'taken');
  await refused({ start: at('09:07'), end: at('09:37') }, 'taken');
  assert.equal((await settleBooking(service, request(now + 20 * MINUTE), { pageUrl, now })).reason, 'expired');
  assert.equal(google.bookings.size, 0);
  await assert.rejects(settleBooking(service, { kind: 'book', id: '../etc' }, { pageUrl, now }), /Invalid booking request/);
  // One notice per request, however often the receiver repeats it.
  assert.equal(service.data.booking.notices.length, 1);

  // A repeated request finds the event it already made instead of making another.
  const first = await settleBooking(service, request(at('10:00')), { pageUrl, now });
  assert.deepEqual(await settleBooking(service, request(at('10:00')), { pageUrl, now }), first);
  assert.equal(google.bookings.size, 1);
  // The type's wiki choice decides the id prefix the notes job reads.
  const quiet = request(at('13:00'), { id: 'p'.repeat(24), token: 'p'.repeat(24) + '.' + 'S'.repeat(27), type: 'private' });
  await settleBooking(service, quiet, { pageUrl, now });
  assert.ok(google.bookings.has('bkp' + 'p'.repeat(24)));
});

test('no times are published when a calendar cannot be read', async () => {
  const { service, google } = await ready();
  service.tokens.clear();
  google.failRefresh = failure(400, 'invalid_grant');
  const expired = await bookingSnapshot(service, now);
  assert.deepEqual([expired.page.paused, expired.page.slots, expired.bookings], ['reconnect', {}, undefined]);
  // A passing outage keeps the last published times instead of blanking the page.
  google.failRefresh = failure(503, 'backendError');
  await assert.rejects(bookingSnapshot(service, now), /backendError/);
  // No calendar with event access: nothing to offer yet.
  const setup = planner({ accounts: [{ sub: 'work', email: 'urs@antaia.space', secret: 'work', mode: 'availability' }] });
  bookingState(setup.service).owner.name = 'Urs';
  assert.equal((await bookingSnapshot(setup.service, now)).page.paused, 'setup');
});
