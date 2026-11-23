import { randomBytes, randomUUID } from 'node:crypto';
import * as googleCalendar from './google.mjs';

const hour = 3_600_000;
const key = (sub, id) => JSON.stringify([sub, id]);
const device = /^[A-Za-z0-9_-]{43}$/;
const stream = /^[A-Za-z0-9_-]{1,180}$/;
const ticket = /^[A-Za-z0-9._~-]+$/;
const channelFields = ['sub', 'providerId', 'channelId', 'resourceId', 'expiresAt', 'renewAt', 'streamId'];
const string = value => typeof value === 'string' && value.length > 0;

function relayOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Choose an HTTPS origin for the calendar notification receiver.');
  }
  return url.origin;
}

function selected(config) {
  const entries = new Map();
  for (const c of config?.calendars || []) {
    if (string(c.sub) && string(c.id) && c.canCheckAvailability !== false && googleCalendar.canCheckAvailability(c.id)) {
      entries.set(key(c.sub, c.id), { sub: c.sub, id: c.id });
    }
  }
  return entries;
}

function usableChannel(record) {
  return record && ['sub', 'providerId', 'channelId', 'resourceId', 'streamId'].every(k => string(record[k])) &&
    Number.isSafeInteger(record.expiresAt);
}

// This class runs only in the Mac/backend process. Event bodies and Google
// calendar access/refresh tokens are never included in the receiver protocol.
export class CalendarPush {
  constructor({ origin, sources, google = googleCalendar, token, identity, load = () => ({}), save = () => {},
    onChange = () => {}, onStatus = () => {}, onBooking = () => {}, fetch: request = globalThis.fetch, WebSocket: Socket = globalThis.WebSocket,
    now = Date.now, random = Math.random, automatic = true, maintenanceMs = 60000, retryMs = 1000, maxRetryMs = 120000,
    coalesceMs = 100, handshakeMs = 15000, heartbeatMs = 30000, staleAfterMs = Math.max(90000, maintenanceMs * 2),
    renewBeforeMs = 12 * hour, ttlSeconds = 604800, batchSize = 4, batchDelayMs = 1000 }) {
    Object.assign(this, { origin: relayOrigin(origin), sources, google, token, identity, load, save, onChange, onStatus, onBooking, request, Socket,
      random, automatic, maintenanceMs, retryMs, maxRetryMs, coalesceMs, handshakeMs, heartbeatMs, staleAfterMs, renewBeforeMs, ttlSeconds,
      batchSize, batchDelayMs });
    this.now = () => Number(now());
    this.channels = [];
    this.registering = new Map();
    this.latest = new Map();
    this.receivedAt = new Map();
    this.backoffs = new Map();
    this.generation = 0;
    this.revision = Symbol('initial revision');
    this.socketReady = false;
  }

  covers(sub, id) {
    if (this.stopped || !this.socketReady || !this.session || this.session.expiresAt <= this.now()) return false;
    const config = this.sources();
    if (config.revision !== this.revision || !selected(config).has(key(sub, id))) return false;
    return this.channels.some(c => c.sub === sub && c.providerId === id && c.streamId === this.session.streamId && c.expiresAt > this.now());
  }

  status() {
    const config = this.sources() || {}, wanted = selected(config);
    const connected = Boolean(this.origin && !this.stopped && wanted.size && config.revision === this.revision && this.socketReady &&
      this.session?.expiresAt > this.now());
    const covered = connected ? new Set(this.channels.filter(c => c.streamId === this.session.streamId && c.expiresAt > this.now() &&
      wanted.has(key(c.sub, c.providerId))).map(c => key(c.sub, c.providerId))).size : 0;
    let last = null;
    for (const c of this.channels) {
      const at = this.receivedAt.get(c.channelId);
      if (at !== undefined && c.expiresAt > this.now() && wanted.has(key(c.sub, c.providerId)) && (last === null || at > last)) last = at;
    }
    return { connected, selected: wanted.size, covered, lastNotificationAt: last === null ? null : new Date(last).toISOString() };
  }

  publish() {
    const status = this.status(), signature = JSON.stringify(status);
    if (signature !== this.lastStatus) { this.lastStatus = signature; this.onStatus(status); }
  }

  signal() {
    if (this.signalTimer || this.stopped) return;
    this.signalTimer = setTimeout(() => {
      this.signalTimer = null;
      if (this.status().connected) this.onChange();
    }, this.coalesceMs);
    this.signalTimer.unref?.();
  }

