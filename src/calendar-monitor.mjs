import { createHash } from 'node:crypto';
import * as googleCalendar from './google.mjs';

const key = (...parts) => JSON.stringify(parts);
const hour = 3_600_000;
const limitError = err => err.status === 429 || /quota|rate.?limit|usageLimits|resource_exhausted/i.test(err.reason || '');
const unavailableDetails = err => err.status === 404 || (err.status === 403 && !limitError(err));
const present = value => typeof value === 'string' && value.length > 0;
const incomplete = () => Object.assign(new Error('Google returned incomplete calendar change information.'), { status: 502 });

function rangesFor(ranges, now) {
  const ordered = (ranges || []).map(({ start, end }, i) => ({ start: Date.parse(start), end: Date.parse(end), primary: i === 0 }))
    .filter(range => Number.isFinite(range.start) && range.start < range.end);
  if (!ordered.length) {
    const day = new Date(now).setUTCHours(0, 0, 0, 0);
    ordered.push({ start: day - 24 * hour, end: day + 35 * 24 * hour, primary: true });
  }
  const merged = [];
  for (const range of ordered.sort((a, b) => a.start - b.start)) {
    const prev = merged.at(-1);
    if (prev && range.start <= prev.end) {
      prev.end = Math.max(prev.end, range.end);
      prev.primary ||= range.primary;
    } else merged.push(range);
  }
  return merged.map(r => ({ start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString(), primary: r.primary }));
}

function calendarSources(raw) {
  const calendars = new Map();
  for (const calendar of raw || []) {
    if (!present(calendar.sub) || !present(calendar.id) || calendar.canCheckAvailability === false || !googleCalendar.canCheckAvailability(calendar.id)) continue;
    const id = key(calendar.sub, calendar.id);
    if (!calendars.has(id) || calendar.details) calendars.set(id, { sub: calendar.sub, id: calendar.id, details: calendar.details === true });
  }
  return [...calendars.values()].sort((a, b) => a.sub.localeCompare(b.sub) || a.id.localeCompare(b.id));
}

