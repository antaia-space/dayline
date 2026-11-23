// The Bookings tab: one card per meeting type, each with its own link, and a
// side panel to edit one type. Below them, the meetings people booked.
import { element, icon } from "./ui.js";

const slugOf = text => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40);
const plural = (count,word) => count + " " + word + (count === 1 ? "" : "s");
const reasons = {taken:"the time was taken first",expired:"it could not be confirmed in time",unavailable:"the request no longer matched your settings"};
// Monday first, as in the planner. Keys match the booking rules on the Mac.
const DAYS = [["mon","Mon","M"],["tue","Tue","T"],["wed","Wed","W"],["thu","Thu","T"],["fri","Fri","F"],["sat","Sat","S"],["sun","Sun","S"]];
const lengthLabel = minutes => minutes % 60 ? minutes + " min" : minutes / 60 + (minutes === 60 ? " hr" : " hrs");

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

function action(className,label,symbol) {
  const control = element("button",className);
  control.type = "button";
  if (symbol) control.append(icon(symbol));
  control.append(element("span","",label));
  return control;
}

// "Mon–Fri" for a run of days, "Mon, Wed, Fri" otherwise.
export function daysLabel(keys) {
  const order = DAYS.map(([key]) => key), picked = order.filter(key => keys.includes(key));
  const runs = [];
  for (const key of picked) {
    const last = runs.at(-1);
    if (last && order.indexOf(key) === order.indexOf(last.at(-1)) + 1) last.push(key);
    else runs.push([key]);
  }
  const name = key => DAYS.find(([id]) => id === key)[1];
  return runs.map(run => run.length > 2 ? name(run[0]) + "–" + name(run.at(-1)) : run.map(name).join(", ")).join(", ");
}

// When a type can be booked, in one line for its card.
export function hoursLabel(hours,settings) {
  if (!hours) {
    if (!settings) return "Your working hours";
    const keys = settings.workDays.map(day => DAYS[day-1][0]);
    return daysLabel(keys) + ", " + settings.startTime + "–" + settings.endTime;
  }
  const keys = DAYS.map(([key]) => key).filter(key => hours[key]?.length);
  const ranges = new Set(keys.map(key => hours[key].map(({start,end}) => start + "–" + end).join(" and ")));
  return daysLabel(keys) + ", " + (ranges.size === 1 ? [...ranges][0] : "hours vary");
}

// A few of the next free times as plain text, to paste into an email:
// up to three days, up to three times on each.
export function timesText(slots,{timeZone,link,title,minutes}) {
  if (!slots.length) return "No free times are published for this meeting type at the moment.\n\nBook here: " + link;
  const day = new Intl.DateTimeFormat("en-GB",{weekday:"short",day:"numeric",month:"short",timeZone});
  const time = new Intl.DateTimeFormat("en-GB",{hour:"2-digit",minute:"2-digit",hourCycle:"h23",timeZone});
  const days = new Map();
  for (const start of slots) {
    const key = day.format(start);
    if (!days.has(key)) { if (days.size === 3) break; days.set(key,[]); }
    if (days.get(key).length < 3) days.get(key).push(time.format(start));
  }
  const lines = [...days].map(([name,times]) => name + ": " + times.join(", "));
  return "Here are some times that work for a " + lengthLabel(minutes) + " " + title + (timeZone ? " (" + timeZone.replaceAll("_"," ") + " time)" : "") + ":\n\n" +
    lines.join("\n") + "\n\nPick one of these or any other free time here:\n" + link;
}

