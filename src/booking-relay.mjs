// The Mac's side of the public booking page. It publishes free start times
// to Antaia's receiver and answers the requests guests left there. Google
// tokens, event details and tasks are never part of this protocol.
import { bookingSnapshot, bookingState, settleBooking } from './booking-service.mjs';
import { explicitStartFor } from './planner.mjs';

const device = /^[A-Za-z0-9_-]{43}$/;
const ticket = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const handle = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const DAY = 86_400_000;
const pauses = {
  setup: 'Choose a calendar with event access under Bookings go to.',
  off: 'Every meeting type is switched off.',
  reconnect: 'Reconnect the Google account that receives booked meetings.',
  unavailable: 'Google could not confirm your availability. No times are offered until it can.',
};

function relayOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Choose an HTTPS origin for the booking page receiver.');
  }
  return url.origin;
}

export class BookingDesk {
  constructor({ service, origin, fetch: request = globalThis.fetch, now = Date.now, rebuildMs = 5 * 60000, onBooked = () => {} }) {
    Object.assign(this, { service, origin: relayOrigin(origin), request, now, rebuildMs, onBooked });
    this.session = null;
    this.problem = null;
    this.paused = null;
    this.waiting = 0;
    this.publishedAt = null;
    this.dirty = true;
    this.upcoming = [];
    this.slots = {};
  }

  status() {
    const state = bookingState(this.service);
    const url = this.session ? this.origin + '/' + this.session.handle : null;
    if (!state.enabled) return { state: 'off', url, message: null, waiting: 0, publishedAt: null };
    if (!this.origin) return { state: 'unavailable', url, message: 'This copy of Dayline has no booking page receiver.', waiting: 0, publishedAt: null };
    const phase = this.problem?.state ?? (this.paused ? 'paused' : this.publishedAt ? 'live' : 'starting');
    return { state: phase, url, message: this.problem?.message ?? (this.paused ? pauses[this.paused] ?? pauses.unavailable : null),
      waiting: this.waiting, publishedAt: this.publishedAt };
  }

  /** Settings changed: publish again now. */
  changed() {
    this.dirty = true;
    return this.wake();
  }

  /** Called after each calendar sync and when the receiver signals a new request. */
  wake() {
    if (this.stopped || !this.origin) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.problem = null;
    this.running = this.cycle().catch(error => {
      this.problem = { state: error.bookingState || 'offline', message: error.message || 'The booking page could not be reached.' };
    }).finally(() => {
      this.running = null;
      if (this.again && !this.stopped) { this.again = false; return this.wake(); }
    });
    return this.running;
  }

  stop() {
    this.stopped = true;
    return this.running ?? Promise.resolve();
  }

  fail(state, message, extra = {}) {
    return Object.assign(new Error(message), { bookingState: state, ...extra });
  }

