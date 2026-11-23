import {button,element,formatDay,instantTime,zonedDay} from "./ui.js";

const rowSelector = "[data-order-item]";
const handleSelector = '[data-action="task-order"]';

export function addOrderHandle(row,task,day,view) {
  if (!task.canReorder || !day) return;
  row.dataset.orderItem = task.id;
  row.dataset.orderDay = day;
  row.dataset.orderView = view;
  const label = "Reorder " + (task.title || task.text);
  const handle = button("task-grip","task-order",label);
  handle.dataset.focus = view + "-order-" + task.id;
  handle.setAttribute("aria-haspopup","menu");
  handle.setAttribute("aria-expanded","false");
  handle.setAttribute("aria-controls","task-order-menu");
  handle.setAttribute("aria-keyshortcuts","ArrowUp ArrowDown");
  const dots = element("span","grip-dots");
  dots.setAttribute("aria-hidden","true");
  handle.append(dots);
  row.append(handle);
}

export function orderRequest(ids,id,targetId,placement,day) {
  const from = ids.indexOf(id), to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to || !["before","after"].includes(placement)) return null;
  if ((placement === "before" && from + 1 === to) || (placement === "after" && from - 1 === to)) return null;
  return {targetId,placement,day};
}

export function createTaskOrder({root,api,refresh,getState,notify,repaint}) {
  let open = null, drag = null, marked = null, pending = false, deferred = false;
  const menu = element("div","order-menu");
  menu.id = "task-order-menu";
  menu.hidden = true;
  menu.setAttribute("role","menu");
  menu.setAttribute("aria-label","Task order");
  const choices = [-1,1].map(step => {
    const text = step < 0 ? "Move earlier" : "Move later";
    const choice = button("order-choice","order-step",text,text);
    choice.dataset.step = String(step);
    choice.setAttribute("role","menuitem");
    return choice;
  });
  menu.append(...choices);
  root.append(menu);

  const rows = () => [...root.querySelectorAll(rowSelector)];
  const describe = row => row && {id:row.dataset.orderItem,day:row.dataset.orderDay,view:row.dataset.orderView};
  const sameGroup = (a,b) => a && b && a.day === b.day && a.view === b.view;
  const locate = source => source && rows().find(row => row.dataset.orderItem === source.id && sameGroup(source,describe(row)));
  function eligible(source) {
    const state = getState();
    const task = source && state?.tasks.find(t => t.id === source.id);
    return task?.canReorder && (task.start ? zonedDay(task.start,state.settings.timeZone) : "unscheduled") === source.day;
  }
  function group(source) {
    return rows().map(describe).filter(item => sameGroup(item,source) && eligible(item)).map(item => item.id);
  }
  function stepRequest(source,step) {
    if (!source) return null;
    const ids = group(source), index = ids.indexOf(source.id);
    return orderRequest(ids,source.id,ids[index+step],step < 0 ? "before" : "after",source.day);
  }
  function focusHandle(source) {
    const row = locate(source) || rows().find(item => item.dataset.orderItem === source?.id);
    const handle = row?.querySelector(handleSelector);
    if (handle && !handle.disabled && handle.getClientRects().length) return handle.focus({preventScroll:true});
    const alternatives = [...root.querySelectorAll('[data-action="edit-task"]')];
    alternatives.find(button => button.dataset.id === source?.id && button.getClientRects().length)?.focus({preventScroll:true});
  }
  function closeMenu(restore = false) {
    if (!open) return;
    locate(open)?.querySelector(handleSelector)?.setAttribute("aria-expanded","false");
    const previous = open;
    open = null;
    menu.hidden = true;
    if (restore) focusHandle(previous);
  }
  function positionMenu() {
    if (!open) return;
    const focused = menu.contains(document.activeElement) ? document.activeElement : null;
    const handle = locate(open)?.querySelector(handleSelector);
    if (!handle || !eligible(open) || handle.disabled || !handle.getClientRects().length) return closeMenu();
    const rect = handle.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const above = rect.bottom + box.height + 8 > window.innerHeight;
    menu.style.top = Math.max(4,above ? rect.top - box.height - 4 : rect.bottom + 4) + "px";
    menu.style.left = Math.max(4,Math.min(rect.left,window.innerWidth-box.width-4)) + "px";
    handle.setAttribute("aria-expanded","true");
    for (const choice of choices) choice.disabled = !stepRequest(open,Number(choice.dataset.step));
    if (focused?.disabled) choices.find(choice => !choice.disabled)?.focus({preventScroll:true});
  }
  function paint() {
    const all = rows(), totals = new Map();
    for (const row of all) {
      const source = describe(row), key = source.view + ":" + source.day;
      if (eligible(source)) totals.set(key,(totals.get(key) || 0) + 1);
    }
    for (const row of all) {
      const handle = row.querySelector(handleSelector);
      const key = row.dataset.orderView + ":" + row.dataset.orderDay;
      handle.disabled = pending || !eligible(describe(row)) || (totals.get(key) || 0) < 2;
      handle.draggable = !handle.disabled;
      handle.title = pending ? "Updating task order" : handle.disabled ? "No other movable task in this list" : "Drag to reorder, or use the up and down arrow keys";
    }
    positionMenu();
  }
  function clearMark() {
    if (marked) delete marked.dataset.drop;
    marked = null;
  }
  function endDrag() {
    if (!drag) return;
    locate(drag)?.classList.remove("is-dragging");
    drag = null;
    clearMark();
    if (deferred) { deferred = false; repaint(); }
  }
  async function move(source,request) {
    if (!request || pending || !eligible(source) || !orderRequest(group(source),source.id,request.targetId,request.placement,source.day)) return;
    const canRestore = !document.activeElement || document.activeElement === document.body || root.contains(document.activeElement);
    pending = true;
    closeMenu();
    endDrag();
    paint();
    try {
      await api("/api/tasks/" + encodeURIComponent(source.id) + "/order","POST",request);
      await refresh(true);
      const state = getState(), task = state?.tasks.find(t => t.id === source.id);
      let message = "Task order saved.";
      if (task?.start) {
        const zone = state.settings.timeZone;
        message += " " + (task.title || task.text) + " is scheduled for " + formatDay(zonedDay(task.start,zone),{month:"short",day:"numeric"}) + " at " + instantTime(task.start,zone) + ".";
      }
      notify(message);
    } catch (error) {
      notify(error.message);
      await refresh(true);
    } finally {
      pending = false;
      paint();
      if (canRestore && (document.activeElement === document.body || document.activeElement?.matches(handleSelector) || menu.contains(document.activeElement))) focusHandle(source);
    }
  }
  root.addEventListener("click",event => {
    const handle = event.target.closest(handleSelector);
    if (handle && !handle.disabled) {
      const source = describe(handle.closest(rowSelector));
      if (open?.id === source.id && sameGroup(open,source)) return closeMenu(true);
      closeMenu();
      open = source;
      menu.hidden = false;
      positionMenu();
      choices.find(choice => !choice.disabled)?.focus({preventScroll:true});
    } else if (event.target.closest('[data-action="order-step"]') && open) {
      void move(open,stepRequest(open,Number(event.target.closest("button").dataset.step)));
    }
  });
  root.addEventListener("keydown",event => {
    const handle = event.target.closest(handleSelector);
    if (event.key === "Escape") {
      if (open) { event.preventDefault(); closeMenu(true); }
      if (drag) endDrag();
      return;
    }
    const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!step || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (menu.contains(event.target)) {
      event.preventDefault();
      const enabled = choices.filter(choice => !choice.disabled);
      enabled[(enabled.indexOf(event.target)+step+enabled.length)%enabled.length]?.focus();
    } else if (handle && !handle.disabled) {
      event.preventDefault();
      const source = describe(handle.closest(rowSelector));
      if (!event.repeat) void move(source,stepRequest(source,step));
    }
  });
  function dismissOutside(event) {
    if (open && !menu.contains(event.target) && !event.target.closest?.(handleSelector)) closeMenu();
  }
  document.addEventListener("pointerdown",dismissOutside);
  document.addEventListener("focusin",dismissOutside);
  window.addEventListener("resize",positionMenu);
  window.addEventListener("scroll",positionMenu,true);
  root.addEventListener("dragstart",event => {
    const handle = event.target.closest(handleSelector);
    if (!handle || handle.disabled || !event.dataTransfer) return;
    const row = handle.closest(rowSelector);
    closeMenu();
    drag = describe(row);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-dayline-task",drag.id);
    event.dataTransfer.setDragImage(row,Math.min(24,row.offsetWidth/2),Math.min(16,row.offsetHeight/2));
    row.classList.add("is-dragging");
  });
  function dropAt(event) {
    const row = event.target.closest(rowSelector), target = describe(row);
    if (!drag || !sameGroup(drag,target) || !eligible(drag) || !eligible(target)) return null;
    const bounds = row.getBoundingClientRect();
    const placement = event.clientY < bounds.top + bounds.height/2 ? "before" : "after";
    const request = orderRequest(group(drag),drag.id,target.id,placement,drag.day);
    return request && {row,request};
  }
  root.addEventListener("dragover",event => {
    if (!drag) return;
    const target = dropAt(event);
    clearMark();
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    marked = target.row;
    marked.dataset.drop = target.request.placement;
  });
  root.addEventListener("dragleave",event => { if (marked && !marked.contains(event.relatedTarget)) clearMark(); });
  root.addEventListener("drop",event => {
    if (!drag) return;
    event.preventDefault();
    const target = dropAt(event), source = drag;
    if (target) void move(source,target.request);
    endDrag();
  });
  root.addEventListener("dragend",endDrag);
  window.addEventListener("blur",() => { closeMenu(); endDrag(); });
  return {paint,deferRender() { if (drag) deferred = true; return Boolean(drag); }};
}
