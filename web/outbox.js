const prefix = "dayline.capture.";
const keyFor = id => prefix + id;

export function localRead(area,key) {
  try { return window[area].getItem(key); } catch { return null; }
}
export function localWrite(area,key,value) {
  try {
    if (value === null) window[area].removeItem(key);
    else window[area].setItem(key,value);
    return true;
  } catch { return false; }
}
export function recordsWithPrefix(area,startsWith) {
  const records = [];
  try {
    const storage = window[area];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(startsWith)) {
        try { const record = JSON.parse(storage.getItem(key)); if (record && key === startsWith + record.id) records.push(record); }
        catch { /* An unreadable entry should not hide the other saved tasks. */ }
      }
    }
  } catch { /* The current window can still send tasks without browser storage. */ }
  return records;
}

export function createCaptureOutbox({api,onChange,onAccepted,onRemoteChange}) {
  const memory = new Map();
  let timer = null, active = false, lastOrder = 0;
  const entries = () => [...new Map([
    ...memory, ...recordsWithPrefix("sessionStorage",prefix).map(r => [r.id,r]),
    ...recordsWithPrefix("localStorage",prefix).map(r => [r.id,r])
  ]).values()].sort((a,b) => (a.order ?? a.createdAt * 1000) - (b.order ?? b.createdAt * 1000) || a.id.localeCompare(b.id));

  function put(item) {
    const encoded = JSON.stringify(item);
    if (localWrite("localStorage",keyFor(item.id),encoded)) return true;
    if (localWrite("sessionStorage",keyFor(item.id),encoded)) return true;
    memory.set(item.id,item);
    return false;
  }
  function remove(id) {
    localWrite("localStorage",keyFor(id),null);
    localWrite("sessionStorage",keyFor(id),null);
    memory.delete(id);
  }
  function wake(delay = 0) {
    window.clearTimeout(timer);
    timer = window.setTimeout(pump,delay);
  }
  async function send(item) {
    const request = {requestId:item.id,text:item.text};
    if (Number.isFinite(item.createdAt)) request.capturedAt = item.createdAt;
    if (item.captureTimeZone) request.captureTimeZone = item.captureTimeZone;
    if (item.provider) request.captureAgent = {provider:item.provider,model:item.model || "",...(item.effort ? {effort:item.effort} : {})};
    if (item.day) request[item.implicit ? "viewDay" : "day"] = item.day;
    try {
      const response = await api("/api/tasks","POST",request);
      if (response.id !== item.id) throw new Error("Dayline has not confirmed this task yet.");
      remove(item.id);
      onAccepted(item);
    } catch (error) {
      if (!entries().some(current => current.id === item.id)) return;
      const blocked = error.status >= 400 && error.status < 500 && ![401,408,429].includes(error.status);
      const tries = (item.tries || 0) + 1;
      put({...item,tries,blocked,problem:error.message,nextAt:Date.now() + Math.min(30000,1500 * 2 ** Math.min(tries,5))});
    }
  }
  async function drain() {
    for (;;) {
      const first = entries().find(item => !item.blocked);
      if (!first || first.nextAt > Date.now()) return;
      await send(first);
      onChange();
    }
  }
  async function pump() {
    timer = null;
    if (active) return;
    active = true;
    try {
      // The shared lock keeps the order of disk acknowledgements across browser windows.
      // When Web Locks are unavailable, the service still deduplicates each capture by ID.
      if (navigator.locks) await navigator.locks.request("dayline.capture.drain",{ifAvailable:true},lock => lock ? drain() : undefined);
      else await drain();
    } finally {
      active = false;
      const first = entries().find(item => !item.blocked);
      if (first) wake(Math.max(300,(first.nextAt || 0) - Date.now()));
    }
  }
  window.addEventListener("storage",event => {
    if (!event.key || event.key.startsWith(prefix)) {
      onChange(); wake();
      if (event.key && event.newValue === null) onRemoteChange();
    }
  });
  window.addEventListener("online",() => wake());
  return {
    entries, remove,
    add(item) {
      const waiting = entries();
      if (waiting.some(current => current.id === item.id)) return !memory.has(item.id);
      const last = waiting.at(-1);
      lastOrder = Math.max(lastOrder + 1,(last?.order ?? (last?.createdAt || 0) * 1000) + 1,
        Math.floor((performance.timeOrigin + performance.now()) * 1000));
      const saved = put({...item,order:lastOrder});
      wake();
      return saved;
    },
    retry(id) {
      const item = entries().find(entry => entry.id === id);
      if (item) { put({...item,blocked:false,nextAt:0,problem:""}); onChange(); wake(); }
    },
    reconcile(tasks) {
      const received = new Set(tasks.map(task => task.id));
      for (const item of entries()) if (received.has(item.id)) remove(item.id);
      if (!timer && !active && entries().some(item => !item.blocked)) wake();
    }
  };
}
