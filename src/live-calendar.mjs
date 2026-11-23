import { CalendarMonitor } from './calendar-monitor.mjs';
import { CalendarPush } from './calendar-push.mjs';

// One Google connection per installation serves every paired planner window.
// A revision is published only after the local task plan has caught up.
export class LiveCalendar {
  constructor(service, { monitor, push, enabled }) {
    this.service = service;
    this.clients = new Set();
    this.revision = 0;
    this.requested = 0;
    this.closed = false;
    this.enabled = enabled;
    this.push = push?.origin ? new CalendarPush({
      sources: () => service.calendarMonitorSources(),
      token: sub => service.token(sub), identity: () => service.relayIdentity(),
      google: service.google, load: () => service.data.calendarPush || {},
      save: value => service.run(() => { service.data.calendarPush = value; service.store.save(); }),
      ...push, onChange: () => this.refresh().catch(() => {}), onStatus: () => this.check()
    }) : null;
    this.monitor = new CalendarMonitor({
      sources: () => {
        const sources = service.calendarMonitorSources();
        if (this.push) sources.calendars = sources.calendars.filter(c => !this.push.covers(c.sub, c.id));
        return sources;
      },
      token: sub => service.token(sub), google: service.google, ...monitor
    });
  }

  status() {
    return { configured: Boolean(this.push), ...(this.push?.status() ?? { connected: false, selected: 0, covered: 0 }) };
  }

  attach(res) {
    this.clients.add(res);
    this.writeRevision(res);
    res.once('close', () => this.clients.delete(res));
    this.check();
  }

  writeRevision(res) {
    res.write('id: ' + this.revision + '\nevent: calendar\ndata: ' +
      JSON.stringify({ revision: this.revision }) + '\n\n');
  }

  heartbeat() {
    for (const res of this.clients) res.write(': dayline\n\n');
  }

  refresh() {
    if (this.closed) return Promise.resolve();
    this.service.meetingAgenda.expire();
    this.requested++;
    this.refreshing ??= Promise.resolve().then(() => this.reconcile());
    return this.refreshing;
  }

  async reconcile() {
    try {
      // A sync already reading Google may have started before this notification.
      if (this.service.pendingSync) await this.service.pendingSync.catch(() => {});
      while (!this.closed) {
        const wanted = this.requested;
        try { await this.service.queueSync(); }
        finally {
          if (!this.closed && wanted === this.requested) {
            this.service.meetingAgenda.expire();
            this.revision++;
            for (const res of this.clients) this.writeRevision(res);
          }
        }
        if (wanted === this.requested) break;
      }
    } finally {
      this.refreshing = null;
      this.scheduleRecovery();
      this.updateSources();
    }
  }

  scheduleRecovery() {
    if (this.closed || !this.service.data.accounts.length || !this.service.transientSyncError) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      this.recoveryDelay = 0;
      return;
    }
    if (this.recoveryTimer) return;
    // A notification may have advanced the change cursor before free/busy
    // failed. Retry that plan even when subsequent probes report no changes.
    this.recoveryDelay = Math.min(60000, this.recoveryDelay ? this.recoveryDelay * 2 : 2000);
    const delay = Math.max(this.recoveryDelay, (this.service.retrySyncAt || 0) - Date.now());
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.refresh().catch(() => {});
    }, delay);
    this.recoveryTimer.unref();
  }

  updateSources() {
    if (this.closed) return;
    this.push?.update().catch(() => {});
    this.check();
  }

  resume() {
    if (!this.service.data.accounts.length || this.closed) return;
    this.push?.update({ resume: true }).catch(() => {});
    void this.refresh().catch(() => {});
  }

  // Multiple focus/online events share the probe. The monitor itself enforces
  // its Google request budget and Retry-After even when a window asks early.
  check() {
    if (this.closed || !this.enabled || this.checking) return;
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.service.data.accounts.length) return;
    this.checking = this.monitor.poll().then(result => {
      if (result.changed && !this.closed) void this.refresh().catch(() => {});
      return result.nextDelayMs;
    }).catch(() => 15000).then(delay => {
      this.checking = null;
      if (!this.closed && this.service.data.accounts.length) {
        this.timer = setTimeout(() => this.check(), Math.max(15, delay));
        this.timer.unref();
      }
    });
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.recoveryTimer);
    this.monitor.stop();
    const pushStopped = this.push?.stop();
    for (const res of this.clients) res.end();
    this.clients.clear();
    await Promise.allSettled([this.checking, this.refreshing, pushStopped]);
  }
}
