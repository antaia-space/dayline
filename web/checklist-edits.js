const keyFor = (parent,id) => JSON.stringify([parent,id]);

export function validSubtaskTitle(value) {
  if (typeof value !== "string" || /[\p{Cc}\u2028\u2029]/u.test(value)) return false;
  const length = [...value.trim()].length;
  return length > 0 && length <= 160;
}

export function checklistRequest({parent,id,kind,title,expectedTitle,done,expectedDone,requestId}) {
  const base = "/api/tasks/" + encodeURIComponent(parent) + "/subtasks";
  const url = base + "/" + encodeURIComponent(id);
  if (kind === "add") return [base,"POST",{id,title}];
  if (kind === "rename") return [url,"PATCH",{title,expectedTitle,requestId}];
  if (kind === "toggle") return [url,"PATCH",{done,expectedDone,requestId}];
  if (kind === "remove") return [url,"DELETE",{expectedTitle,requestId}];
  throw new Error("Unknown checklist change.");
}

function applied(change, item) {
  if (change.kind === "remove") return !item;
  if (!item) return false;
  if (change.kind === "toggle") return item.done === change.done;
  return item.title === change.title;
}

// Each task sends changes in the order entered. Its own ID and expected value
// distinguish a repeated request from an unrelated edit in another window.
export function createChecklistEdits({api,refresh,changed,storage,findTask}) {
  const changes = new Map();
  const tails = new Map();
  const storageKey = "dayline.checklist.changes.v1";
  try {
    for (const saved of JSON.parse(storage?.getItem(storageKey) || "[]")) {
      if (!saved || typeof saved.parent !== "string" || typeof saved.id !== "string" || !["add","rename","remove","toggle"].includes(saved.kind)) continue;
      changes.set(keyFor(saved.parent,saved.id),{...saved,state:"failed",error:"Check the latest version or retry this change."});
    }
  } catch {}
  function persist() {
    try {
      if (changes.size) storage?.setItem(storageKey,JSON.stringify([...changes.values()]));
      else storage?.removeItem(storageKey);
    } catch {}
  }
  function send(change) {
    change.state = "pending";
    delete change.error;
    persist();
    changed(change.parent);
    const prior = tails.get(change.parent) || Promise.resolve();
    const next = prior.then(async () => {
      try {
        await api(...checklistRequest(change));
        change.state = "saved";
      } catch (error) {
        change.state = "failed";
        change.error = error.message || "Dayline couldn’t save this change.";
        change.conflict = error.status === 409;
      }
      persist();
      changed(change.parent);
      const previous = findTask?.(change.parent);
      await refresh(true);
      // A later edit in another window can supersede a successful request.
      // The next fresh snapshot is authoritative even when its value differs.
      const key = keyFor(change.parent,change.id);
      if (change.state === "saved" && changes.get(key) === change && findTask && previous !== findTask(change.parent)) {
        changes.delete(key); persist(); changed(change.parent);
      }
    }).catch(() => {});
    tails.set(change.parent,next);
    next.finally(() => { if (tails.get(change.parent) === next) tails.delete(change.parent); });
    return next;
  }
  function submit(change) {
    const key = keyFor(change.parent,change.id);
    if (changes.has(key)) return;
    if (change.kind !== "add") change.requestId = crypto.randomUUID().replaceAll("-","");
    changes.set(key,change);
    return send(change);
  }
  function retry(parent,id) {
    const change = changes.get(keyFor(parent,id));
    if (change?.state === "failed" && !change.conflict) return send(change);
  }
  function dismiss(parent,id) {
    const key = keyFor(parent,id);
    if (changes.get(key)?.state !== "failed") return;
    changes.delete(key);
    persist();
    changed(parent);
  }
  function items(task) {
    const result = (task.subtasks || []).map(item => ({...item}));
    for (const [key,change] of changes) {
      if (change.parent !== task.id) continue;
      let item = result.find(row => row.id === change.id);
      if (change.state !== "pending" && applied(change,item)) {
        changes.delete(key);
        persist();
        continue;
      }
      if (!item) {
        item = {id:change.id,title:change.title || change.expectedTitle || "Subtask",done:false};
        result.push(item);
      }
      // Keep the server's version visible for a rejected change. The proposed
      // wording remains in the error row until the user retries or dismisses it.
      if (change.state !== "failed" && change.kind === "rename") item.title = change.title;
      if (change.state !== "failed" && change.kind === "toggle") item.done = change.done;
      item.change = change;
    }
    return result;
  }
  return {submit,retry,dismiss,items};
}
