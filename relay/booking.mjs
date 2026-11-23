// One person's public booking page: the free times their Mac published, the
// requests guests sent, and nothing else. This is a plain class so the tests
// can run it under Node; worker.mjs wraps it in a Durable Object, which runs
// one request at a time. That ordering is what stops two guests taking a time.

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const STALE_AFTER = 72 * HOUR;          // An older snapshot is no longer offered.
export const EXPIRE_BEFORE_START = 30 * MINUTE; // A waiting request lapses this long before its start,
export const WAIT_LIMIT = 72 * HOUR;           // or after this long without an answer from the Mac.
export const KEEP_UNCOLLECTED = 7 * DAY;       // Guest details the Mac never collected are deleted then.
export const KEEP_CLOSED = 7 * DAY;            // Declined, cancelled and lapsed records explain themselves this long.
export const KEEP_PAGE = 30 * DAY;             // A page whose Mac never returned is deleted.
export const MAX_WAITING = 10;
export const MAX_SLOTS = 3000;                 // Start times stored per meeting type.
const RECENT = 2 * MINUTE;
const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';
const ID = /^[0-9a-v]{24}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DECLINES = new Set(['taken', 'expired', 'unavailable']);
const encoder = new TextEncoder();

export class BookingRefusal extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const refuse = (status, message) => { throw new BookingRefusal(status, message); };

/** The random part of a booked event's id. The Mac puts "bkb" or "bkp" in front. */
export function newRequestId() {
  let id = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(24))) id += BASE32HEX[byte % 32];
  return id;
}

async function signature(id, handle, secret) {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode('dayline-booking-v1\n' + handle + '\n' + id)));
  return btoa(String.fromCharCode(...mac)).replaceAll('+', '-').replaceAll('/', '_').slice(0, 27);
}

/** The token in a manage link: the request id plus a signature only the receiver can make. */
export async function signToken(id, handle, secret) {
  return id + '.' + await signature(id, handle, secret);
}

/** Returns the request id when the token is genuine for this page, otherwise null. */
export async function verifyToken(token, handle, secret) {
  if (typeof token !== 'string' || token.length !== 52 || token[24] !== '.') return null;
  const id = token.slice(0, 24), given = token.slice(25);
  if (!ID.test(id)) return null;
  const expected = await signature(id, handle, secret);
  let difference = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) difference |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0 ? id : null;
}