export function createBookingSettings({api,toast,fail,connect,zone,settings,onChange}) {
  const root = document.getElementById("booking-settings");
  let view = null;
  let saving = false;
  let sequence = 0;
  let panel = null;
  let pageOpen = false;

  const linkFor = slug => view?.enabled && view.status.url ? view.status.url + (slug ? "/" + slug : "") : "";

  async function copy(text,control) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      // The Mac app grants no clipboard permission; copying a selection needs none.
      const holder = input("text",text,{readonly:""});
      holder.className = "booking-copy-holder";
      // An open dialog makes the rest of the page inert, so the selection must live inside it.
      (share?.open ? share : panel?.open ? panel : root).append(holder);
      holder.select();
      document.execCommand("copy");
      holder.remove();
      control.focus();
    }
    toast("Link copied.");
  }

  function statusLine() {
    const {status} = view;
    if (status.state === "live") {
      const at = status.publishedAt ? " Free times published at " + new Date(status.publishedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",hourCycle:"h23"}) + "." : "";
      return "Your page is live." + at + (status.waiting ? " " + plural(status.waiting,"request") + " waiting." : "");
    }
    if (status.state === "starting") return status.message || "Publishing your free times…";
    return status.message || "The booking page is not reachable at the moment.";
  }

  // Every change is saved at once and the tab redrawn from the planner's answer.
  async function send(changes,done) {
    if (saving) return false;
    saving = true;
    fail();
    try {
      view = await api("/api/booking","PATCH",changes);
      if (done) toast(done);
      onChange?.();
      return true;
    } catch (error) {
      (panel?.open ? panelError : fail)(error.message);
      return false;
    } finally {
      saving = false;
      render();
    }
  }

  function panelError(message = "") {
    const line = panel?.querySelector(".booking-panel-error");
    if (line) { line.textContent = message; line.hidden = !message; }
  }

  // ------------------------------------------------------------ the page
  function pageBox() {
    const box = element("section","setup-box booking-status");
    const toggle = element("label","toggle-label booking-toggle");
    const enabled = input("checkbox");
    enabled.checked = view.enabled;
    enabled.addEventListener("change",async () => {
      const wanted = enabled.checked;
      if (!await send({enabled:wanted},wanted ? "Booking links are on." : "Booking links are off.") && wanted) { pageOpen = true; render(); }
    });
    const knob = element("span","switch");
    knob.setAttribute("aria-hidden","true");
    toggle.append(enabled,knob,element("span","",view.enabled ? "Booking links are on" : "Offer booking links"));
    const top = element("div","booking-status-top");
    top.append(toggle);
    if (view.enabled && view.status.url) {
      const link = input("text",view.status.url,{readonly:"","aria-label":"Your booking page"});
      link.addEventListener("focus",() => link.select());
      const copyLink = action("secondary","Copy link","link");
      copyLink.addEventListener("click",() => copy(view.status.url,copyLink));
      const row = element("div","booking-link");
      row.append(link,copyLink,openLink(view.status.url,"Open your booking page"));
      top.append(row);
    }
    box.append(top);
    const line = element("p","hint",view.enabled ? statusLine()
      : "Guests pick a time on a public page. The meeting lands in your Google Calendar with a Google Meet link, and Google sends the invitation.");
    line.setAttribute("role","status");
    box.append(line);

    const details = element("details","booking-page-settings");
    details.open = pageOpen || !view.owner.name;
    details.addEventListener("toggle",() => { pageOpen = details.open; });
    const summary = element("summary","","Page settings");
    summary.append(element("span","booking-type-facts",[view.owner.name || "No name yet",view.owner.headline].filter(Boolean).join(" · ")));
    const form = element("form");
    const name = input("text",view.owner.name,{maxlength:"100",autocomplete:"name"});
    const headline = input("text",view.owner.headline,{maxlength:"100"});
    const names = element("div","field-pair");
    names.append(field("Name guests see",name),field("Headline",headline));
    const save = element("button","secondary","Save page settings");
    save.type = "submit";
    form.addEventListener("submit",event => {
      event.preventDefault();
      void send({owner:{name:name.value.trim(),headline:headline.value.trim()}},"Page settings saved.");
    });
    form.append(names);
    const actions = element("div","dialog-actions");
    actions.append(save);
    form.append(actions);
    details.append(summary,form);
    box.append(details);
    return box;
  }

  function openLink(href,label) {
    const visit = element("a","icon-button booking-open");
    visit.href = href;
    visit.target = "_blank";
    visit.rel = "noopener noreferrer";
    visit.dataset.tip = label;
    visit.setAttribute("aria-label",label);
    visit.append(icon("external"));
    return visit;
  }

  // --------------------------------------------------------- type cards
  function iconButton(symbol,label,onClick) {
    const control = element("button","icon-button booking-icon");
    control.type = "button";
    control.dataset.tip = label;
    control.setAttribute("aria-label",label);
    control.append(icon(symbol));
    if (onClick) control.addEventListener("click",onClick);
    return control;
  }

  // An icon that opens the public page of a type, or says why it cannot yet.
  function pageLink(href,symbol,label,why) {
    if (!href) {
      const idle = iconButton(symbol,label + ". " + why);
      idle.disabled = true;
      return idle;
    }
    const visit = openLink(href,label);
    visit.replaceChildren(icon(symbol));
    visit.classList.add("booking-icon");
    return visit;
  }

  const withType = (index,change) => view.types.map((known,i) => i === index ? change(known) : known);
  function freeSlug(base) {
    for (let n = 2;;n++) {
      const candidate = (base.slice(0,36) + "-" + n);
      if (!view.types.some(known => known.slug === candidate)) return candidate;
    }
  }

  // Edit, duplicate, switch off, delete: the less frequent actions of a card.
  function typeMenu(type,index) {
    const off = type.active === false;
    const menu = element("details","booking-menu");
    const opener = element("summary","icon-button booking-icon booking-more");
    opener.dataset.tip = "More";
    opener.setAttribute("aria-label","More for " + type.title);
    opener.append(icon("more"));
    const list = element("div","booking-menu-list");
    const item = (label,run) => {
      const entry = element("button","",label);
      entry.type = "button";
      entry.addEventListener("click",() => { menu.open = false; run(); });
      list.append(entry);
      return entry;
    };
    item("Edit",() => openPanel(index));
    item("Duplicate",() => openPanel(-1,type.accountSub,{...structuredClone(type),title:type.title + " (copy)",slug:freeSlug(type.slug),active:true}));
    item(off ? "Turn on" : "Turn off",() => void send({types:withType(index,known => ({...known,active:off}))},"“" + type.title + "” is " + (off ? "on." : "off. Its link no longer answers.")));
    const remove = item("Delete",async () => {
      if (!window.confirm("Delete “" + type.title + "”? Its link stops working. Meetings already booked stay in your calendar.")) return;
      await send({types:view.types.filter((_,i) => i !== index)},"Meeting type deleted.");
    });
    remove.disabled = view.types.length < 2;
    remove.className = "is-danger";
    menu.append(opener,list);
    return menu;
  }

  function typeCard(type,index) {
    const off = type.active === false;
    const card = element("li","booking-card" + (type.hidden ? " is-hidden" : "") + (off ? " is-off" : ""));
    const main = element("button","booking-card-main");
    main.type = "button";
    main.setAttribute("aria-label","Edit " + type.title);
    main.title = "Edit this meeting type";
    main.addEventListener("click",() => openPanel(index));
    main.append(element("strong","",type.title),
      element("span","booking-type-facts",[off && "Off",lengthLabel(type.durationMin),"Google Meet","One-on-one",type.hidden && "Hidden",!type.notesToWiki && "Notes stay private"].filter(Boolean).join(" · ")),
      element("span","booking-type-facts",hoursLabel(type.hours,settings?.())));
    const actions = element("div","booking-row-actions");
    const href = off ? "" : linkFor(type.slug);
    const why = off ? "This meeting type is switched off" : view.enabled ? "The link appears once your page is published" : "Switch on booking links first";
    // Booking for someone else is the public page, filled in on their behalf.
    const book = pageLink(href,"calendarPlus","Book a meeting for someone",why);
    const share = iconButton("share",href ? "Share " + type.title : "Share. " + why,() => openShare(type,href));
    share.disabled = !href;
    const copyLink = action("secondary","Copy link","link");
    copyLink.setAttribute("aria-label","Copy the link for " + type.title);
    copyLink.disabled = !href;
    if (!href) copyLink.dataset.tip = why;
    copyLink.addEventListener("click",() => copy(href,copyLink));
    actions.append(book,share,copyLink,pageLink(href,"external","Preview the booking page for " + type.title,why),typeMenu(type,index));
    card.append(main,actions);
    return card;
  }

  // ----------------------------------------------------------- sharing
  let share = null;
  async function openShare(type,href) {
    share?.remove();
    const box = share = element("dialog","panel small booking-share");
    box.setAttribute("aria-label","Share " + type.title);
    box.addEventListener("click",event => { if (event.target === box) box.close(); });
    box.addEventListener("close",() => { box.remove(); if (share === box) share = null; });
    const head = element("div","dialog-heading");
    const heading = element("div");
    heading.append(element("p","eyebrow","Share"),element("h2","",type.title));
    const close = iconButton("x","Close",() => box.close());
    head.append(heading,close);
    const body = element("div","form-body");
    const link = input("text",href,{readonly:"","aria-label":"Link"});
    link.addEventListener("focus",() => link.select());
    const copyLink = action("secondary","Copy link","link");
    copyLink.addEventListener("click",() => copy(href,copyLink));
    const row = element("div","booking-link");
    row.append(link,copyLink);
    const text = input("textarea","Loading your free times…",{rows:"7","aria-label":"Times for an email"});
    const copyTimes = action("secondary","Copy times","link");
    copyTimes.disabled = true;
    copyTimes.addEventListener("click",() => copy(text.value,copyTimes));
    const timesActions = element("div","dialog-actions");
    timesActions.append(copyTimes);
    body.append(field("Link",row),field("Times for an email",text,"A few of your next free times, to paste into a message. Edit them before copying if you like."),timesActions);
    box.append(head,body);
    root.parentElement.append(box);
    box.showModal();
    try {
      const {slots} = await api("/api/booking/times/" + type.slug);
      text.value = timesText(slots,{timeZone:zone?.(),link:href,title:type.title,minutes:type.durationMin});
      copyTimes.disabled = !slots.length;
    } catch (error) { text.value = error.message; }
  }

  // ------------------------------------------------------ the side panel
  function closePanel() {
    if (panel?.open) panel.close();
  }

  // `sub` is the address whose section a new type is created in; `template` is a type being duplicated.
  function openPanel(index,sub,template) {
    const isNew = index < 0;
    const type = isNew ? {slug:"",title:"",description:"",durationMin:30,slotStepMin:30,bufferMin:15,minNoticeMin:720,maxDaysAhead:45,hidden:false,notesToWiki:true,hours:null,
      active:true,...template,accountSub:sub ?? view.addresses[0]?.sub ?? null} : structuredClone(view.types[index]);
    panel?.remove();
    panel = element("dialog","booking-panel");
    panel.setAttribute("aria-label",isNew ? "New meeting type" : "Meeting type " + type.title);
    panel.addEventListener("click",event => { if (event.target === panel) closePanel(); });
    panel.addEventListener("close",() => { panel?.remove(); panel = null; });

    const head = element("header","booking-panel-head");
    const heading = element("div");
    heading.append(element("p","eyebrow","Meeting type"),element("h2","",isNew ? "New meeting type" : type.title));
    const close = element("button","icon-button");
    close.type = "button";
    close.setAttribute("aria-label","Close");
    close.append(icon("x"));
    close.addEventListener("click",closePanel);
    head.append(heading,close);

    const form = element("form","form-body booking-panel-body");
    const section = (title,...children) => { const part = element("section","booking-panel-section"); part.append(element("h3","",title),...children); return part; };
    const pair = (...fields) => { const row = element("div","field-pair"); row.append(...fields); return row; };
    const number = (value,min,max,step = "1") => input("number",value,{min:String(min),max:String(max),step,inputmode:"decimal",required:""});

    const title = input("text",type.title,{maxlength:"80",required:""});
    const slug = input("text",type.slug,{maxlength:"40",pattern:"[a-z0-9][a-z0-9\\-]*",spellcheck:"false",autocapitalize:"none",required:""});
    let slugTouched = !isNew || Boolean(template);
    title.addEventListener("input",() => { if (!slugTouched) slug.value = slugOf(title.value); });
    slug.addEventListener("input",() => { slugTouched = true; });
    const base = view.status.url ? view.status.url.replace(/^https:\/\//,"") + "/" : "your page/";
    const description = input("text",type.description,{maxlength:"300"});
    // The meeting lands in this address's calendar and Google invites the guest from it.
    const address = element("select");
    for (const choice of view.addresses) address.append(new Option(choice.email,choice.sub,false,choice.sub === type.accountSub));
    address.disabled = view.addresses.length < 2;

    const duration = number(type.durationMin,5,480,"5");
    duration.setAttribute("list","booking-lengths");
    const lengths = element("datalist");
    lengths.id = "booking-lengths";
    for (const minutes of [15,20,30,45,60,90]) lengths.append(new Option(lengthLabel(minutes),String(minutes)));

    const ahead = number(type.maxDaysAhead,1,90), notice = number(type.minNoticeMin / 60,0,720,"0.5");
    const step = number(type.slotStepMin,5,240,"5"), gap = number(type.bufferMin,0,240,"5");
    const range = element("p","booking-sentence");
    range.append("Guests can book up to ",ahead," days ahead, with at least ",notice," hours of notice.");
    ahead.setAttribute("aria-label","Days ahead");
    notice.setAttribute("aria-label","Hours of notice");

    // Weekly hours: the planner's working hours, or this type's own.
    const planner = settings?.();
    const schedule = element("select");
    schedule.append(new Option("Your working hours" + (planner ? " (" + hoursLabel(null,planner) + ")" : ""),"working",false,!type.hours),
      new Option("Custom hours for this type","custom",false,Boolean(type.hours)));
    const week = element("div","booking-week");
    const rows = DAYS.map(([key,name,letter],i) => {
      const own = type.hours?.[key]?.[0];
      const working = planner?.workDays.includes(i+1);
      const on = type.hours ? Boolean(own) : Boolean(working);
      const row = element("div","booking-day");
      const available = check(name,on);
      available.wrap.classList.add("booking-day-name");
      available.wrap.title = name;
      const badge = element("span","booking-day-badge",letter);
      badge.setAttribute("aria-hidden","true");
      available.wrap.prepend(badge);
      const from = input("time",own?.start ?? planner?.startTime ?? "09:00",{"aria-label":name + " from",required:""});
      const to = input("time",own?.end ?? planner?.endTime ?? "17:00",{"aria-label":name + " until",required:""});
      const off = element("span","booking-day-off","Unavailable");
      const paint = () => { from.hidden = to.hidden = dash.hidden = !available.box.checked; off.hidden = available.box.checked; from.disabled = to.disabled = !available.box.checked; };
      const dash = element("span","booking-day-dash","–");
      available.box.addEventListener("change",paint);
      row.append(available.wrap,from,dash,to,off);
      paint();
      week.append(row);
      return {key,name,box:available.box,from,to};
    });
    const paintSchedule = () => { week.hidden = schedule.value !== "custom"; };
    schedule.addEventListener("change",paintSchedule);
    paintSchedule();
    const zoneNote = element("p","hint","Times are in " + (zone?.() || "your planner’s time zone").replaceAll("_"," ") + ". Busy times on your calendars are always left out.");

    const hidden = check("Hidden",type.hidden," Left off your page. Only people with its link can book it.");
    const wiki = check("Notes may be copied to the company wiki",type.notesToWiki," Off keeps notes of these meetings out of the wiki.");

    const error = element("p","field-error booking-panel-error");
    error.setAttribute("role","alert");
    error.hidden = true;

    form.append(
      section("Name",field("Title",title),field("Link",slug,base + (type.slug || "…")),field("Description",description)),
      view.addresses.length ? section("Booked with",field("Google address",address,"The meeting lands in this address’s calendar, and Google invites the guest from it.")) : "",
      section("Duration",field("Length (min)",duration),lengths),
      section("Location",element("p","booking-fixed","Google Meet. Each booking gets its own link, sent in Google’s invitation.")),
      section("Availability",range,pair(field("Offer a start every (min)",step),field("Gap between meetings (min)",gap)),field("Weekly hours",schedule),week,zoneNote),
      section("Options",hidden.wrap,wiki.wrap),
      error);

    const foot = element("footer","booking-panel-foot");
    const save = element("button","primary",isNew ? "Create meeting type" : "Save changes");
    save.type = "submit";
    const href = !isNew && linkFor(type.slug);
    if (!isNew) {
      const remove = element("button","text-button booking-delete","Delete");
      remove.type = "button";
      remove.disabled = view.types.length < 2;
      remove.title = remove.disabled ? "Keep at least one meeting type" : "";
      remove.addEventListener("click",async () => {
        if (!window.confirm("Delete “" + type.title + "”? Its link stops working. Meetings already booked stay in your calendar.")) return;
        if (await send({types:view.types.filter((_,i) => i !== index)},"Meeting type deleted.")) closePanel();
      });
      foot.append(remove);
    }
    if (href) {
      const preview = element("a","outside-link booking-preview","Preview");
      preview.href = href;
      preview.target = "_blank";
      preview.rel = "noopener noreferrer";
      foot.append(preview);
    }
    foot.append(save);
    form.append(foot);

    form.addEventListener("submit",async event => {
      event.preventDefault();
      panelError();
      let hours = null;
      if (schedule.value === "custom") {
        hours = {};
        for (const row of rows) {
          if (!row.box.checked) continue;
          if (row.from.value >= row.to.value) return panelError(row.name + " must end after it starts.");
          hours[row.key] = [{start:row.from.value,end:row.to.value}];
        }
        if (!Object.keys(hours).length) return panelError("Choose at least one day, or use your working hours.");
      }
      const next = {slug:slug.value.trim(),title:title.value.trim(),description:description.value.trim(),durationMin:Number(duration.value),
        slotStepMin:Number(step.value),bufferMin:Number(gap.value),minNoticeMin:Math.round(Number(notice.value) * 60),maxDaysAhead:Number(ahead.value),
        hidden:hidden.box.checked,notesToWiki:wiki.box.checked,hours,active:type.active !== false,...(type.accountSub && {accountSub:address.value || type.accountSub})};
      const types = isNew ? [...view.types,next] : view.types.map((known,i) => i === index ? next : known);
      save.disabled = true;
      if (await send({types},isNew ? "Meeting type created." : "Meeting type saved.")) closePanel();
      else save.disabled = false;
    });

    panel.append(head,form);
    // Beside the tab's content, not inside it: redrawing the tab must not close an open editor.
    root.parentElement.append(panel);
    panel.showModal();
    title.focus();
  }

  // ------------------------------------------------------------- lists
  function upcomingList() {
    const section = element("section","booking-section");
    section.append(element("h2","booking-heading","Upcoming booked meetings"));
    const timeZone = zone?.() || undefined;
    const day = new Intl.DateTimeFormat([],{weekday:"short",month:"short",day:"numeric",timeZone});
    const time = new Intl.DateTimeFormat([],{hour:"2-digit",minute:"2-digit",hourCycle:"h23",timeZone});
    if (!view.upcoming.length) section.append(element("p","hint","Nobody has booked a meeting yet."));
    else {
      const list = element("ul","booking-type-list");
      for (const meeting of view.upcoming) {
        const row = element("li","booking-type");
        const text = element("div","booking-type-text");
        text.append(element("strong","",meeting.type + " with " + meeting.name),
          element("span","booking-type-facts",[meeting.email,view.addresses.length > 1 && meeting.address && "booked with " + meeting.address].filter(Boolean).join(" · ")));
        row.append(text,element("span","booking-when",day.format(meeting.start) + " · " + time.format(meeting.start) + "–" + time.format(meeting.end)));
        list.append(row);
      }
      section.append(list);
    }
    return section;
  }

  function noticeList() {
    const section = element("section","booking-section");
    section.append(element("h2","booking-heading","Requests that were not booked"));
    for (const notice of view.notices) {
      const row = element("div","booking-notice");
      const when = notice.start ? new Date(notice.start).toLocaleString([],{weekday:"short",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}) : "";
      const text = element("p","",notice.name + " (" + notice.email + ") asked for " + notice.type + (when ? " on " + when : "") + ". Not booked: " +
        (reasons[notice.reason] || reasons.unavailable) + ".");
      const dismiss = element("button","text-button","Dismiss");
      dismiss.type = "button";
      dismiss.addEventListener("click",async () => {
        dismiss.disabled = true;
        try { view = await api("/api/booking/notices","POST",{id:notice.id}); render(); onChange?.(); }
        catch (error) { fail(error.message); dismiss.disabled = false; }
      });
      row.append(text,dismiss);
      section.append(row);
    }
    return section;
  }

  function render() {
    if (!view) { root.replaceChildren(element("p","hint","Loading your booking page…")); return; }
    // One section per connected Google address, each with its own meeting types and links.
    const sectionFor = address => {
      const part = element("section","booking-section");
      const bar = element("div","booking-section-bar");
      const create = action("secondary","New meeting type","plus");
      create.addEventListener("click",() => openPanel(-1,address?.sub));
      create.disabled = view.types.length >= 20;
      const heading = element("div","booking-address");
      heading.append(element("h2","booking-heading",address ? "Meeting types for" : "Meeting types"));
      if (address) heading.append(element("strong","booking-address-email",address.email));
      bar.append(heading,create);
      part.append(bar);
      if (address && !address.access) {
        const note = element("div","setup-box booking-access");
        note.append(element("p","hint","Dayline needs permission to add events to " + address.email + " before people can book you with it. Your tasks stay local."));
        const allow = element("button","secondary","Allow booked meetings");
        allow.type = "button";
        allow.addEventListener("click",() => connect(allow,{mode:"booking",accountSub:address.sub}));
        note.append(allow);
        part.append(note);
      } else if (address && address.calendars.length > 1) {
        const calendar = element("select");
        for (const choice of address.calendars) calendar.append(new Option(choice.name,choice.id,false,choice.id === address.calendarId));
        calendar.addEventListener("change",() => void send({calendars:{[address.sub]:calendar.value}},"Calendar saved."));
        const row = field("Bookings go to",calendar);
        row.classList.add("booking-calendar");
        part.append(row);
      }
      const cards = element("ul","booking-cards");
      view.types.forEach((type,index) => { if (!address || type.accountSub === address.sub) cards.append(typeCard(type,index)); });
      part.append(cards.children.length ? cards : element("p","hint","No meeting types for this address yet. People cannot book you with it."));
      return part;
    };
    const parts = [pageBox()];
    if (view.addresses.length) parts.push(...view.addresses.map(sectionFor));
    else parts.push(element("p","hint booking-connect","Connect a Google account under Settings → Calendars. Meeting types are then grouped by the address people book you with."),sectionFor(null));
    if (view.enabled) parts.push(upcomingList());
    if (view.notices.length) parts.push(noticeList());
    parts.push(element("p","hint booking-privacy","The public page shows your name, these meeting types and the start times that are free. Meeting details, tasks and Google access stay on this Mac."));
    root.replaceChildren(...parts);
  }

  // A card's menu closes when the pointer goes anywhere else.
  document.addEventListener("click",event => {
    for (const menu of root.querySelectorAll(".booking-menu[open]")) if (!menu.contains(event.target)) menu.open = false;
  });

  return {
    async open() {
      const current = ++sequence;
      if (!view) render();
      try {
        const next = await api("/api/booking");
        if (current !== sequence) return;
        view = next;
        render();
      } catch (error) { fail(error.message); }
    },
    // Coming back from Google's consent page: show the new access. An open editor keeps its unsaved input.
    async refresh() {
      if (!view || saving) return;
      try {
        const next = await api("/api/booking");
        if (saving) return;
        view = next;
        render();
      } catch { /* The next visit to this tab shows the error. */ }
    }
  };
}
