import { duration } from "./ui.js";
import { localWrite, recordsWithPrefix } from "./outbox.js";

const prefix = "dayline.duration.";
export function createDurationControls({api,refresh,getState,notify}) {
  const memory = new Map(), own = new Set(), confirmed = new Map(), working = new Set();
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("dayline.durationUpdates") : null;
  let timer, sequence = 0;
  const operations = () => [...new Map([
    ...memory,...recordsWithPrefix("sessionStorage",prefix).map(item => [item.id,item]),
    ...recordsWithPrefix("localStorage",prefix).map(item => [item.id,item])
  ]).values()].sort((a,b) => a.order - b.order || a.id.localeCompare(b.id));
  function save(item) {
    const value = JSON.stringify(item);
    if (!localWrite("localStorage",prefix + item.id,value) && !localWrite("sessionStorage",prefix + item.id,value)) memory.set(item.id,item);
  }
  function remove(id) {
    localWrite("localStorage",prefix + id,null); localWrite("sessionStorage",prefix + id,null);
    memory.delete(id); own.delete(id);
  }
  function predicted(task,ops) {
    return ops.reduce((minutes,item) => minutes + (item.taskId === task.id && own.has(item.id) ? item.delta : 0),confirmed.get(task.id) ?? task.minutes);
  }
  function paint() {
    const state = getState();
    if (!state) return;
    const ops = operations();
    for (const group of document.querySelectorAll("[data-duration-for]")) {
      const task = state.tasks.find(item => item.id === group.dataset.durationFor);
      if (!task) continue;
      const minutes = predicted(task,ops);
      const output = group.querySelector(".duration-value");
      const label = task.allDay && minutes === 1440 && !task.estimatedMinutes ? "Effort" : duration(minutes);
      if (output.textContent !== label) output.textContent = label;
      group.dataset.pending = String(ops.some(item => item.taskId === task.id));
      const minus = group.querySelector('[data-delta="-5"]');
      const heldFocus = document.activeElement === minus;
      minus.disabled = minutes <= 5;
      if (heldFocus && minus.disabled) group.querySelector('[data-delta="5"]').focus({preventScroll:true});
      group.title = task.calendarFit?.originalMinutes > minutes
        ? "Planned work · " + minutes + " minutes. Adjust to keep your chosen duration."
        : "Estimated work · " + minutes + " minutes";
    }
    if (ops.length && !timer && !working.size) wake();
  }
  function wake(delay = 0) { clearTimeout(timer); timer = setTimeout(pump,delay); }
  async function drain(taskId) {
    for (;;) {
      const next = operations().find(item => item.taskId === taskId);
      if (!next || next.nextAt > Date.now()) break;
      try {
        const result = await api("/api/tasks/" + encodeURIComponent(taskId) + "/duration","POST",{delta:next.delta,requestId:next.id});
        if (result.id !== taskId || !Number.isSafeInteger(result.minutes) || result.minutes < 1) throw new Error("Dayline is still confirming the duration.");
        remove(next.id); confirmed.set(taskId,result.minutes);
        channel?.postMessage({taskId,minutes:result.minutes,id:next.id});
      } catch (error) {
        if (!operations().some(item => item.id === next.id)) continue;
        if (error.status >= 400 && error.status < 500 && ![401,408,429].includes(error.status)) {
          remove(next.id); notify(error.message);
        } else {
          const tries = (next.tries || 0) + 1;
          save({...next,tries,nextAt:Date.now() + Math.min(30000,1500 * 2 ** Math.min(tries,5))});
          if (tries === 1) notify("Duration change saved on this device. Dayline will retry.");
          break;
        }
      }
      paint();
    }
    if (!operations().some(item => item.taskId === taskId)) {
      await refresh(true);
      if (!operations().some(item => item.taskId === taskId)) confirmed.delete(taskId);
    }
    paint();
  }
  function pump() {
    timer = null;
    const ops = operations();
    const firstByTask = new Map();
    for (const op of ops) if (!firstByTask.has(op.taskId)) firstByTask.set(op.taskId,op);
    for (const [taskId,first] of firstByTask) {
      if (working.has(taskId) || first.nextAt > Date.now()) continue;
      working.add(taskId);
      const work = navigator.locks ? navigator.locks.request(prefix + taskId,{ifAvailable:true},lock => lock ? drain(taskId) : undefined) : drain(taskId);
      Promise.resolve(work).catch(() => {}).finally(() => { working.delete(taskId); if (operations().length) wake(400); });
    }
    if (ops.length) wake(1200);
  }
  channel?.addEventListener("message",event => {
    const {taskId,minutes,id} = event.data || {};
    if (!Number.isSafeInteger(minutes) || minutes < 1 || !getState()?.tasks.some(task => task.id === taskId)) return;
    own.delete(id); confirmed.set(taskId,minutes); paint();
    if (!operations().some(item => item.taskId === taskId)) {
      void refresh(true).then(() => { if (!operations().some(item => item.taskId === taskId)) confirmed.delete(taskId); paint(); });
    }
  });
  window.addEventListener("storage",event => { if (event.key?.startsWith(prefix)) { wake(); if (!event.newValue && !channel) void refresh(true); } });
  window.addEventListener("online",() => wake());
  return { paint, adjust(task,delta) {
    if (![5,-5].includes(delta) || task.pendingEstimate || task.syncStatus === "deleting") return;
    const shown = predicted(task,operations());
    if (shown + delta < 1 || !Number.isSafeInteger(shown + delta)) return;
    if (!confirmed.has(task.id)) confirmed.set(task.id,task.minutes);
    const id = crypto.randomUUID().replaceAll("-","");
    own.add(id);
    save({id,taskId:task.id,delta,order:Date.now() * 1000 + sequence++ % 1000});
    paint(); wake();
  }};
}
