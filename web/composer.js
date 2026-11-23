import { addDays, duration, formatDay, instantTime, zonedDay } from "./ui.js";
import { createCaptureOutbox, localRead, localWrite, recordsWithPrefix } from "./outbox.js";
import { createAffectedTaskLinks, createCommandPrompts } from "./commands.js";

const byId = id => document.getElementById(id);
const draftKey = "dayline.taskDraft";
const draftPrefix = "dayline.draft.";
const receiptKey = "dayline.lastCapture";
const resultKey = "dayline.lastCommandResult";
const clients = { local:"the local agent", codex:"Codex", gemini:"Google Gemini", claude:"Claude Code" };

function readJSON(raw) { try { return JSON.parse(raw); } catch { return null; } }
function validDraft(draft) {
  return typeof draft?.text === "string" && draft.text.trim() && draft.text.length <= 1000 &&
    /^[a-f0-9]{32}$/.test(draft.id) && (draft.day === null ||
      (/^\d{4}-\d{2}-\d{2}$/.test(draft.day) && Number.isFinite(Date.parse(draft.day + "T12:00Z"))));
}
function restoreDraft() {
  const session = localRead("sessionStorage",draftKey);
  if (session !== null) { const draft = readJSON(session); return validDraft(draft) ? draft : null; }
  const recent = recordsWithPrefix("localStorage",draftPrefix).filter(validDraft).sort((a,b) => b.updatedAt - a.updatedAt)[0];
  const prior = readJSON(localRead("localStorage",draftKey));
  return recent || (validDraft(prior) ? prior : null);
}
function shortTitle(text) {
  const clean = String(text || "").trim();
  return clean.length <= 60 ? clean : clean.slice(0,57).trimEnd() + "…";
}
export function createComposer({api,refresh,context,showLocation,openTask}) {
  const form = byId("quick-add"), input = byId("quick-text"), picker = byId("quick-day");
  let draft = restoreDraft();
  const mode = byId("entry-mode");
  mode.value = draft ? (draft.askPlanner ? "planner" : "auto") : (localRead("sessionStorage","dayline.entryMode") === "planner" ? "planner" : "auto");
  function showMode() {
    input.placeholder = mode.value === "planner" ? "Ask about your plan or describe a change" : "Add a task or change your plan";
    byId("add-label").textContent = mode.value === "planner" ? "Ask" : "Send";
  }
  showMode();
  let selected = draft?.day || null, implicit = Boolean(selected && draft?.implicit);
  let lastContext = "", choicesKey = "", issueKey = "", legacyChecked = false;
  let receipt = readJSON(localRead("sessionStorage",receiptKey) ?? localRead("localStorage",receiptKey));
  const focusInput = () => input.focus({preventScroll:true});
  const affectedLinks = createAffectedTaskLinks(byId("affected-tasks"),openAffected);
  const prompts = createCommandPrompts(byId("capture-commands"),{
    decide(item,decision) {
      if (outbox.decide(item.id,decision)) { remember(item); update(); focusInput(); }
    },
    edit(item) {
      if (input.value.trim() && draft?.revises !== item.id) { error("Finish your current entry before editing this request."); focusInput(); return; }
      selected = item.day || null; implicit = Boolean(item.implicit);
      mode.value = item.askPlanner || item.command?.contextual ? "planner" : "auto"; showMode();
      input.value = item.text;
      storeDraft({id:crypto.randomUUID().replaceAll("-",""),text:item.text,day:selected,implicit,askPlanner:mode.value === "planner",revises:item.id,updatedAt:Date.now()});
      error(); update(); focusInput();
    },
    dismiss(item) {
      outbox.remove(item.id);
      if (receipt?.id === item.id) {
        receipt = null;
        localWrite("sessionStorage",receiptKey,null);
        if (readJSON(localRead("localStorage",receiptKey))?.id === item.id) localWrite("localStorage",receiptKey,null);
      }
      update(); focusInput();
    },
    retry:id => outbox.retry(id),focusInput,
    canAskPlanner:() => Boolean(context().state?.selectedAgent && context().state.selectedAgent.provider !== "local")
  });
  input.value = draft?.text || "";
  const latestResult = readJSON(localRead("localStorage",resultKey));
  if (receipt && latestResult?.id === receipt.id) Object.assign(receipt,latestResult);
  const outbox = createCaptureOutbox({api,onChange:update,onRemoteChange:() => { void refresh(true); },onAccepted(item,result) {
    // Storage-denied browsers keep their original text until the local service acknowledges it.
    if (draft?.id === item.id) { storeDraft(null); input.value = ""; lastContext = ""; error(); }
    const ack = {id:item.id,ackAt:Date.now(),...(result.kind === "command" && result.status === "applied" && {command:result})};
    if (ack.command) localWrite("localStorage",resultKey,JSON.stringify(ack));
    if (receipt?.id === item.id) { Object.assign(receipt,ack); saveReceipt(); }
    void refresh(true);
  }});

  function storeDraft(next) {
    const previous = draft;
    draft = next;
    const value = next ? JSON.stringify(next) : "";
    localWrite("sessionStorage",draftKey,value);
    let durable = !next;
    if (next) {
      const individual = localWrite("localStorage",draftPrefix + next.id,value);
      const backup = localWrite("localStorage",draftKey,value);
      durable = individual || backup;
    } else if (readJSON(localRead("localStorage",draftKey))?.id === previous?.id) {
      localWrite("localStorage",draftKey,null);
    }
    if (durable && previous && previous.id !== next?.id) localWrite("localStorage",draftPrefix + previous.id,null);
  }
  function capture() {
    if (!input.value.trim()) { if (draft) storeDraft(null); return; }
    const askPlanner = mode.value === "planner";
    if (draft?.text === input.value && draft.day === selected && Boolean(draft.implicit) === implicit && Boolean(draft.askPlanner) === askPlanner) return;
    storeDraft({id:crypto.randomUUID().replaceAll("-",""),text:input.value,day:selected,implicit,askPlanner,
      ...(draft?.revises && {revises:draft.revises}),updatedAt:Date.now()});
  }
  function remember(item) {
    receipt = {id:item.id,text:item.text,provider:item.provider,model:item.model};
    saveReceipt(true);
  }
  function saveReceipt(newest = false) {
    const value = JSON.stringify(receipt);
    localWrite("sessionStorage",receiptKey,value);
    const shared = readJSON(localRead("localStorage",receiptKey));
    if (newest || !shared || shared.id === receipt.id) localWrite("localStorage",receiptKey,value);
  }
  function error(message = "") {
    byId("quick-error").textContent = message;
    byId("quick-error").hidden = !message;
  }
  function dayOptions(ctx) {
    const contextKey = [ctx.view,ctx.selectedDay,ctx.monday,ctx.compact].join("|");
    const viewed = ctx.view === "day" || ctx.compact ? ctx.selectedDay : null;
    if (contextKey !== lastContext) {
      if (!draft) { selected = viewed; implicit = Boolean(viewed); }
      lastContext = contextKey;
    }
    const preferred = implicit ? selected : viewed;
    const signature = [ctx.monday,selected,preferred].join("|");
    if (signature !== choicesKey) {
      choicesKey = signature;
      const days = Array.from({length:7},(_,n) => addDays(ctx.monday,n));
      if (selected && !days.includes(selected)) days.push(selected);
      const name = day => formatDay(day,{weekday:"short",month:"short",day:"numeric"});
      const preferredOption = preferred ? [new Option("Prefer " + name(preferred),"view:" + preferred)] : [];
      picker.replaceChildren(new Option("Auto-schedule",""),...preferredOption,...days.map(day => new Option("On " + name(day),day)));
    }
    picker.value = implicit && selected ? "view:" + selected : selected || "";
    picker.title = implicit ? "Preferred day for new tasks. A date in your wording takes priority." : "Choose a date for new tasks, or let Dayline find an opening.";
  }
  function sendIssues(waiting) {
    const issues = waiting.filter(item => item.problem && !item.command);
    const signature = JSON.stringify(issues.map(item => [item.id,item.problem,item.blocked]));
    if (signature === issueKey) return;
    issueKey = signature;
    const box = byId("capture-problems");
    box.hidden = !issues.length;
    box.replaceChildren(...issues.map(item => {
      const row = document.createElement("div");
      const line = document.createElement("span");
      line.textContent = "“" + shortTitle(item.text) + "” · " + item.problem;
      const retry = document.createElement("button");
      retry.type = "button"; retry.className = "summary-link"; retry.textContent = "Retry send";
      retry.addEventListener("click",() => outbox.retry(item.id));
      row.append(line,retry);
      if (item.blocked) {
        const edit = document.createElement("button");
        edit.type = "button"; edit.className = "summary-link"; edit.textContent = "Edit draft";
        edit.addEventListener("click",() => {
          if (input.value.trim()) { error("Finish the current draft before editing this saved task."); input.focus(); return; }
          input.value = item.text; selected = item.day || null; implicit = Boolean(item.implicit);
          mode.value = item.askPlanner ? "planner" : "auto"; showMode();
          capture(); outbox.remove(item.id); update(); input.focus();
        });
        row.append(edit);
      }
      return row;
    }));
  }
  function update() {
    const ctx = context();
    byId("add-button").disabled = !ctx.state;
    if (!ctx.state || !ctx.monday) return;
    const agent = ctx.state.selectedAgent;
    const link = byId("entry-agent");
    link.hidden = !agent;
    if (agent) {
      const name = agent.provider === "local" ? "Local on this Mac" : clients[agent.provider] || agent.provider;
      link.textContent = ["Task agent",name,agent.model].filter(Boolean).join(" · ");
      link.title = "Change task agent" + (agent.effort ? " · " + agent.effort + " reasoning effort" : "");
    }
    outbox.reconcile(ctx.state.tasks);
    if (!legacyChecked) {
      legacyChecked = true;
      // The previous client retained an already-submitted task in the text field.
      if (draft?.sent || (draft && (outbox.entries().some(item => item.id === draft.id) || ctx.state.tasks.some(task => task.id === draft.id)))) {
        const saved = ctx.state.tasks.some(task => task.id === draft.id);
        const item = {...draft,createdAt:draft.sentAt || Date.now()};
        const durable = saved || outbox.add(item);
        remember(item);
        if (durable) { storeDraft(null); input.value = ""; }
      }
    }
    dayOptions(ctx);
    const waiting = outbox.entries();
    sendIssues(waiting);
    prompts(waiting.filter(item => item.command));
    const task = receipt && ctx.state.tasks.find(item => item.id === receipt.id);
    const unsent = receipt && waiting.find(item => item.id === receipt.id);
    const command = unsent?.command || receipt?.command;
    const affected = command?.status === "applied" ? command.taskIds.map(id => ctx.state.tasks.find(item => item.id === id)).filter(Boolean) : [];
    affectedLinks(affected);
    let message = "";
    if (task) {
      const title = "“" + shortTitle(task.title || task.text) + "”";
      const agent = task.estimateAgent || task.agent || receipt;
      const client = [clients[agent.provider],agent.model].filter(Boolean).join(" · ");
      if (task.estimateState === "queued") message = "Queued " + title + (client ? " for " + client : "") + ".";
      else if (task.estimateState === "estimating") message = "Estimating " + title + (client ? " with " + client : "") + "…";
      else if (task.pendingEstimate) message = (client ? "Estimate unavailable for " + title + " with " + client : title + " needs an estimate") + ". Open it to retry.";
      else if (task.start) {
        const zone = ctx.state.settings.timeZone;
        const day = formatDay(zonedDay(task.start,zone),{weekday:"short",month:"short",day:"numeric"});
        const when = task.allDay ? day + " · All day" : day + " at " + instantTime(task.start,zone) + " · " + duration(task.minutes);
        message = title + " scheduled " + when + ".";
      } else if (task.syncStatus === "pending" && ctx.state.connection.connected) message = "Checking calendar availability for " + title + "…";
      else message = title + " is in Unscheduled." + (task.issue ? " " + task.issue : "");
    } else if (unsent?.command) {
      message = unsent.decision ? "Saving your choice…" : unsent.command.status === "answer" ? "" :
        unsent.command.status === "preview" ? "Review the proposed changes below." : "Your planner request needs a response below.";
    } else if (command?.status === "applied") {
      message = command.message;
    } else if (unsent) {
      message = (unsent.problem ? "Waiting to save " : "Saving ") + "“" + shortTitle(unsent.text) + "” on this Mac.";
    } else if (receipt?.ackAt && Date.now() - receipt.ackAt < 10000) message = "Saved “" + shortTitle(receipt.text) + "” on this Mac.";
    const other = waiting.filter(item => item.id !== unsent?.id && (!item.command || item.decision)).length;
    if (other) message += (message ? " " : "") + other + (other === 1 ? " entry waiting to send." : " entries waiting to send.");
    const status = byId("entry-status");
    byId("entry-feedback").hidden = !message;
    if (status.textContent !== message) status.textContent = message;
    const action = byId("view-added");
    const target = task || (affected.length === 1 && affected[0]);
    action.hidden = !target;
    action.dataset.id = target?.id || "";
    if (target) action.setAttribute("aria-label","View task — " + (target.title || target.text));
  }
  function choose(day,focus = true,fromView = false) {
    selected = day || null; implicit = Boolean(selected && fromView);
    capture();
    if (context().state) dayOptions(context());
    if (focus) input.focus();
  }
  input.addEventListener("input",() => { capture(); error(); });
  mode.addEventListener("change",() => {
    localWrite("sessionStorage","dayline.entryMode",mode.value);
    showMode(); capture(); focusInput();
  });
  picker.addEventListener("change",() => {
    const fromView = picker.value.startsWith("view:");
    choose(fromView ? picker.value.slice(5) : picker.value,false,fromView);
  });
  function openAffected(id) {
    const task = context().state?.tasks.find(item => item.id === id);
    if (task) { showLocation(task); openTask(task); }
  }
  byId("view-added").addEventListener("click",() => openAffected(byId("view-added").dataset.id));
  window.addEventListener("storage",event => {
    if (event.key !== resultKey || !receipt) return;
    const ack = readJSON(event.newValue);
    if (ack?.id === receipt.id) { Object.assign(receipt,ack); saveReceipt(); void refresh(true); }
  });
  form.addEventListener("submit",event => {
    event.preventDefault();
    const ctx = context();
    if (!ctx.state || !input.value.trim()) return;
    capture();
    const agent = ctx.state.selectedAgent || {};
    const item = {id:draft.id,text:draft.text.trim(),day:draft.day,implicit:Boolean(draft.implicit),createdAt:Date.now(),
      captureTimeZone:ctx.state.settings.timeZone,contextDay:ctx.selectedDay,provider:agent.provider,model:agent.model,effort:agent.effort,
      ...(draft.askPlanner && {askPlanner:true}),...(draft.revises && {revises:draft.revises})};
    const saved = outbox.add(item);
    remember(item);
    if (saved) { storeDraft(null); input.value = ""; lastContext = ""; }
    error(saved ? "" : "Browser storage is unavailable. Your text stays here until Dayline confirms receipt.");
    update(); input.focus({preventScroll:true});
  });
  byId("add-button").disabled = true;
  return {update,choose};
}