  async open() {
    if (this.session && this.session.renewAt > this.now()) return this.session;
    const deviceId = this.service.data.calendarPush?.deviceId;
    // The page shares the device's live calendar connection, which wakes this Mac for a new request.
    if (!device.test(deviceId || '')) throw this.fail('starting', 'Waiting for the live calendar connection.');
    let proof;
    try { proof = await this.service.relayIdentity(); }
    catch (error) { throw this.fail('setup', error.message); }
    const response = await this.request(this.origin + '/v1/session', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + proof }, body: JSON.stringify({ deviceId }) });
    if (!response.ok) throw this.fail('offline', 'The booking page receiver did not accept this Mac (HTTP ' + response.status + ').');
    const data = await response.json();
    if (typeof data.bookingToken !== 'string' || !ticket.test(data.bookingToken) || !handle.test(data.bookingHandle || '') ||
        !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= this.now()) {
      throw this.fail('unsupported', 'Booking pages are not available on the receiver yet. An Antaia administrator has to deploy it.');
    }
    this.session = { token: data.bookingToken, handle: data.bookingHandle, renewAt: data.expiresAt - DAY };
    return this.session;
  }

  async send(body, retry = true) {
    const session = await this.open();
    const response = await this.request(this.origin + '/v1/booking/sync', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token }, body: JSON.stringify(body) });
    if (response.status === 401 && retry) { this.session = null; return this.send(body, false); }
    if (response.status === 404) throw this.fail('unsupported', 'Booking pages are not available on the receiver yet. An Antaia administrator has to deploy it.');
    if (!response.ok) throw this.fail('offline', 'The booking page receiver answered HTTP ' + response.status + '.');
    const reply = await response.json();
    if (!Array.isArray(reply?.requests)) throw this.fail('offline', 'The booking page receiver sent an unreadable answer.');
    return reply;
  }

  // What the published times depend on. A change here publishes at once;
  // otherwise the page is rebuilt on a timer to cover the far end of the horizon.
  fingerprint() {
    const { service } = this, { settings } = service.data, state = bookingState(service);
    const fixed = service.data.tasks.filter(t => t.start && !t.done && !t.deleting && explicitStartFor(t, settings.timeZone)).map(t => [t.start, t.end]);
    return JSON.stringify([state.owner, state.calendarId, state.accountSub, state.calendars, state.types, settings.timeZone, settings.workDays, settings.startTime,
      settings.endTime, settings.calendarMode, settings.excludedCalendarIds, service.busy, fixed]);
  }

  async cycle() {
    const { service } = this, state = bookingState(service);
    if (!state.enabled) {
      if (state.published) {
        await this.send({ page: null });
        await service.run(() => { state.published = false; service.store.save(); });
      }
      Object.assign(this, { paused: null, waiting: 0, publishedAt: null, dirty: true, upcoming: [], slots: {} });
      return;
    }
    let outcomes = [];
    const confirmed = new Map();
    for (let round = 0; round < 6; round++) {
      const body = { outcomes };
      const print = this.fingerprint();
      if (this.dirty || print !== this.print || this.now() - (this.builtAt ?? 0) >= this.rebuildMs) {
        const snapshot = await service.run(() => bookingSnapshot(service, this.now()));
        body.page = snapshot.page;
        if (snapshot.upcoming) this.upcoming = snapshot.upcoming; // Shown on this Mac; never sent.
        this.slots = snapshot.page.slots; // For "copy times for an email" in the Bookings tab.
        if (snapshot.bookings) {
          // A meeting created a moment ago may be missing from Google's list for a few seconds.
          const listed = new Map(snapshot.bookings.map(b => [b.id, b]));
          for (const [id, { type, start, end }] of confirmed) {
            const known = listed.get(id);
            if (known) listed.set(id, { ...known, start, end });
            else if (type) listed.set(id, { id, type, start, end });
          }
          body.bookings = [...listed.values()];
        }
        Object.assign(this, { dirty: false, print, builtAt: this.now(), paused: snapshot.page.paused });
      }
      const reply = await this.send(body);
      if (body.page) {
        this.publishedAt = reply.publishedAt ? new Date(reply.publishedAt).toISOString() : null;
        if (!state.published) await service.run(() => { state.published = true; service.store.save(); });
      }
      this.waiting = reply.requests.length;
      if (!reply.requests.length) return;
      const session = await this.open();
      outcomes = [];
      for (const request of reply.requests) {
        try {
          const outcome = await service.run(() => settleBooking(service, request, { pageUrl: this.origin + '/' + session.handle, now: this.now() }));
          outcomes.push(outcome);
          if (outcome.ok && outcome.kind !== 'cancel') confirmed.set(outcome.id, { type: request.type, start: outcome.start, end: outcome.end });
          else confirmed.delete(outcome.id);
        } catch (error) {
          // Left waiting on the receiver; the next cycle asks Google again.
          this.problem = { state: 'paused', message: error.message };
        }
      }
      if (!outcomes.length) return;
      this.dirty = true;
      this.waiting = reply.requests.length - outcomes.length;
      // The new meeting is on the calendar: let the planner move tasks around it.
      Promise.resolve().then(() => this.onBooked()).catch(() => {});
    }
  }
}