  arm(delay) {
    if (!this.automatic || this.stopped || !this.origin) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update(), Math.max(0, delay));
    this.timer.unref?.();
  }

  defer(name, err) {
    const count = Math.min(12, (this.backoffs.get(name)?.count || 0) + 1);
    const ordinary = Math.min(this.maxRetryMs, this.retryMs * 2 ** (count - 1) * (1 + this.random() / 4));
    const permission = err?.status === 403 && !/quota|rate.?limit|usageLimits/i.test(err.reason || '') ? 15 * 60000 : 0;
    const delay = Math.max(ordinary, permission, (Number(err?.retryAfterSeconds) || 0) * 1000);
    this.backoffs.set(name, { count, at: this.now() + delay });
  }

  available(name) { return (this.backoffs.get(name)?.at || 0) <= this.now(); }

  disconnect() {
    clearTimeout(this.handshake);
    clearTimeout(this.heartbeat);
    const socket = this.socket;
    this.socket = null;
    this.socketReady = false;
    try { socket?.close(); } catch { /* A connecting socket may already be closing. */ }
  }

  stop() {
    if (this.stopped) return this.work ?? Promise.resolve();
    this.stopped = true;
    this.generation++;
    this.session = null;
    this.requestAbort?.abort();
    clearTimeout(this.timer);
    clearTimeout(this.signalTimer);
    this.disconnect();
    this.publish();
    return this.work ?? Promise.resolve();
  }

  configuration() {
    const config = this.sources() || {};
    if (this.revision !== config.revision) {
      this.revision = config.revision;
      this.generation++;
      this.disconnect();
      this.session = null;
      this.backoffs.clear();
    }
    return selected(config);
  }

  current(generation, source) {
    if (this.stopped) return false;
    const wanted = this.configuration();
    return this.generation === generation && (source ? wanted.has(key(source.sub, source.id)) : wanted.size > 0);
  }

  async persist(channels) {
    const saved = channels.map(c => Object.fromEntries(channelFields.map(k => [k, c[k]])));
    await this.save({ deviceId: this.deviceId, channels: saved });
    this.channels = saved;
  }

  async initialize(create) {
    if (this.deviceId) return;
    const saved = await this.load() || {};
    if (device.test(saved.deviceId || '')) {
      this.deviceId = saved.deviceId;
      this.channels = (Array.isArray(saved.channels) ? saved.channels : []).filter(usableChannel)
        .map(c => ({ ...Object.fromEntries(channelFields.map(k => [k, c[k]])),
          renewAt: Number.isSafeInteger(c.renewAt) ? c.renewAt : c.expiresAt - this.renewBeforeMs }));
    } else if (create) {
      this.deviceId = randomBytes(32).toString('base64url');
      try { await this.persist([]); } catch (error) { this.deviceId = null; throw error; }
    }
  }

  async openSession(generation) {
    const proof = await this.identity();
    if (!this.current(generation)) return;
    if (!string(proof)) throw new Error('Google did not provide a notification identity.');
    const controller = new AbortController();
    this.requestAbort = controller;
    let response;
    try {
      response = await this.request(this.origin + '/v1/session', { method: 'POST', redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + proof }, body: JSON.stringify({ deviceId: this.deviceId }) });
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        throw Object.assign(new Error('The notification receiver could not establish a session.'), { status: response.status,
          retryAfterSeconds: /^\d+$/.test(retry || '') ? Number(retry) : 0 });
      }
      const data = await response.json();
      if (!stream.test(data.streamId || '') || !string(data.receiveToken) || !ticket.test(data.receiveToken) || data.receiveToken.length > 8192 ||
          !string(data.notifyToken) || !ticket.test(data.notifyToken) || data.notifyToken.length > 256 ||
          !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= this.now()) throw new Error('Invalid notification session.');
      if (!this.current(generation)) return;
      if (this.session && this.session.streamId !== data.streamId) this.disconnect();
      this.session = { streamId: data.streamId, receiveToken: data.receiveToken, notifyToken: data.notifyToken, expiresAt: data.expiresAt,
        renewAt: data.expiresAt - Math.min(this.renewBeforeMs, (data.expiresAt - this.now()) / 5) };
      this.backoffs.delete('session');
    } finally { if (this.requestAbort === controller) this.requestAbort = null; }
  }

  connect() {
    const { streamId, receiveToken } = this.session;
    const url = new URL('/v1/stream/' + streamId, this.origin);
    url.protocol = 'wss:';
    const socket = new this.Socket(url.href, ['dayline.v1', 'ticket.' + receiveToken]);
    this.socket = socket;
    const lost = () => {
      if (socket !== this.socket) return;
      this.disconnect();
      this.defer('socket');
      this.publish();
      this.arm(this.backoffs.get('socket').at - this.now());
    };
    const heartbeat = () => {
      clearTimeout(this.heartbeat);
      if (socket !== this.socket || !this.socketReady) return;
      this.heartbeat = setTimeout(() => {
        if (socket !== this.socket) return;
        // Arm before sending, so an immediate pong cancels the right timer.
        this.heartbeat = setTimeout(lost, this.handshakeMs);
        this.heartbeat.unref?.();
        try { socket.send('{"type":"ping"}'); } catch { lost(); }
      }, this.heartbeatMs);
      this.heartbeat.unref?.();
    };
    this.handshake = setTimeout(lost, this.handshakeMs);
    this.handshake.unref?.();
    socket.addEventListener('error', lost);
    socket.addEventListener('close', lost);
    socket.addEventListener('message', ({ data }) => {
      if (socket !== this.socket || this.stopped || typeof data !== 'string' || data.length > 2048) return;
      let packet;
      try { packet = JSON.parse(data); } catch { return; }
      if (packet?.type === 'ready' && !this.socketReady) {
        if (socket.protocol !== 'dayline.v1') return lost();
        clearTimeout(this.handshake);
        this.socketReady = true;
        this.backoffs.delete('socket');
        heartbeat();
        this.publish();
        this.signal(); // This recovers changes that arrived while the Mac slept.
        if (this.work) this.continueSoon = true;
        else this.arm(0);
      } else if (this.socketReady && packet?.type === 'pong') {
        heartbeat();
      } else if (this.socketReady && packet?.type === 'booking') {
        // A guest left a request on the booking page. The signal says no more than that.
        this.onBooking();
      } else if (this.socketReady && packet?.type === 'calendar' && ['sync', 'exists', 'not_exists'].includes(packet.state)) {
        const channel = this.channels.find(c => c.channelId === packet.channelId) || this.registering.get(packet.channelId);
        if (!channel || channel.streamId !== streamId || channel.expiresAt <= this.now() ||
            !this.current(channel.generation ?? this.generation, { sub: channel.sub, id: channel.providerId })) return;
        const n = packet.messageNumber;
        if ((typeof n !== 'string' && !Number.isSafeInteger(n)) || !/^[1-9]\d{0,29}$/.test(String(n))) return;
        const sequence = BigInt(n);
        if (sequence <= (this.latest.get(channel.channelId) || 0n)) return;
        this.latest.set(channel.channelId, sequence);
        this.receivedAt.set(channel.channelId, this.now());
        // Google can send its first sync packet before events.watch returns.
        // An accepted registration always emits a catch-up once durable.
        if (!this.registering.has(channel.channelId)) { this.publish(); this.signal(); }
      }
    });
  }

  async register(source, generation) {
    const token = await this.token(source.sub);
    if (!this.current(generation, source) || !this.session || !this.socketReady) return;
    const { streamId, notifyToken, expiresAt } = this.session;
    const channelId = randomUUID();
    const pending = { channelId, sub: source.sub, providerId: source.id, streamId, expiresAt, generation };
    this.registering.set(channelId, pending);
    let watch;
    try {
      watch = await this.google.watchCalendar(token, { calendarId: source.id, channelId, channelToken: notifyToken,
        address: this.origin + '/v1/google/' + streamId,
        ttlSeconds: Math.max(1, Math.min(604800, this.ttlSeconds, Math.floor((expiresAt - this.now()) / 1000))) });
      if (watch.channelId !== channelId || !string(watch.resourceId) || !Number.isSafeInteger(watch.expiration) || watch.expiration <= this.now()) {
        throw new Error('Invalid calendar watch.');
      }
      if (!this.current(generation, source) || this.session?.streamId !== streamId) {
        await this.google.stopCalendarWatch(token, watch);
        return;
      }
      const expiry = Math.min(watch.expiration, expiresAt);
      const record = { ...pending, expiresAt: expiry, resourceId: watch.resourceId,
        renewAt: Math.floor(expiry - Math.min(this.renewBeforeMs, (expiry - this.now()) / 5)) };
      try { await this.persist([...this.channels, record]); }
      catch (error) { await this.google.stopCalendarWatch(token, watch).catch(() => {}); throw error; }
      this.publish();
      this.signal();
    } finally {
      this.registering.delete(channelId);
      if (!this.channels.some(c => c.channelId === channelId)) { this.latest.delete(channelId); this.receivedAt.delete(channelId); }
    }
  }

  canRetire(record, replaced) {
    if (this.stopped) return false;
    if (record.expiresAt <= this.now()) return true;
    const config = this.sources() || {};
    if (!selected(config).has(key(record.sub, record.providerId))) return !config.uncertainSubs?.includes(record.sub);
    return replaced && this.channels.some(c => c.channelId !== record.channelId && c.sub === record.sub && c.providerId === record.providerId &&
      c.streamId === this.session?.streamId && c.expiresAt > this.now());
  }

  async retire(record, replaced) {
    if (!this.canRetire(record, replaced)) return;
    if (record.expiresAt > this.now()) {
      try {
        const access = await this.token(record.sub);
        if (!this.canRetire(record, replaced)) return;
        await this.google.stopCalendarWatch(access, record);
      } catch (error) {
        // A disconnected/revoked account cannot stop Google's expiring lease.
        // Forget the locally removed channel and ignore any remaining notices.
        const detached = this.canRetire(record, false);
        const unavailable = [401, 403, 404, 409, 410].includes(error?.status) ||
          (error?.status === 400 && error?.reason === 'invalid_grant');
        if (!detached || !unavailable ||
            /quota|rate.?limit|usageLimits/i.test(error?.reason || '')) throw error;
      }
    }
    await this.persist(this.channels.filter(c => c.channelId !== record.channelId));
    this.latest.delete(record.channelId);
    this.receivedAt.delete(record.channelId);
  }

  update({ resume = false } = {}) {
    if (!this.origin || this.stopped) return Promise.resolve(this.status());
    const now = this.now();
    if (this.socket && (resume || (this.lastUpdateAt !== undefined && now - this.lastUpdateAt > this.staleAfterMs))) {
      this.disconnect();
      this.backoffs.delete('socket');
      this.publish();
    }
    this.lastUpdateAt = now;
    if (this.work) { this.continueSoon = true; return this.work; }
    if (!this.work) this.work = this.maintain().catch(() => this.defer('maintenance')).finally(() => {
      this.work = null;
      this.publish();
      if (!this.stopped) {
        const now = this.now(), delays = [this.maintenanceMs];
        for (const state of this.backoffs.values()) if (state.at > now) delays.push(state.at - now);
        for (const c of this.channels) if (c.renewAt > now) delays.push(c.renewAt - now);
        if (this.session?.renewAt > now) delays.push(this.session.renewAt - now);
        this.arm(this.continueSoon ? this.batchDelayMs : Math.max(1, Math.min(...delays)));
        this.continueSoon = false;
      }
    }).then(() => this.status());
    return this.work;
  }

  async maintain() {
    let wanted = this.configuration();
    if (!this.available('maintenance')) return;
    await this.initialize(wanted.size > 0);
    this.backoffs.delete('maintenance');
    if (this.stopped) return;
    wanted = this.configuration();
    const generation = this.generation;
    if (!wanted.size) { this.disconnect(); this.session = null; }
    if (wanted.size && this.available('session') && (!this.session || this.session.renewAt <= this.now())) {
      try { await this.openSession(generation); } catch (error) { this.defer('session', error); }
    }
    if (this.stopped || generation !== this.generation) return;
    if (this.session?.expiresAt <= this.now()) { this.session = null; this.disconnect(); }
    if (wanted.size && this.session && !this.socket && this.available('socket')) {
      try { this.connect(); } catch (error) { this.defer('socket', error); }
    }
    let operations = 0;
    if (this.socketReady) for (const [id, source] of wanted) {
      const accountBackoff = 'write-watch:' + source.sub;
      if (!this.available(id) || !this.available(accountBackoff) || !this.current(generation, source)) continue;
      if (this.channels.some(c => c.sub === source.sub && c.providerId === source.id && c.streamId === this.session?.streamId && c.renewAt > this.now())) continue;
      if (operations++ >= this.batchSize) { this.continueSoon = true; break; }
      try { await this.register(source, generation); this.backoffs.delete(id); this.backoffs.delete(accountBackoff); }
      catch (error) {
        this.defer(id, error);
        if (error?.status === 429 || /quota|rate.?limit|usageLimits/i.test(error?.reason || '')) this.defer(accountBackoff, error);
      }
    }
    if (this.stopped || generation !== this.generation) return;
    const best = new Map();
    for (const c of this.channels) {
      if (c.expiresAt <= this.now() || !wanted.has(key(c.sub, c.providerId))) continue;
      const id = key(c.sub, c.providerId), previous = best.get(id);
      if (!previous || (this.session && previous.streamId !== this.session.streamId && c.streamId === this.session.streamId) ||
          (previous.streamId === c.streamId && previous.expiresAt <= c.expiresAt)) best.set(id, c);
    }
    for (const c of [...this.channels]) {
      if (best.get(key(c.sub, c.providerId)) === c || !this.available(c.channelId)) continue;
      const replaced = wanted.has(key(c.sub, c.providerId));
      if (!this.canRetire(c, replaced)) continue;
      if (operations++ >= this.batchSize) { this.continueSoon = true; break; }
      try { await this.retire(c, replaced); this.backoffs.delete(c.channelId); } catch (error) { this.defer(c.channelId, error); }
    }
  }
}
