import {duration,element,icon} from "./ui.js";
import {createChecklistEdits,validSubtaskTitle} from "./checklist-edits.js";

const expansion = new Map();
const drafts = new Map();
const draftKey = (parent,id) => JSON.stringify([parent,id]);
const draftStorage = "dayline.checklist.drafts.v1";
let changes;

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

function actionButton(action,label,bookmark,text,symbol) {
  const button = element("button",symbol ? "subtask-tool" : "subtask-action",text);
  button.type = "button";
  button.dataset.stepAction = action;
  button.dataset.focus = bookmark + "-" + action;
  button.setAttribute("aria-label",label);
  button.title = label;
  if (symbol) button.append(icon(symbol));
  return button;
}

function textField(mode,label,bookmark,value) {
  const input = element("input","subtask-text");
  input.type = "text";
  input.maxLength = 320; // 160 Unicode characters may each use two UTF-16 code units.
  input.autocomplete = "off";
  input.value = value;
  input.dataset.stepField = mode;
  input.dataset.focus = bookmark + "-input";
  input.setAttribute("aria-label",label);
  return input;
}

function statusRow(item,bookmark) {
  const {change} = item;
  const failed = change.state === "failed";
  const status = element("div","subtask-status" + (failed ? " has-error" : ""));
  status.setAttribute("role","status");
  const saving = change.kind === "remove" ? "Removing…" : "Saving…";
  const intended = change.kind === "rename" ? " Rename to “" + change.title + "”." : "";
  status.append(element("span","",failed ? change.error + intended : saving));
  if (failed) {
    if (!change.conflict) status.append(actionButton("retry","Retry change to " + item.title,bookmark,"Retry"));
    status.append(actionButton("dismiss","Dismiss change to " + item.title,bookmark,change.conflict ? "Use current version" : "Dismiss"));
  }
  return status;
}

function checklistRow(task,item,view) {
  const row = element("li","subtask-row");
  row.dataset.child = item.id;
  const bookmark = view + "-subtask-" + task.id + "-" + item.id;
  const draft = drafts.get(draftKey(task.id,item.id));
  const locked = task.syncStatus === "deleting";
  if (draft && !item.change && !locked) {
    row.className += " is-editing";
    if (draft.removing) {
      row.append(element("span","subtask-question","Remove “" + item.title + "”?"));
      const confirm = actionButton("confirm-remove","Confirm removal of " + item.title,bookmark,"Remove");
      confirm.className += " danger";
      row.append(confirm,actionButton("keep","Keep " + item.title,bookmark,"Keep"));
    } else {
      row.append(textField("rename","Name for " + item.title,bookmark,draft.value));
      const remove = actionButton("remove","Remove " + item.title,bookmark,"Remove");
      remove.className += " danger";
      row.append(actionButton("save","Save name for " + item.title,bookmark,"Save"),
        actionButton("cancel","Cancel editing " + item.title,bookmark,"Cancel"),remove);
    }
  } else {
    const label = element("label","subtask-label");
    const box = element("input","subtask-box");
    box.type = "checkbox";
    box.checked = Boolean(item.done);
    box.disabled = locked || Boolean(item.change);
    box.dataset.parent = task.id;
    box.dataset.subtask = item.id;
    box.dataset.focus = bookmark;
    if (item.change && item.change.state !== "failed") box.setAttribute("aria-busy","true");
    label.append(box,element("span","",item.title));
    row.append(label);
    if (!item.change && !locked) row.append(actionButton("edit","Edit subtask “" + item.title + "”",bookmark,undefined,"pencil"));
    if (item.change) row.append(statusRow(item,bookmark));
  }
  return row;
}

export function taskChecklist(task,view,initiallyOpen = false) {
  if (!task.id) return null;
  const items = changes?.items(task) || task.subtasks || [];
  if (task.syncStatus === "deleting" && !items.length) return null;
  const details = element("details","task-checklist" + (items.length ? "" : " empty-checklist"));
  details.dataset.checklist = task.id;
  details.dataset.checkView = view;
  const key = JSON.stringify([task.id,view]);
  details.open = expansion.get(key) ?? initiallyOpen;
  details.ontoggle = () => { if (details.isConnected) expansion.set(key,details.open); };
  const summary = element("summary","subtask-summary");
  const base = view + "-subtasks-" + task.id;
  summary.dataset.focus = base;
  const label = "Subtasks for " + (task.title || task.text);
  if (items.length) {
    const count = element("span","subtask-count",subtaskSummary(items));
    count.setAttribute("aria-live","polite");
    summary.setAttribute("aria-label",label + ", " + count.textContent + " complete");
    summary.append(document.createTextNode("Subtasks "),count);
  } else {
    summary.textContent = view === "editor" ? "Subtasks" : "Add subtask";
    summary.setAttribute("aria-label",view === "editor" ? label : "Add a subtask to " + (task.title || task.text));
  }
  summary.onclick = () => {
    expansion.set(key,!details.open);
    if (!details.open && !items.length) requestAnimationFrame(() => {
      if (details.isConnected && details.open && document.activeElement === summary) details.querySelector("[data-step-field='add']")?.focus({preventScroll:true});
    });
  };
  const list = element("ul","subtask-list");
  list.setAttribute("aria-label",label);
  for (const item of items) list.append(checklistRow(task,item,view));
  details.append(summary,list);
  if (task.syncStatus !== "deleting") {
    const add = element("div","subtask-new");
    const input = textField("add","New subtask for " + (task.title || task.text),base,drafts.get(draftKey(task.id,""))?.value || "");
    input.placeholder = "Add a subtask…";
    add.append(input,actionButton("add","Add subtask",base,"Add"));
    details.append(add);
  }
  return details;
}

