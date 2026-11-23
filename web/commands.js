import {element} from "./ui.js";

function action(label,className,perform) {
  const control = element("button",className,label);
  control.type = "button";
  control.addEventListener("click",perform);
  return control;
}

export function createCommandPrompts(container,{decide,edit,dismiss,retry,focusInput,canAskPlanner = () => false}) {
  let signature = "";
  return items => {
    const next = JSON.stringify([canAskPlanner(),items.map(({id,text,command,decision,problem,blocked}) => [id,text,command,decision,problem,blocked])]);
    if (next === signature) return;
    signature = next;
    const focused = container.contains(document.activeElement) && document.activeElement.dataset.commandFocus;
    container.hidden = !items.length;
    const cards = items.map(item => {
      const card = element("fieldset","capture-command");
      const preview = item.command.status === "preview", answer = item.command.status === "answer";
      card.append(element("legend","command-wording",item.text),element("p",answer ? "command-message planner-answer" : "command-message",item.command.message));
      if (preview) {
        const steps = element("ol","command-steps");
        for (const step of item.command.steps) steps.append(element("li","",step));
        card.append(steps);
      }
      const sending = Boolean(item.decision && !item.blocked);
      const controls = element("div","command-choices");
      function control(label,key,perform,className = "summary-link") {
        const button = action(label,className,perform);
        button.dataset.commandFocus = item.id + "-" + key;
        return button;
      }
      for (const choice of item.command.choices) {
        const button = control(choice.title,choice.id,() => decide(item,{chosenTaskId:choice.id}),"command-choice");
        if (choice.detail) button.append(element("small","command-detail",choice.detail));
        button.disabled = sending;
        controls.append(button);
      }
      if (controls.childElementCount) card.append(controls);
      const options = element("div","command-options");
      if (preview) {
        const count = item.command.steps.length;
        const apply = control(count === 1 ? "Apply change" : "Apply " + count + " changes","apply",() => decide(item,{applyPlanId:item.command.planId}),"primary apply-plan");
        apply.disabled = sending; options.append(apply);
      }
      if (!item.command.contextual && ["unmatched","clarify"].includes(item.command.status)) {
        const matchAgain = control("Try matching again","match",() => decide(item,{retryMatch:true}));
        matchAgain.disabled = sending;
        options.append(matchAgain);
        if (canAskPlanner()) {
          const ask = control("Ask planner","ask",() => decide(item,{askPlanner:true}));
          ask.disabled = sending; options.append(ask);
        }
      }
      const add = control("Add as new task","new",() => decide(item,{forceCreate:true}));
      const revise = control("Edit request","edit",() => edit(item));
      const close = control("Dismiss","dismiss",() => dismiss(item));
      for (const button of [add,revise,close]) button.disabled = sending;
      if (!preview && !answer) options.append(add);
      options.append(revise,close);
      if ((preview || answer) && item.command.agent?.model) {
        const agent = item.command.agent;
        const model = element("small","command-model",agent.model);
        const counts = [];
        if (Number.isSafeInteger(agent.inputTokens)) counts.push(agent.inputTokens.toLocaleString() + " input tokens");
        if (Number.isSafeInteger(agent.outputTokens)) counts.push(agent.outputTokens.toLocaleString() + " output tokens");
        model.title = ["Model used for this request",...counts].join(" · ");
        options.append(model);
      }
      if (item.problem) {
        card.append(element("p","field-error",item.problem));
        options.append(control("Retry","retry",() => retry(item.id)));
      } else if (sending) {
        const status = element("p","hint","Applying your choice…");
        status.setAttribute("role","status");
        card.append(status);
      }
      card.append(options);
      return card;
    });
    container.replaceChildren(...cards);
    if (focused) {
      const nextFocus = [...container.querySelectorAll("button")].find(button => !button.disabled && button.dataset.commandFocus === focused);
      if (nextFocus) nextFocus.focus({preventScroll:true}); else focusInput();
    }
  };
}

export function createAffectedTaskLinks(container,open) {
  let signature = "";
  return tasks => {
    const next = JSON.stringify(tasks.map(task => [task.id,task.title || task.text]));
    if (signature === next) return;
    signature = next;
    container.hidden = tasks.length < 2;
    const items = tasks.map(task => {
      const row = element("li");
      row.append(action(task.title || task.text,"summary-link",() => open(task.id)));
      return row;
    });
    const list = element("ul");
    list.append(...items);
    container.replaceChildren(element("summary","","View " + tasks.length + " affected tasks"),list);
  };
}
