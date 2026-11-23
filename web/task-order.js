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
  handle.setAttribute("aria-keyshortcuts","ArrowUp ArrowDown Home");
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

// The agenda is chronological. Its first visible row may be a meeting, and
// the first task that fits in a short gap may have a lower saved priority.
// The absolute request lets the scheduler choose its earliest legal opening.
export function orderDropTarget(rows,sourceId,day,y,hitId) {
  if (!rows.length || !Number.isFinite(y) || !rows.some(row => row.id === sourceId)) return null;
  const first = {id:rows[0].id,placement:"before",request:{placement:"first",day}};
  if (y < rows[0].top) return first;
  const hit = rows.find(row => row.id === hitId);
  if (hit?.id === sourceId) return null;
  if (hit && hit.id === rows[0].id && y < hit.top + (hit.bottom-hit.top)*.72) return first;
  const others = rows.filter(row => row.id !== sourceId);
  if (!others.length) return null;
  const target = hit || others.find(row => y < (row.top + row.bottom)/2) || others.at(-1);
  const placement = y < (target.top + target.bottom)/2 ? "before" : "after";
  if (target.id === rows[0].id && placement === "before") return first;
  return {id:target.id,placement,request:{targetId:target.id,placement,day}};
}

export function createTaskOrder({root,api,refresh,getState,notify,repaint}) {
  let open = null, drag = null, dragOrigin = null, surface = null, marked = null, pending = false, deferred = false;
  const topTarget = element("div","order-top-target","Move to top");
  topTarget.setAttribute("aria-hidden","true");
  const menu = element("div","order-menu");
  menu.id = "task-order-menu";
  menu.hidden = true;
  menu.setAttribute("role","menu");
  menu.setAttribute("aria-label","Task order");
  const choices = ["first",-1,1].map(step => {
    const text = step === "first" ? "Move to top" : step < 0 ? "Move earlier" : "Move later";
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
  function groupRows(source) {
    return rows().filter(row => sameGroup(describe(row),source) && eligible(describe(row)));
  }
  function stepRequest(source,direction) {
    if (!source) return null;
    if (direction === "first") return {placement:"first",day:source.day};
    const step = Number(direction), ids = groupRows(source).map(row => row.dataset.orderItem), index = ids.indexOf(source.id);
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
    for (const choice of choices) choice.disabled = !stepRequest(open,choice.dataset.step);
    if (focused?.disabled) choices.find(choice => !choice.disabled)?.focus({preventScroll:true});
  }
  function paint() {
    for (const row of rows()) {
      const handle = row.querySelector(handleSelector);
      handle.disabled = pending || !eligible(describe(row));
      row.draggable = handle.draggable = !handle.disabled;
      handle.title = pending ? "Updating task order" : "Drag to reorder. Use Home to move to the top, or the arrow keys to move one place.";
    }
    positionMenu();
  }
  function clearMark() {
    if (marked) delete marked.dataset.drop;
    delete topTarget.dataset.active;
    marked = null;
  }
  function endDrag() {
    if (!drag) return;
    locate(drag)?.classList.remove("is-dragging");
    topTarget.remove();
    surface = null;
    dragOrigin = null;
    drag = null;
    clearMark();
    if (deferred) { deferred = false; repaint(); }
  }
  async function move(source,request) {
    if (!request || pending || !eligible(source) || request.day !== source.day) return;
    if (request.placement !== "first" && !groupRows(source).some(row => row.dataset.orderItem === request.targetId && request.targetId !== source.id)) return;
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
      void move(open,stepRequest(open,event.target.closest("button").dataset.step));
    }
  });
  root.addEventListener("keydown",event => {
    const handle = event.target.closest(handleSelector);
    if (event.key === "Escape") {
      if (open) { event.preventDefault(); closeMenu(true); }
      if (drag) endDrag();
      return;
    }
    if (event.key === "Home" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (menu.contains(event.target)) { event.preventDefault(); choices[0].focus(); }
      else if (handle && !handle.disabled) {
        event.preventDefault();
        const source = describe(handle.closest(rowSelector));
        if (!event.repeat) void move(source,stepRequest(source,"first"));
      }
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
  root.addEventListener("pointerdown",event => {
    const row = event.target.closest(rowSelector);
    if (!row) { dragOrigin = null; return; }
    const control = event.target.closest("button,a,input,select,textarea,summary,[contenteditable=true]");
    const allowed = !control || control.matches(handleSelector) || control.dataset.action === "edit-task";
    dragOrigin = {row,allowed};
  },true);
  root.addEventListener("dragstart",event => {
    const row = event.target.closest(rowSelector);
    if (!row || !event.dataTransfer) return;
    const source = describe(row);
    if (pending || !eligible(source) || (dragOrigin?.row === row && !dragOrigin.allowed)) { event.preventDefault(); return; }
    surface = row.closest(".day-column, #day-section, #backlog");
    const list = row.closest(".day-body, #agenda, .tray-list");
    if (!surface || !list) { event.preventDefault(); return; }
    closeMenu();
    drag = source;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-dayline-task",drag.id);
    event.dataTransfer.setDragImage(row,Math.min(24,row.offsetWidth/2),Math.min(16,row.offsetHeight/2));
    row.classList.add("is-dragging");
    list.prepend(topTarget);
  });
  function dropAt(event) {
    if (!drag || !surface?.contains(event.target) || event.target.closest("#agenda-strip") || !eligible(drag)) return null;
    if (topTarget.contains(event.target)) return {row:topTarget,request:{placement:"first",day:drag.day}};
    const rows = groupRows(drag).filter(row => row.getClientRects().length);
    const positions = rows.map(row => {
      const slot = row.closest(".agenda-slot") || row;
      const {top,bottom} = slot.getBoundingClientRect();
      return {id:row.dataset.orderItem,top,bottom,owns:slot.contains(event.target)};
    });
    const target = orderDropTarget(positions,drag.id,drag.day,event.clientY,positions.find(p => p.owns)?.id);
    if (!target) return null;
    const row = target.request.placement === "first" ? topTarget : rows.find(r => r.dataset.orderItem === target.id);
    return {row,request:target.request};
  }
  root.addEventListener("dragover",event => {
    if (!drag) return;
    const target = dropAt(event);
    clearMark();
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    marked = target.row;
    if (marked === topTarget) topTarget.dataset.active = "true";
    else marked.dataset.drop = target.request.placement;
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
