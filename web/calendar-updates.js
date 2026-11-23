// The local service sends a revision after checking calendars and replanning.
// A revision carries no meeting details and never initiates another provider check.
export function createCalendarUpdates({open,refresh,invalidate,check,canCheck,visible,
  now = Date.now,schedule = setTimeout,cancel = clearTimeout}) {
  let source = null, connected = false, revision = null, previouslyOpen = false;
  let dirty = false, reading = false, flushing = null, reconnect = null, delay = 1000;
  let checking = false, lastCheck = -Infinity, lastWake = -Infinity;

  function queue(stale = false) {
    if (stale) invalidate();
    dirty = true;
    if (!visible() || reading || flushing !== null) return;
    flushing = schedule(async () => {
      flushing = null;
      if (!visible()) return;
      dirty = false; reading = true;
      try { await refresh(); }
      finally { reading = false; if (dirty && visible()) queue(); }
    },45);
  }

  function verify() {
    if (!visible() || !canCheck() || checking || now()-lastCheck < 2500) return;
    checking = true; lastCheck = now();
    Promise.resolve().then(check).catch(() => {}).finally(() => { checking = false; });
  }

  function retryConnection() {
    if (!open || reconnect !== null || !visible()) return;
    reconnect = schedule(() => { reconnect = null; connect(); },delay);
    delay = Math.min(30000,delay*2);
  }

  function connect() {
    if (!open || source || !visible()) return;
    try { source = open(); }
    catch { retryConnection(); return; }
    const stream = source;
    stream.addEventListener("open",() => {
      if (stream !== source) return;
      connected = true; revision = null; delay = 1000;
      if (previouslyOpen) verify();
      previouslyOpen = true;
    });
    stream.addEventListener("calendar",event => {
      if (stream !== source) return;
      let next;
      try { next = JSON.parse(event.data)?.revision; } catch { return; }
      if (!Number.isSafeInteger(next) || next < 0 || (revision !== null && next <= revision)) return;
      revision = next;
      queue(true);
    });
    stream.addEventListener("error",() => {
      if (stream !== source) return;
      if (connected) { connected = false; queue(true); }
      // EventSource itself retries transient interruptions. A terminal HTTP
      // failure leaves it CLOSED and needs a fresh connection.
      if (stream.readyState === 2) {
        stream.close(); source = null; retryConnection();
      }
    });
  }

  function sleep() {
    source?.close(); source = null; connected = false;
    cancel(reconnect); reconnect = null; cancel(flushing); flushing = null;
    lastWake = -Infinity;
  }

  function wake({reloadMeetings = true} = {}) {
    if (!visible()) return;
    if (reconnect === null) connect();
    if (now()-lastWake < 350) return;
    lastWake = now();
    verify(); queue(!connected && reloadMeetings);
  }

  function poll() {
    if (!visible()) return;
    if (reconnect === null) connect();
    if (!connected) verify();
    queue();
  }

  return {connect,wake,sleep,poll,get connected() { return connected; }};
}
