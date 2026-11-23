import {element} from "./ui.js";

function action(label,className,perform) {
  const control = element("button",className,label);
  control.type = "button";
  control.addEventListener("click",perform);
  return control;
}

export function createCommandPrompts(container,{decide,edit,dismiss,retry,focusInput}) {
  let signature = "";
  return items => {
    const next = JSON.stringify(items.map(({id,text,command,decision,problem,blocked}) => [id,text,command,decision,problem,blocked]));
    if (next === signature) return;
    signature = next;
    const focused = container.contains(document.activeElement) && document.activeElement.dataset.commandFocus;
    container.hidden = !items.length;
    const cards = items.map(item => {
      const card = element("fieldset","capture-command");
      card.append(element("legend","command-wording",item.text),element("p","command-message",item.command.message));
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
      if (["unmatched","clarify"].includes(item.command.status)) {
        const matchAgain = control("Try matching again","match",() => decide(item,{retryMatch:true}));
        matchAgain.disabled = sending;
        options.append(matchAgain);
      }
      const add = control("Add as new task","new",() => decide(item,{forceCreate:true}));
      const revise = control("Edit request","edit",() => edit(item));
      const close = control("Dismiss","dismiss",() => dismiss(item));
      for (const button of [add,revise,close]) button.disabled = sending;
      options.append(add,revise,close);
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