function fingerprint(rows, ids) {
  if (!Array.isArray(rows) || rows.length !== ids.length) throw incomplete();
  const byId = new Map(rows.map(row => [row.calendarId, row.busy]));
  const normalized = ids.map(id => {
    const periods = byId.get(id);
    if (!Array.isArray(periods)) throw incomplete();
    const ordered = periods.map(period => {
      const start = Date.parse(period?.start), end = Date.parse(period?.end);
      if (!Number.isFinite(start) || !(start < end)) throw incomplete();
      return [start, end];
    }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return [id, ordered];
  });
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export class CalendarMonitor {
  constructor({ sources, token, google = googleCalendar, now = Date.now, random = Math.random,
    intervalMs = 3000, maxIntervalMs = 5000, requestGapMs = 1000, accountGapMs = 1250, maxBackoffMs = 300000 }) {
    Object.assign(this, { sources, token, google, random, intervalMs, maxIntervalMs, requestGapMs, accountGapMs, maxBackoffMs });
    this.now = () => Number(now());
    this.jobs = new Map();
    this.accountAfter = new Map();
    this.fallback = new Map();
    this.isolated = new Set();
    this.generation = 0;
    this.nextRequest = 0;
    this.turn = 0;
    this.revision = undefined;
    this.signature = null;
    this.baselineDue = false;
  }

  reset() {
    this.generation++;
    this.signature = null;
    this.jobs.clear();
    this.fallback.clear();
    this.isolated.clear();
    this.baselineDue = false;
  }

  stop() { this.stopped = true; this.reset(); }

  configure() {
    if (this.stopped) return;
    const now = this.now(), config = this.sources() || {};
    if (config.revision !== this.revision) { this.reset(); this.revision = config.revision; }
    const calendars = calendarSources(config.calendars);
    const ranges = rangesFor(config.ranges, now);
    for (const [id, expiry] of this.fallback) if (expiry <= now) this.fallback.delete(id);
    const signature = key(calendars, ranges, [...this.fallback.keys()], [...this.isolated]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.generation++;
    const jobs = new Map(), groups = new Map();
    const add = spec => {
      const prior = this.jobs.get(spec.key);
      // Later week navigation remains covered by an unbounded incremental
      // feed. An older requested week needs a bootstrap with an earlier floor.
      if (prior && (spec.kind !== 'events' || prior.timeMin <= spec.timeMin)) {
        prior.primary = spec.primary;
        jobs.set(spec.key, prior);
      } else {
        jobs.set(spec.key, { ...spec, due: now, failures: 0, quiet: 0, ready: false });
        this.baselineDue = true;
      }
    };
    for (const { sub, id, details } of calendars) {
      const source = key(sub, id);
      if (details && typeof this.google.readCalendarChangePage === 'function' && !this.fallback.has(source)) {
        add({ key: key('events', sub, id), kind: 'events', sub, id, timeMin: ranges[0].start, primary: true });
      } else {
        const separate = this.isolated.has(source) || typeof this.google.getBusyByCalendar !== 'function';
        const group = key(sub, separate ? id : null);
        if (!groups.has(group)) groups.set(group, { sub, ids: [] });
        groups.get(group).ids.push(id);
      }
    }
    for (const { sub, ids } of groups.values()) {
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        for (const { start, end, primary } of ranges) {
          add({ key: key('busy', sub, batch, start, end), kind: 'busy', sub, ids: batch, start, end, primary });
        }
      }
    }
    this.jobs = jobs;
    const activeAccounts = new Set(calendars.map(c => c.sub));
    for (const sub of this.accountAfter.keys()) if (!activeAccounts.has(sub)) this.accountAfter.delete(sub);
    if (!jobs.size) this.baselineDue = false;
  }

  result(changed = false, baseline = false, checked = 0, failed = false) {
    const now = this.now();
    let next = Infinity;
    for (const job of this.jobs.values()) {
      next = Math.min(next, Math.max(job.due, this.nextRequest, this.accountAfter.get(job.sub) || 0));
    }
    return { changed, baseline, checked, failed, nextDelayMs: Number.isFinite(next) ? Math.max(0, next - now) : this.maxIntervalMs };
  }

  poll() {
    if (!this.pending) this.pending = this.check().finally(() => { this.pending = null; });
    return this.pending;
  }

  async check() {
    this.configure();
    const now = this.now();
    if (this.stopped || this.nextRequest > now) return this.result();
    const eligible = [...this.jobs.values()].filter(j => j.due <= now && (this.accountAfter.get(j.sub) || 0) <= now)
      .sort((a, b) => a.due - b.due || (a.turn || 0) - (b.turn || 0));
    // Two out of three slots prefer today's planning horizon. Distant, recently
    // displayed weeks still get a fair turn when many sources are overdue.
    const job = eligible.find(j => j.primary === (this.turn % 3 !== 2)) || eligible[0];
    if (!job) return this.result();
    job.turn = ++this.turn;
    const generation = this.generation;
    const current = () => { this.configure(); return !this.stopped && this.generation === generation && this.jobs.get(job.key) === job; };
    this.nextRequest = now + this.requestGapMs;
    this.accountAfter.set(job.sub, now + this.accountGapMs);
    try {
      const access = await this.token(job.sub);
      if (!current()) return this.result();
      const sent = this.now();
      this.nextRequest = Math.max(this.nextRequest, sent + this.requestGapMs);
      this.accountAfter.set(job.sub, Math.max(this.accountAfter.get(job.sub) || 0, sent + this.accountGapMs));
      let response;
      if (job.kind === 'busy') {
        const params = { calendarIds: job.ids, start: job.start, end: job.end };
        response = typeof this.google.getBusyByCalendar === 'function' ? await this.google.getBusyByCalendar(access, params)
          : [{ calendarId: job.ids[0], busy: await this.google.getBusy(access, params) }];
      } else {
        const conditional = job.conditional && job.conditional.expires > this.now() ? job.conditional : null;
        const cursor = job.round?.cursor || conditional?.cursor || job.cursor;
        const params = { calendarId: job.id };
        if (cursor) params.syncToken = cursor;
        else params.timeMin = job.timeMin;
        if (job.round?.page) params.pageToken = job.round.page;
        else if (conditional) params.etag = conditional.etag;
        response = { page: await this.google.readCalendarChangePage(access, params), cursor, etag: params.etag };
      }
      if (!current()) return this.result(false, false, 1);
      const previouslyReady = job.ready, recovering = job.failures > 0;
      let changed = false, more = false;
      if (job.kind === 'busy') {
        const digest = fingerprint(response, job.ids);
        changed = job.ready && digest !== job.digest;
        job.digest = digest;
        job.ready = true;
      } else ({ changed, more } = this.consumePage(job, response));
      job.failures = 0;
      job.quiet = changed || recovering ? 0 : Math.min(job.quiet + 1, 8);
      job.due = this.now() + (more ? 0 : Math.min(this.maxIntervalMs, this.intervalMs * (1 + job.quiet / 4)));
      const recovered = job.ready && recovering;
      if (job.ready && !previouslyReady && !this.baselineDue) changed = true;
      return this.finish(changed || recovered, false);
    } catch (error) {
      if (!current()) return this.result(false, false, 1);
      job.failures++;
      const finished = this.now();
      const retry = Math.max(0, Number(error.retryAfterSeconds) || 0) * 1000;
      const exponential = this.intervalMs * (2 ** Math.min(12, job.failures));
      const backoff = Math.max(retry, Math.min(this.maxBackoffMs, exponential * (1 + this.random() / 4)));
      job.due = finished + Math.ceil(backoff);
      if (job.kind === 'events' && error.status === 410 && (job.cursor || job.round)) {
        delete job.cursor;
        delete job.round;
        delete job.conditional;
        job.ready = false;
        job.due = finished + this.requestGapMs;
        this.baselineDue = true;
      } else if (job.kind === 'events' && unavailableDetails(error)) {
        this.fallback.set(key(job.sub, job.id), finished + Math.max(60000, this.maxBackoffMs));
        this.configure();
      } else if (job.kind === 'busy' && job.ids.length > 1 && job.ids.includes(error.calendarId) && !limitError(error)) {
        this.isolated.add(key(job.sub, error.calendarId));
        this.configure();
      } else if (limitError(error) || error.status === 401 || error.reason === 'invalid_grant') {
        this.accountAfter.set(job.sub, job.due);
        if (limitError(error) && error.reason !== 'userRateLimitExceeded') this.nextRequest = Math.max(this.nextRequest, job.due);
      } else if (error.reason === 'networkError') this.nextRequest = Math.max(this.nextRequest, job.due);
      else if (error.status >= 500 && !error.calendarId) this.accountAfter.set(job.sub, job.due);
      return this.finish(false, true);
    }
  }

  finish(changed, failed) {
    const jobs = [...this.jobs.values()];
    const baseline = this.baselineDue && jobs.some(job => job.ready) && jobs.every(job => job.ready || job.failures);
    if (baseline) this.baselineDue = false;
    return this.result(changed || baseline, Boolean(baseline), 1, failed);
  }

  consumePage(job, { page, cursor, etag }) {
    if (page?.notModified) {
      if (!etag || !job.ready || job.round) throw incomplete();
      return { changed: false, more: false };
    }
    if (!page || typeof page.hasChanges !== 'boolean' || (!present(page.nextPageToken) && !present(page.nextSyncToken))) throw incomplete();
    const dirty = Boolean(job.round?.dirty || (cursor && page.hasChanges));
    if (page.nextPageToken) {
      const seen = job.round?.seen || new Set();
      if (seen.has(page.nextPageToken)) throw incomplete();
      seen.add(page.nextPageToken);
      job.round = { cursor, page: page.nextPageToken, dirty, seen };
      delete job.conditional;
      return { changed: false, more: true };
    }
    const single = !job.round;
    job.cursor = page.nextSyncToken;
    job.ready = true;
    delete job.round;
    // Keep Google's newest sync cursor. An additional validator for a known
    // empty delta is valid only against that exact query, never a new cursor.
    if (cursor && single && !dirty && present(page.etag)) {
      const expires = job.conditional?.cursor === cursor ? job.conditional.expires : this.now() + hour;
      job.conditional = { cursor, etag: page.etag, expires };
    } else delete job.conditional;
    return { changed: dirty, more: false };
  }
}
