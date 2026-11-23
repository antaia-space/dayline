// Settings → Booking: the public booking page, where booked meetings go, and
// the meeting types a guest can pick.
import { element } from "./ui.js";

const slugOf = text => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40);
const plural = (count,word) => count + " " + word + (count === 1 ? "" : "s");
const reasons = {taken:"the time was taken first",expired:"it could not be confirmed in time",unavailable:"the request no longer matched your settings"};

function field(label,control,hint) {
  const wrap = element("label","",label);
  wrap.append(control);
  if (hint) wrap.append(element("span","booking-field-hint",hint));
  return wrap;
}

function input(type,value,attributes = {}) {
  const control = element(type === "textarea" ? "textarea" : "input");
  if (type !== "textarea") control.type = type;
  control.value = value ?? "";
  for (const [key,setting] of Object.entries(attributes)) control.setAttribute(key,setting);
  return control;
}

function check(label,checked,hint) {
  const wrap = element("label","booking-check");
  const box = input("checkbox");
  box.checked = checked;
  const text = element("span","",label);
  if (hint) text.append(element("span","booking-field-hint",hint));
  wrap.append(box,text);
  return {wrap,box};
}

export function createBookingSettings({api,toast,errorAt,connect}) {
  const root = document.getElementById("booking-settings");
  let view = null;
  let draft = null;
  let editing = -1;
  let saving = false;
  let sequence = 0;

  const linkFor = slug => view?.status.url ? view.status.url + (slug ? "/" + slug : "") : "";

  async function copy(text,control) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      // The Mac app grants no clipboard permission; copying a selection needs none.
      const holder = input("text",text,{readonly:""});
      holder.className = "booking-copy-holder";
      root.append(holder);
      holder.select();
      document.execCommand("copy");
      holder.remove();
      control.focus();
    }
    toast("Link copied.");
  }

  function statusLine() {
    const {status} = view;
    if (status.state === "off") return "";
    if (status.state === "live") {
      const at = status.publishedAt ? " Free times published at " + new Date(status.publishedAt).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}) + "." : "";
      return "Your page is live." + at + (status.waiting ? " " + plural(status.waiting,"request") + " waiting." : "");
    }
    if (status.state === "starting") return status.message || "Publishing your free times…";
    return status.message || "The booking page is not reachable at the moment.";
  }

  function readType(form,type) {
    const number = name => Number(form.querySelector('[name="' + name + '"]').value);
    type.title = form.querySelector('[name="title"]').value.trim();
    type.slug = form.querySelector('[name="slug"]').value.trim();
    type.description = form.querySelector('[name="description"]').value.trim();
    type.durationMin = number("durationMin");
    type.slotStepMin = number("slotStepMin");
    type.bufferMin = number("bufferMin");
    type.minNoticeMin = Math.round(number("noticeHours") * 60);
    type.maxDaysAhead = number("maxDaysAhead");
    type.hidden = form.querySelector('[name="hidden"]').checked;
    type.notesToWiki = form.querySelector('[name="notesToWiki"]').checked;
  }

  function typeEditor(type,index) {
    const form = element("div","booking-type-editor");
    const title = input("text",type.title,{name:"title",maxlength:"80",required:""});
    const slug = input("text",type.slug,{name:"slug",maxlength:"40",pattern:"[a-z0-9][a-z0-9\\-]*",spellcheck:"false",autocapitalize:"none"});
    let slugTouched = Boolean(type.slug);
    title.addEventListener("input",() => { if (!slugTouched) slug.value = slugOf(title.value); });
    slug.addEventListener("input",() => { slugTouched = true; });
    const pair = (...fields) => { const row = element("div","field-pair"); row.append(...fields); return row; };
    const number = (name,value,min,max,step = "1") => input("number",value,{name,min:String(min),max:String(max),step,inputmode:"decimal",required:""});
    const hidden = check("Hidden",type.hidden," Left off your page. Only people with its link can book it.");
    hidden.box.name = "hidden";
    const wiki = check("Notes may be copied to the company wiki",type.notesToWiki," Off keeps notes of these meetings out of the wiki.");
    wiki.box.name = "notesToWiki";
    const done = element("button","secondary","Done");
    done.type = "button";
    done.addEventListener("click",() => { readType(form,type); editing = -1; render(); });
    const remove = element("button","text-button","Remove type");
    remove.type = "button";
    remove.disabled = draft.types.length < 2;
    remove.addEventListener("click",() => { draft.types.splice(index,1); editing = -1; render(); });
    const actions = element("div","booking-row-actions");
    actions.append(remove,done);
    form.append(
      pair(field("Title",title),field("Link name",slug)),
      field("Description",input("text",type.description,{name:"description",maxlength:"300"})),
      pair(field("Length (min)",number("durationMin",type.durationMin,5,480,"5")),field("Offer a start every (min)",number("slotStepMin",type.slotStepMin,5,240,"5"))),
      pair(field("Gap between meetings (min)",number("bufferMin",type.bufferMin,0,240,"5")),field("Minimum notice (hours)",number("noticeHours",type.minNoticeMin / 60,0,720,"0.5"))),
      field("Bookable up to (days ahead)",number("maxDaysAhead",type.maxDaysAhead,1,90)),
      hidden.wrap,wiki.wrap,actions);
    return form;
  }

  function typeRow(type,index) {
    const row = element("li","booking-type");
    if (editing === index) { row.append(typeEditor(type,index)); return row; }
    const text = element("div","booking-type-text");
    text.append(element("strong","",type.title || "Untitled"),
      element("span","booking-type-facts",[type.durationMin + " min",type.hidden && "hidden",!type.notesToWiki && "notes stay private"].filter(Boolean).join(" · ")));
    const actions = element("div","booking-row-actions");
    const saved = view.types.some(known => known.slug === type.slug);
    if (view.enabled && saved && linkFor(type.slug)) {
      const copyLink = element("button","text-button","Copy link");
      copyLink.type = "button";
      copyLink.setAttribute("aria-label","Copy the link for " + type.title);
      copyLink.addEventListener("click",() => copy(linkFor(type.slug),copyLink));
      actions.append(copyLink);
    }
    const edit = element("button","text-button","Edit");
    edit.type = "button";
    edit.setAttribute("aria-label","Edit " + type.title);
    edit.addEventListener("click",() => { if (commitOpenType()) { editing = index; render(); } });
    actions.append(edit);
    row.append(text,actions);
    return row;
  }

  function commitOpenType() {
    const open = root.querySelector(".booking-type-editor");
    if (!open || editing < 0) return true;
    readType(open,draft.types[editing]);
    return true;
  }

  function collect() {
    commitOpenType();
    draft.enabled = root.querySelector("#booking-enabled").checked;
    draft.owner = {name:root.querySelector("#booking-name").value.trim(),headline:root.querySelector("#booking-headline").value.trim()};
    draft.calendarId = root.querySelector("#booking-calendar").value || null;
  }

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    collect();
    errorAt("settings-error");
    saving = true;
    editing = -1;
    render();
    try {
      const changes = {enabled:draft.enabled,owner:draft.owner,types:draft.types};
      if (draft.calendarId) changes.calendarId = draft.calendarId;
      accept(await api("/api/booking","PATCH",changes));
      toast(view.enabled ? "Booking links saved." : "Booking links are off.");
    } catch (error) { errorAt("settings-error",error.message); }
    finally { saving = false; render(); }
  }

  function accept(next) {
    view = next;
    draft = {enabled:next.enabled,owner:{...next.owner},calendarId:next.calendarId,types:structuredClone(next.types)};
  }

  function render() {
    if (!view) { root.replaceChildren(element("p","hint","Loading booking settings…")); return; }
    const form = element("form");
    form.noValidate = false;
    form.addEventListener("submit",save);

    const intro = element("p","hint","Guests pick a time on a public page. The meeting lands in your Google Calendar with a Google Meet link, and Google sends the invitation.");
    const enabled = check("Offer booking links",draft.enabled);
    enabled.box.id = "booking-enabled";
    form.append(intro,enabled.wrap);

    if (view.enabled) {
      const box = element("div","setup-box booking-status");
      if (view.status.url) {
        const link = input("text",view.status.url,{readonly:"","aria-label":"Your booking page"});
        link.addEventListener("focus",() => link.select());
        const copyLink = element("button","secondary","Copy link");
        copyLink.type = "button";
        copyLink.addEventListener("click",() => copy(view.status.url,copyLink));
        const visit = element("a","outside-link","Open");
        visit.href = view.status.url;
        visit.target = "_blank";
        visit.rel = "noopener noreferrer";
        visit.setAttribute("aria-label","Open your booking page");
        const row = element("div","booking-link");
        row.append(link,copyLink,visit);
        box.append(row);
      }
      const line = element("p","hint",statusLine());
      line.setAttribute("role","status");
      box.append(line);
      form.append(box);
    }

    const name = input("text",draft.owner.name,{id:"booking-name",maxlength:"100",autocomplete:"name"});
    const headline = input("text",draft.owner.headline,{id:"booking-headline",maxlength:"100"});
    const names = element("div","field-pair");
    names.append(field("Name guests see",name),field("Headline",headline));
    form.append(names);

    const calendar = element("select");
    calendar.id = "booking-calendar";
    if (!view.calendars.length) calendar.append(new Option("Connect a Google account under Calendars first",""));
    else if (!draft.calendarId) calendar.append(new Option("Choose a calendar",""));
    for (const choice of view.calendars) calendar.append(new Option(choice.name + " — " + choice.accountEmail,choice.id,false,choice.id === draft.calendarId));
    calendar.addEventListener("change",() => { collect(); render(); });
    form.append(field("Bookings go to",calendar));
    const chosen = view.calendars.find(choice => choice.id === draft.calendarId);
    if (chosen && !chosen.access) {
      const note = element("div","setup-box booking-access");
      note.append(element("p","hint","Dayline needs permission to add events to " + chosen.accountEmail + " before it can create booked meetings. Your tasks stay local."));
      const allow = element("button","secondary","Allow booked meetings");
      allow.type = "button";
      allow.disabled = draft.calendarId !== view.calendarId;
      allow.title = allow.disabled ? "Save the calendar choice first" : "";
      allow.addEventListener("click",() => connect(allow,{mode:"booking",accountSub:chosen.sub}));
      note.append(allow);
      form.append(note);
    }

    const types = element("fieldset","booking-types");
    types.append(element("legend","","Meeting types"));
    const list = element("ul","booking-type-list");
    draft.types.forEach((type,index) => list.append(typeRow(type,index)));
    const add = element("button","text-button","Add meeting type");
    add.type = "button";
    add.disabled = draft.types.length >= 20;
    add.addEventListener("click",() => {
      collect();
      draft.types.push({slug:"",title:"",description:"",durationMin:30,slotStepMin:30,bufferMin:15,minNoticeMin:720,maxDaysAhead:45,hidden:false,notesToWiki:true});
      editing = draft.types.length - 1;
      render();
      root.querySelector('.booking-type-editor [name="title"]')?.focus();
    });
    types.append(list,add);
    form.append(types);

    if (view.notices.length) {
      const notices = element("fieldset","booking-notices");
      notices.append(element("legend","","Requests that were not booked"));
      for (const notice of view.notices) {
        const row = element("div","booking-notice");
        const when = notice.start ? new Date(notice.start).toLocaleString([],{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) : "";
        const text = element("p","",notice.name + " (" + notice.email + ") asked for " + notice.type + (when ? " on " + when : "") + ". Not booked: " +
          (reasons[notice.reason] || reasons.unavailable) + ".");
        const dismiss = element("button","text-button","Dismiss");
        dismiss.type = "button";
        dismiss.addEventListener("click",async () => {
          dismiss.disabled = true;
          try { collect(); const kept = draft; accept(await api("/api/booking/notices","POST",{id:notice.id})); draft = kept; render(); }
          catch (error) { errorAt("settings-error",error.message); dismiss.disabled = false; }
        });
        row.append(text,dismiss);
        notices.append(row);
      }
      form.append(notices);
    }

    form.append(element("p","hint","The public page shows your name, these meeting types and the start times that are free. Meeting details, tasks and Google access stay on this Mac."));
    const actions = element("div","dialog-actions");
    const cancel = element("button","secondary close-dialog","Cancel");
    cancel.type = "button";
    cancel.addEventListener("click",() => root.closest("dialog").close());
    const submit = element("button","primary",saving ? "Saving…" : "Save booking");
    submit.type = "submit";
    submit.disabled = saving;
    actions.append(cancel,submit);
    form.append(actions);
    root.replaceChildren(form);
  }

  return {
    async open() {
      const current = ++sequence;
      if (!view) render();
      try {
        const next = await api("/api/booking");
        if (current !== sequence) return;
        accept(next);
        editing = -1;
        render();
      } catch (error) { errorAt("settings-error",error.message); }
    },
    // Coming back from Google's consent page: show the new access without discarding unsaved edits.
    async refresh() {
      if (!view || saving || !root.querySelector("#booking-enabled")) return;
      try {
        const next = await api("/api/booking");
        if (saving) return;
        collect();
        const kept = draft, open = editing;
        accept(next);
        draft = kept;
        editing = open;
        render();
      } catch { /* The next visit to this tab shows the error. */ }
    }
  };
}