export function subtaskCaret(input) {
  return input?.dataset.stepField ? [input.selectionStart,input.selectionEnd,input.selectionDirection] : null;
}

export function restoreSubtaskCaret(input,caret) {
  if (input?.dataset.stepField && caret) input.setSelectionRange(...caret);
}

export function createSubtaskControls({api,refresh,getState,editor,repaint,storage}) {
  let composing = false, deferred = false, editorSignature = "";
  try {
    storage ||= globalThis.sessionStorage;
    for (const [key,value] of JSON.parse(storage?.getItem(draftStorage) || "[]")) {
      if (typeof key === "string" && typeof value?.value === "string") drafts.set(key,value);
    }
  } catch {}
  function remember() {
    try {
      if (drafts.size) storage?.setItem(draftStorage,JSON.stringify([...drafts]));
      else storage?.removeItem(draftStorage);
    } catch {}
  }
  const findTask = id => getState()?.tasks.find(task => task.id === id);
  const focus = (bookmark,select = false) => {
    const nodes = document.querySelectorAll('[data-focus="' + CSS.escape(bookmark) + '"]');
    const next = [...nodes].find(node => !node.disabled && node.getClientRects().length);
    next?.focus({preventScroll:true});
    if (select) next?.select?.();
    return next;
  };
  function redraw(parent,bookmark,select) {
    if (composing) { deferred = true; return; }
    const task = findTask(parent);
    if (!task) return;
    const active = document.activeElement, previous = active?.dataset.focus, caret = subtaskCaret(active);
    for (const list of document.querySelectorAll("details[data-checklist]")) {
      if (list.dataset.checklist !== parent) continue;
      const replacement = taskChecklist(task,list.dataset.checkView,list.open);
      if (replacement) list.replaceWith(replacement);
      else list.remove();
    }
    if (bookmark) focus(bookmark,select);
    else if (previous && !active.isConnected) {
      const restored = focus(previous);
      if (restored) restoreSubtaskCaret(restored,caret);
      else {
        const view = active.closest("details[data-checklist]")?.dataset.checkView;
        if (view) focus(view + "-subtasks-" + parent);
      }
    }
  }
  changes = createChecklistEdits({api,refresh,changed:redraw,storage,findTask});
  function showEditor(task) {
    const signature = JSON.stringify([task.id,task.title || task.text,task.subtasks,task.syncStatus === "deleting"]);
    if (editorSignature === signature) return;
    if (composing && editor.contains(document.activeElement)) { deferred = true; return; }
    editorSignature = signature;
    const active = document.activeElement;
    const bookmark = editor.contains(active) && active.dataset.focus;
    const caret = subtaskCaret(active);
    const checklist = taskChecklist(task,"editor",true);
    editor.replaceChildren(...(checklist ? [checklist] : []));
    editor.hidden = !checklist;
    if (bookmark) restoreSubtaskCaret(focus(bookmark),caret);
  }
  function context(target) {
    const list = target.closest?.("details[data-checklist]");
    if (!list) return null;
    const parent = list.dataset.checklist, id = target.closest("li[data-child]")?.dataset.child || "";
    const task = findTask(parent);
    if (!task || task.syncStatus === "deleting") return null;
    const view = list.dataset.checkView;
    return {list,parent,id,view,task,key:draftKey(parent,id),item:task.subtasks?.find(s => s.id === id),
      bookmark:id ? view + "-subtask-" + parent + "-" + id : view + "-subtasks-" + parent};
  }
  function captureInput(input,c) {
    if (!c) return;
    const value = input.value, draft = drafts.get(c.key);
    if (value || c.id) drafts.set(c.key,{...draft,value});
    else drafts.delete(c.key);
    remember();
    input.setCustomValidity("");
    for (const other of document.querySelectorAll("[data-step-field]")) {
      if (other !== input && other.dataset.stepField === input.dataset.stepField && context(other)?.key === c.key) {
        other.value = value; other.setCustomValidity("");
      }
    }
  }
  document.addEventListener("input",event => {
    if (event.target.dataset?.stepField) captureInput(event.target,context(event.target));
  });
  function apply(action,c) {
    if (!c) return;
    const {list,parent,id,key,item,bookmark} = c;
    const draft = drafts.get(key);
    if (action === "retry") return changes.retry(parent,id);
    if (action === "dismiss") return changes.dismiss(parent,id);
    if (action === "edit" && item) {
      drafts.set(key,{value:item.title,expectedTitle:item.title});
      remember();
      return redraw(parent,bookmark + "-input",true);
    }
    if (action === "cancel") {
      drafts.delete(key); remember();
      return redraw(parent,bookmark + "-edit");
    }
    if (action === "remove" || action === "keep") {
      if (!draft) return;
      draft.removing = action === "remove"; remember();
      return redraw(parent,bookmark + (draft.removing ? "-keep" : "-input"));
    }
    if (action === "confirm-remove" && draft?.removing) {
      drafts.delete(key); remember();
      changes.submit({parent,id,kind:"remove",expectedTitle:draft.expectedTitle});
      return focus(c.view + "-subtasks-" + parent + "-input");
    }
    if (action !== "add" && action !== "save") return;
    const adding = action === "add";
    const input = adding ? list.querySelector('[data-step-field="add"]') : list.querySelector('[data-child="' + CSS.escape(id) + '"] [data-step-field="rename"]');
    if (!input || (!adding && !draft)) return;
    if (!validSubtaskTitle(input.value)) {
      input.focus(); input.setCustomValidity("Enter a one-line subtask of 1–160 characters."); input.reportValidity(); return;
    }
    const title = input.value.trim();
    drafts.delete(key); remember();
    if (!adding && title === draft.expectedTitle) return redraw(parent,bookmark + "-edit");
    const request = changes.submit(adding ? {parent,id:crypto.randomUUID().replaceAll("-",""),kind:"add",title}
      : {parent,id,kind:"rename",title,expectedTitle:draft.expectedTitle});
    focus(c.view + "-subtasks-" + parent + "-input");
    return request;
  }
  async function saveEditorDrafts(parent) {
    const task = findTask(parent);
    if (!task) return false;
    const confirmation = editor.querySelector('[data-step-action="confirm-remove"]');
    if (confirmation) {
      confirmation.closest("details").open = true;
      confirmation.focus();
      return false;
    }
    const pending = [];
    for (const input of editor.querySelectorAll("[data-step-field]")) {
      const c = context(input);
      if (!c || (!c.id && !input.value.trim())) continue;
      if (!validSubtaskTitle(input.value)) {
        c.list.open = true;
        input.focus(); input.setCustomValidity("Enter a one-line subtask of 1–160 characters."); input.reportValidity();
        return false;
      }
      pending.push({id:c.id,action:c.id ? "save" : "add"});
    }
    const requests = [];
    for (const {id,action} of pending) {
      const selector = id ? '[data-child="' + CSS.escape(id) + '"] [data-step-field="rename"]' : '[data-step-field="add"]';
      const input = editor.querySelector(selector);
      if (input) requests.push(apply(action,context(input)));
    }
    await Promise.all(requests);
    const latest = findTask(parent);
    return Boolean(latest) && !changes.items(latest).some(row => row.change?.state === "failed");
  }
  document.addEventListener("click",event => {
    const button = event.target.closest?.("button[data-step-action]");
    if (button && !button.disabled) apply(button.dataset.stepAction,context(button));
  });
  document.addEventListener("change",event => {
    const box = event.target.closest?.("input[data-parent][data-subtask]");
    if (!box || box.disabled) return;
    const c = context(box);
    if (c?.item) changes.submit({parent:c.parent,id:c.id,kind:"toggle",done:box.checked,expectedDone:Boolean(c.item.done)});
  });
  document.addEventListener("keydown",event => {
    const target = event.target, field = target.dataset?.stepField;
    if (!field || event.isComposing || composing) return;
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation();
    const c = context(target);
    if (!c) return;
    if (event.key === "Enter") { if (!event.repeat) apply(field === "add" ? "add" : "save",c); }
    else if (field === "rename") apply("cancel",c);
    else { c.list.open = false; c.list.querySelector("summary").focus(); }
  });
  document.addEventListener("compositionstart",event => { if (event.target.dataset?.stepField) composing = true; });
  document.addEventListener("compositionend",event => {
    if (!event.target.dataset?.stepField) return;
    composing = false;
    captureInput(event.target,context(event.target));
    if (deferred) { deferred = false; queueMicrotask(() => { repaint(); const id = editor.querySelector("details")?.dataset.checklist; if (id && findTask(id)) showEditor(findTask(id)); }); }
  });
  return {showEditor,saveEditorDrafts,deferRender() { if (composing) deferred = true; return composing; }};
}