function clean(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function validTimeZone(timeZone) {
  if (!timeZone) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}

const whole = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function checkedPage(input, now, streamId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse(400, 'Invalid page.');
  const owner = { name: clean(input.owner?.name, 100), headline: clean(input.owner?.headline, 100) };
  if (!owner.name || !Array.isArray(input.types) || input.types.length > 20) refuse(400, 'Invalid page.');
  const types = [], slots = {};
  for (const t of input.types) {
    if (!t || !SLUG.test(t.slug || '') || types.some(other => other.slug === t.slug) || !clean(t.title, 80) ||
        !whole(t.durationMin, 5, 480) || !whole(t.bufferMin, 0, 240) || !whole(t.minNoticeMin, 0, 43200) || !whole(t.maxDaysAhead, 1, 90)) {
      refuse(400, 'Invalid meeting type.');
    }
    types.push({ slug: t.slug, title: clean(t.title, 80), description: clean(t.description, 300), durationMin: t.durationMin,
      bufferMin: t.bufferMin, minNoticeMin: t.minNoticeMin, maxDaysAhead: t.maxDaysAhead, hidden: t.hidden === true });
    const list = input.slots?.[t.slug] ?? [];
    if (!Array.isArray(list) || list.length > MAX_SLOTS || list.some((ms, i) => !Number.isSafeInteger(ms) || (i && ms <= list[i - 1]))) {
      refuse(400, 'Invalid times.');
    }
    slots[t.slug] = list;
  }
  const paused = input.paused == null ? null : clean(input.paused, 40) || 'paused';
  return { owner, types, slots, paused, publishedAt: now, streamId };
}

export class BookingBoard {
  constructor({ storage, secret, now = Date.now, signal = async () => {} }) {
    Object.assign(this, { storage, secret, now, signal });
    this.hits = new Map();
  }

  async load() {
    if (this.loaded) return;
    this.page = await this.storage.get('page') ?? null;
    this.ledger = await this.storage.get('ledger') ?? {};
    this.loaded = true;
  }

  savePage() { return this.page ? this.storage.put('page', this.page) : this.storage.delete('page'); }
  saveLedger() { return Object.keys(this.ledger).length ? this.storage.put('ledger', this.ledger) : this.storage.delete('ledger'); }

  type(slug) { return this.page?.types.find(t => t.slug === slug) ?? null; }
  lapsed(record, now) { return record.status === 'pending' && now > record.expiresAt; }
  open(now) { return Boolean(this.page && !this.page.paused && now - this.page.publishedAt <= STALE_AFTER); }

  // Every time a guest already holds, whether or not the Mac has answered yet.
  holds(now) {
    const held = [];
    for (const record of Object.values(this.ledger)) {
      if (record.status === 'confirmed' || (record.status === 'pending' && !this.lapsed(record, now))) held.push(record);
      if (record.status === 'confirmed' && record.change?.kind === 'move') held.push(record.change);
    }
    return held;
  }

  offered(type, now) {
    if (!this.open(now)) return [];
    const earliest = now + type.minNoticeMin * MINUTE, length = type.durationMin * MINUTE, gap = type.bufferMin * MINUTE;
    const held = this.holds(now);
    return (this.page.slots[type.slug] ?? []).filter(start => start >= earliest &&
      !held.some(h => h.start < start + length + gap && h.end > start - gap));
  }

  publicType({ slug, title, description, durationMin, maxDaysAhead }) {
    return { slug, title, description, durationMin, maxDaysAhead };
  }

  describe(record, now) {
    const type = this.type(record.type);
    return {
      status: this.lapsed(record, now) ? 'expired' : record.status, start: record.start, end: record.end,
      type: type ? this.publicType(type) : { slug: record.type, title: 'Meeting', description: '',
        durationMin: Math.round((record.end - record.start) / MINUTE), maxDaysAhead: 0 },
      owner: this.page?.owner ?? null, open: this.open(now),
      change: record.change ? { kind: record.change.kind, start: record.change.start ?? null, end: record.change.end ?? null } : null,
      note: record.note ?? null,
    };
  }

  limited(ip, now, limit, windowMs = 10 * MINUTE) {
    const recent = (this.hits.get(ip) ?? []).filter(at => now - at < windowMs);
    recent.push(now);
    this.hits.set(ip, recent);
    if (this.hits.size > 5000) this.hits.clear();
    return recent.length > limit;
  }

  async find(token, handle) {
    const id = await verifyToken(token, handle, this.secret);
    const record = id && this.ledger[id];
    if (!record) refuse(404, 'This booking does not exist or is cancelled already.');
    return record;
  }

  wake() {
    const stream = this.page?.streamId;
    if (stream) Promise.resolve().then(() => this.signal(stream)).catch(() => {});
  }

  // ------------------------------------------------------------ guest

  viewPage(now) {
    if (!this.page) refuse(404, 'There is no booking page at this address.');
    return { owner: this.page.owner, open: this.open(now), types: this.page.types.filter(t => !t.hidden).map(t => this.publicType(t)) };
  }

  viewSlots(slug, now) {
    const type = this.type(slug);
    if (!type) refuse(404, 'There is no meeting type at this address.');
    return { owner: this.page.owner, open: this.open(now), type: this.publicType(type), slots: this.offered(type, now) };
  }

  async book(input, handle, ip, now) {
    // "website" is a hidden field that people leave empty and form bots fill in.
    if (!input || typeof input !== 'object' || input.website) refuse(400, 'Bad request.');
    const type = this.type(clean(input.type, 80));
    if (!type) refuse(404, 'Unknown meeting type.');
    const name = clean(input.name, 100), email = clean(input.email, 254).toLowerCase();
    const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 2000) : '';
    const timeZone = clean(input.timeZone, 64), start = Number(input.start);
    if (name.length < 2) refuse(400, 'Enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) refuse(400, 'Enter a valid email address.');
    if (!validTimeZone(timeZone)) refuse(400, 'Unknown time zone.');
    if (!Number.isSafeInteger(start)) refuse(400, 'Pick a time.');
    if (this.limited(ip, now, 6)) refuse(429, 'Too many bookings from this address. Try again later.');

    const waiting = Object.values(this.ledger).filter(r => r.status === 'pending' && !this.lapsed(r, now));
    let record = waiting.find(r => r.type === type.slug && r.start === start && r.guest?.email === email);
    if (!record) {
      if (!this.offered(type, now).includes(start)) refuse(409, 'That time is no longer available. Pick another one.');
      if (waiting.length >= MAX_WAITING) refuse(503, 'Too many requests are waiting for an answer. Try again later.');
      record = { id: newRequestId(), type: type.slug, start, end: start + type.durationMin * MINUTE, status: 'pending',
        createdAt: now, expiresAt: Math.min(start - EXPIRE_BEFORE_START, now + WAIT_LIMIT), guest: { name, email, timeZone, notes } };
      this.ledger[record.id] = record;
      await this.saveLedger();
      this.wake();
    }
    return { token: await signToken(record.id, handle, this.secret), ...this.describe(record, now) };
  }

  async reschedule(token, input, handle, ip, now) {
    const record = await this.find(token, handle);
    const start = Number(input?.start), type = this.type(record.type);
    if (!Number.isSafeInteger(start)) refuse(400, 'Pick a time.');
    if (this.limited(ip, now, 12)) refuse(429, 'Too many changes from this address. Try again later.');
    const waiting = record.status === 'pending' && !this.lapsed(record, now);
    if (!type || (!waiting && record.status !== 'confirmed') || record.change?.kind === 'cancel' || record.end <= now) {
      refuse(409, 'This meeting can no longer be moved.');
    }
    if (start !== (record.change?.start ?? record.start)) {
      if (!this.offered(type, now).includes(start)) refuse(409, 'That time is no longer available. Pick another one.');
      const slot = { start, end: start + type.durationMin * MINUTE };
      if (waiting) Object.assign(record, slot, { expiresAt: Math.min(start - EXPIRE_BEFORE_START, record.createdAt + WAIT_LIMIT) });
      else record.change = { kind: 'move', ...slot };
      delete record.note;
      await this.saveLedger();
      this.wake();
    }
    return { token, ...this.describe(record, now) };
  }

  async cancel(token, handle, now) {
    const record = await this.find(token, handle);
    if (record.status === 'pending') {
      // The Mac may be creating the event right now; its answer settles that (see settle).
      Object.assign(record, { status: 'cancelled', closedAt: now });
      delete record.guest;
    } else if (record.status === 'confirmed') record.change = { kind: 'cancel' };
    else return { token, ...this.describe(record, now) };
    delete record.note;
    await this.saveLedger();
    this.wake();
    return { token, ...this.describe(record, now) };
  }

  // -------------------------------------------------------------- Mac

  settle(outcome, now) {
    const record = ID.test(outcome?.id || '') ? this.ledger[outcome.id] : null;
    if (!record) return;
    const slot = Number.isSafeInteger(outcome.start) && Number.isSafeInteger(outcome.end) && outcome.start < outcome.end
      ? { start: outcome.start, end: outcome.end } : null;
    if (outcome.kind === 'book') {
      if (record.status === 'cancelled' && record.handed && outcome.ok === true) {
        // The guest cancelled while the Mac was creating the event: have it removed.
        Object.assign(record, slot, { status: 'confirmed', confirmedAt: now, change: { kind: 'cancel' } });
        delete record.closedAt;
      } else if (record.status === 'pending') {
        if (outcome.ok === true) Object.assign(record, slot, { status: 'confirmed', confirmedAt: now });
        else Object.assign(record, { status: outcome.reason === 'expired' ? 'expired' : 'declined', closedAt: now,
          note: DECLINES.has(outcome.reason) ? outcome.reason : 'unavailable' });
        delete record.guest;
        delete record.expiresAt;
      }
    } else if (outcome.kind === 'move' && record.change?.kind === 'move') {
      // The answer names the time it is about; a newer request from the guest stays queued.
      if (outcome.ok === true && slot) Object.assign(record, slot);
      if (!slot || slot.start === record.change.start) {
        delete record.change;
        if (outcome.ok !== true) record.note = 'move-declined';
      }
    } else if (outcome.kind === 'cancel' && record.change?.kind === 'cancel') {
      delete record.change;
      if (outcome.ok === true) Object.assign(record, { status: 'cancelled', closedAt: now });
      else record.note = 'cancel-failed';
    }
  }

  // Google Calendar is the store of bookings. The Mac's list corrects this
  // copy when the owner moves or deletes a booked meeting in the calendar.
  reconcile(bookings, now) {
    const listed = new Map();
    for (const b of bookings) {
      if (b && ID.test(b.id || '') && SLUG.test(b.type || '') && Number.isSafeInteger(b.start) && Number.isSafeInteger(b.end) && b.start < b.end) listed.set(b.id, b);
    }
    for (const record of Object.values(this.ledger)) {
      if (record.status !== 'confirmed') continue;
      const entry = listed.get(record.id);
      if (!entry) {
        if (now - (record.confirmedAt ?? 0) <= RECENT) continue;
        Object.assign(record, { status: 'cancelled', closedAt: now, note: 'removed' });
        delete record.change;
      } else if (record.change?.kind !== 'move') Object.assign(record, { start: entry.start, end: entry.end });
    }
    for (const [id, entry] of listed) {
      if (!this.ledger[id] && entry.end > now) this.ledger[id] = { id, type: entry.type, start: entry.start, end: entry.end,
        status: 'confirmed', createdAt: now, confirmedAt: 0 };
    }
  }

  async sync(input, handle, streamId, now) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) refuse(400, 'Invalid request.');
    if (input.outcomes !== undefined && (!Array.isArray(input.outcomes) || input.outcomes.length > 100)) refuse(400, 'Invalid outcomes.');
    if (input.bookings !== undefined && (!Array.isArray(input.bookings) || input.bookings.length > 2000)) refuse(400, 'Invalid bookings.');
    if (input.page === null) {
      // Booking links were switched off: forget the page and every request.
      this.page = null;
      this.ledger = {};
      await this.savePage();
      await this.saveLedger();
      return { requests: [], waiting: 0, publishedAt: null };
    }
    const page = input.page === undefined ? undefined : checkedPage(input.page, now, streamId);
    for (const outcome of input.outcomes ?? []) this.settle(outcome, now);
    if (page) { this.page = page; await this.savePage(); }
    if (input.bookings) this.reconcile(input.bookings, now);

    const requests = [];
    for (const record of Object.values(this.ledger)) {
      if (record.status === 'pending') {
        record.handed = true;
        requests.push({ kind: 'book', id: record.id, token: await signToken(record.id, handle, this.secret), type: record.type,
          start: record.start, end: record.end, guest: record.guest, createdAt: record.createdAt, expired: this.lapsed(record, now) });
      } else if (record.status === 'confirmed' && record.change?.kind === 'move') {
        requests.push({ kind: 'move', id: record.id, token: await signToken(record.id, handle, this.secret),
          start: record.change.start, end: record.change.end });
      } else if (record.status === 'confirmed' && record.change?.kind === 'cancel') requests.push({ kind: 'cancel', id: record.id });
    }
    this.sweep(now);
    await this.saveLedger();
    return { requests, waiting: requests.length, publishedAt: this.page?.publishedAt ?? null };
  }

  // -------------------------------------------------------- retention

  sweep(now) {
    for (const record of Object.values(this.ledger)) {
      if (record.status === 'pending' && now > record.createdAt + KEEP_UNCOLLECTED) {
        Object.assign(record, { status: 'expired', closedAt: now, note: 'expired' });
        delete record.guest;
      }
      const closed = ['declined', 'cancelled', 'expired'].includes(record.status);
      if ((closed && now > (record.closedAt ?? 0) + KEEP_CLOSED) ||
          (record.status === 'confirmed' && now > record.end + (record.change ? DAY : 0))) delete this.ledger[record.id];
    }
    if (this.page && now > this.page.publishedAt + KEEP_PAGE) this.page = null;
  }

  /** When stored data next becomes due for deletion, or null when nothing is stored. */
  nextSweep() {
    const due = [];
    for (const record of Object.values(this.ledger)) {
      if (record.status === 'pending') due.push(record.createdAt + KEEP_UNCOLLECTED);
      else if (record.status === 'confirmed') due.push(record.end + (record.change ? DAY : 0));
      else due.push((record.closedAt ?? 0) + KEEP_CLOSED);
    }
    if (this.page) due.push(this.page.publishedAt + KEEP_PAGE);
    return due.length ? Math.min(...due) + 1000 : null;
  }

  async expire() {
    await this.load();
    this.sweep(this.now());
    await this.savePage();
    await this.saveLedger();
    return this.nextSweep();
  }

  /** One call from the receiver: { op, handle, ip, streamId, token, slug, input }. */
  async handle(call) {
    await this.load();
    const now = this.now();
    try {
      const { op, handle, ip = 'unknown', input } = call;
      let body;
      if (op === 'sync') body = await this.sync(input, handle, call.streamId, now);
      else if (op === 'page') body = this.viewPage(now);
      else {
        if (!this.page) refuse(404, 'There is no booking page at this address.');
        if (op === 'slots') body = this.viewSlots(call.slug, now);
        else if (op === 'book') body = await this.book(input, handle, ip, now);
        else if (op === 'status') body = { token: call.token, ...this.describe(await this.find(call.token, handle), now) };
        else if (op === 'reschedule') body = await this.reschedule(call.token, input, handle, ip, now);
        else if (op === 'cancel') body = await this.cancel(call.token, handle, now);
        else refuse(404, 'Unknown request.');
      }
      return { status: op === 'book' && body.status === 'pending' ? 202 : 200, body };
    } catch (error) {
      if (error instanceof BookingRefusal) return { status: error.status, body: { error: error.message } };
      throw error;
    }
  }
}
