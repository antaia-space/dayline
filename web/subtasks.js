import {duration,element} from "./ui.js";

const expansion = new Map();
const pending = new Map();
const childKey = (parent,child) => JSON.stringify([parent,child]);

export function subtaskSummary(items) {
  return items.filter(item => item.done).length + " of " + items.length;
}

export function overrunNote(task) {
  const n = task.overrunMinutes;
  return Number.isSafeInteger(n) && n > 0 ? {
    label:"+" + duration(n) + " from free time",
    explanation:"Dayline added " + duration(n) + " of free time. It can extend an unfinished task by up to five minutes at a time."
  } : null;
}

export function taskChecklist(task,view,initiallyOpen = false) {
  if (!Array.isArray(task.subtasks) || !task.subtasks.length) return null;
  const details = element("details","task-checklist");
  details.dataset.checklist = task.id;
  details.dataset.checkView = view;
  const key = JSON.stringify([task.id,view]);
  details.open = expansion.get(key) ?? initiallyOpen;
  details.addEventListener("toggle",() => { if (details.isConnected) expansion.set(key,details.open); });
  const summary = element("summary","subtask-summary");
  summary.dataset.focus = view + "-subtasks-" + task.id;
  const label = "Subtasks for " + (task.title || task.text);
  const count = element("span","subtask-count",subtaskSummary(task.subtasks));
  count.setAttribute("aria-live","polite");
  summary.setAttribute("aria-label",label + ", " + count.textContent + " complete");
  summary.addEventListener("click",() => expansion.set(key,!details.open));
  summary.append(document.createTextNode("Subtasks "),count);
  const list = element("ul","subtask-list");
  list.setAttribute("aria-label",label);
  for (const subtask of task.subtasks) {
    const item = element("li");
    const label = element("label","subtask-label");
    const box = element("input","subtask-box");
    box.type = "checkbox";
    box.checked = pending.get(childKey(task.id,subtask.id)) ?? Boolean(subtask.done);
    box.disabled = task.syncStatus === "deleting";
    box.dataset.parent = task.id;
    box.dataset.subtask = subtask.id;
    box.dataset.focus = view + "-subtask-" + task.id + "-" + subtask.id;
    label.append(box,element("span","",subtask.title));
    item.append(label);
    list.append(item);
  }
  details.append(summary,list);
  return details;
}

export function createSubtaskControls({api,refresh,getState,notify,editor}) {
  let editorSignature = "";
  function paint() {
    for (const list of document.querySelectorAll("details[data-checklist]")) {
      const boxes = [...list.querySelectorAll("input[data-subtask]")];
      for (const box of boxes) {
        const key = childKey(box.dataset.parent,box.dataset.subtask);
        if (pending.has(key)) { box.checked = pending.get(key); box.setAttribute("aria-busy","true"); }
        else box.removeAttribute("aria-busy");
      }
      const count = list.querySelector(".subtask-count");
      const progress = boxes.filter(box => box.checked).length + " of " + boxes.length;
      if (count.textContent !== progress) {
        count.textContent = progress;
        list.querySelector("summary").setAttribute("aria-label",list.querySelector("ul").getAttribute("aria-label") + ", " + progress + " complete");
      }
    }
  }
  function showEditor(task) {
    const signature = JSON.stringify([task.id,task.title || task.text,task.subtasks,task.syncStatus === "deleting"]);
    if (signature === editorSignature) return;
    editorSignature = signature;
    const focused = editor.contains(document.activeElement) && document.activeElement.dataset.focus;
    const checklist = taskChecklist(task,"editor",true);
    editor.replaceChildren(...(checklist ? [checklist] : []));
    editor.hidden = !checklist;
    if (focused) editor.querySelector('[data-focus="' + CSS.escape(focused) + '"]')?.focus({preventScroll:true});
    paint();
  }
  document.addEventListener("change",async event => {
    const box = event.target.closest?.("input[data-parent][data-subtask]");
    if (!box) return;
    const {parent,subtask} = box.dataset;
    const key = childKey(parent,subtask);
    if (pending.has(key)) { box.checked = pending.get(key); return; }
    const task = getState()?.tasks.find(item => item.id === parent);
    const original = task?.subtasks?.find(item => item.id === subtask);
    if (!original || task.syncStatus === "deleting") return;
    const requested = box.checked, bookmark = box.dataset.focus;
    const ownedFocus = document.activeElement === box;
    pending.set(key,requested);
    paint();
    try {
      await api("/api/tasks/" + encodeURIComponent(parent) + "/subtasks/" + encodeURIComponent(subtask),"PATCH",{done:requested});
    } catch (error) {
      notify(error.message);
    } finally {
      pending.delete(key);
      await refresh(true);
      const latest = getState()?.tasks.find(item => item.id === parent)?.subtasks?.find(item => item.id === subtask);
      for (const input of document.querySelectorAll("input[data-subtask]")) {
        if (input.dataset.parent === parent && input.dataset.subtask === subtask) input.checked = Boolean((latest || original).done);
      }
      paint();
      if (ownedFocus && document.activeElement === document.body) {
        const replacement = document.querySelector('[data-focus="' + CSS.escape(bookmark) + '"]');
        const details = replacement?.closest("details");
        (details && !details.open ? details.querySelector("summary") : replacement)?.focus({preventScroll:true});
      }
    }
  });
  return {paint,showEditor};
}
