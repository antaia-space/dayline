// The public booking page: pick a meeting type, a day and a time; enter your
// details; later reschedule or cancel from the link in the invitation.
// Ported from antaia-space/meet (Scheduler.tsx, Manage.tsx) to plain DOM code.
// Everything shown comes from /api/<handle>/…; nothing is stored in the browser.

const app = document.getElementById('app');
const [handle, second, third] = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
const DAY = 86_400_000;

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

function show(...nodes) {
  app.replaceChildren(...nodes, h('p', { class: 'brand' }, 'Scheduling by Dayline'));
}

async function call(method, path, body) {
  try {
    const response = await fetch('/api/' + encodeURIComponent(handle) + path, { method, cache: 'no-store',
      ...(body && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'Network error. Try again.' } };
  }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// The calendar's owner may be offline. Ask a few times, then say honestly that it is still open.
async function settled(token, waiting) {
  let latest = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await pause(attempt < 3 ? 1000 : 2500);
    const answer = await call('GET', '/booking/' + token);
    if (answer.ok) latest = answer.data;
    if (latest && !waiting(latest)) break;
  }
  return latest;
}

// ---------------------------------------------------------------- time
const formatters = new Map();
function zonedDay(ms, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) formatters.set(timeZone, f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  const out = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== 'literal') out[part.type] = Number(part.value);
  return { year: out.year, month: out.month, day: out.day };
}
const ymd = d => d.year + '-' + String(d.month).padStart(2, '0') + '-' + String(d.day).padStart(2, '0');
const monthIndex = v => v.y * 12 + v.m;
const nextMonth = v => v.m === 12 ? { y: v.y + 1, m: 1 } : { y: v.y, m: v.m + 1 };
const prevMonth = v => v.m === 1 ? { y: v.y - 1, m: 12 } : { y: v.y, m: v.m - 1 };
const zoneName = zone => zone.replace(/_/g, ' ');

function detectedZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function whenText(startMs, endMs, timeZone) {
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone });
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone });
  return time.format(startMs) + ' – ' + time.format(endMs) + ', ' + date.format(startMs);
}

function info(type, owner, ...children) {
  return h('aside', { class: 'pad info' },
    h('p', { class: 'owner' }, owner.name, owner.headline && h('span', { class: 'muted' }, ' · ' + owner.headline)),
    h('h1', {}, type.title),
    h('p', { class: 'facts' }, h('span', {}, type.durationMin + ' min'), h('span', {}, 'Google Meet')),
    type.description && h('p', {}, type.description),
    children);
}

function message(title, ...children) {
  show(h('div', { class: 'card done' }, h('h1', {}, title), children));
}

// ---------------------------------------------------------- index page
// `group` is the page of one of the owner's addresses.
async function home(group) {
  const { ok, data } = await call('GET', group ? '/group/' + encodeURIComponent(group) : '/page');
  if (!ok) return message('No booking page here', h('p', { class: 'muted' }, data.error || 'Check the link you were given.'));
  document.title = 'Book a meeting with ' + data.owner.name;
  show(h('div', { class: 'card home' },
    h('div', { class: 'pad' },
      h('h1', {}, data.owner.name),
      data.owner.headline && h('p', { class: 'muted' }, data.owner.headline),
      h('p', {}, data.types.length ? 'Pick a meeting type.' : 'There is nothing to book here at the moment.')),
    h('ul', { class: 'types' }, data.types.map(type => h('li', {},
      h('a', { href: '/' + encodeURIComponent(handle) + '/' + type.slug },
        h('span', {}, h('strong', {}, type.title), type.description && h('span', { class: 'muted' }, type.description)),
        h('span', { class: 'duration' }, type.durationMin + ' min')))))));
}

// ----------------------------------------------------------- scheduler
// `moving` is set when an existing booking is given a new time: { token, start, back }.
// `moving` is set when an existing booking is given a new time; `pass` when the guest came by a single-use link.
async function scheduler(slug, moving, pass) {
  const state = { tz: detectedZone(), zones: [], weekStart: 1, view: null, slots: null, day: null, picked: null, step: 'pick',
    sending: false, error: null, loadError: null, type: null, owner: null, open: true, first: true };
  try { state.zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browsers: the detected zone alone */ }
  if (!state.zones.includes(state.tz)) state.zones = [state.tz, ...state.zones];
  try {
    const locale = new Intl.Locale(navigator.language);
    const week = locale.getWeekInfo?.() ?? locale.weekInfo;
    if (week) state.weekStart = week.firstDay % 7;
  } catch { /* keep Monday */ }

  async function load() {
    state.slots = null;
    state.loadError = null;
    if (state.type) draw();
    const { ok, status, data } = await call('GET', pass ? '/once/' + pass : '/slots/' + encodeURIComponent(slug));
    if (!ok && status === 410) return message('This link has been used', h('p', { class: 'muted' }, 'A single-use link works for one booking. Ask for a new one.'));
    if (!ok && status === 404) return message('Nothing to book here', h('p', { class: 'muted' }, data.error || 'Check the link you were given.'));
    if (!ok) { state.loadError = data.error || 'Could not load times.'; state.slots = []; if (!state.type) return message('Could not load this page', h('p', { class: 'muted' }, state.loadError)); return draw(); }
    Object.assign(state, { type: data.type, owner: data.owner, open: data.open, slots: data.slots });
    document.title = data.type.title + ' with ' + data.owner.name;
    const days = new Set(state.slots.map(ms => ymd(zonedDay(ms, state.tz))));
    if (state.first || !state.view) {
      // Open on the first month that has a free time.
      const first = zonedDay(state.slots[0] ?? Date.now(), state.tz);
      state.view = { y: first.year, m: first.month };
      state.first = false;
    }
    if (!state.day || !days.has(state.day)) state.day = state.slots.length ? ymd(zonedDay(state.slots[0], state.tz)) : null;
    draw();
  }

  const range = (startMs, endMs) => whenText(startMs, endMs, state.tz);
  const length = () => state.type.durationMin * 60_000;

  async function submit(event) {
    event.preventDefault();
    if (state.picked === null || state.sending) return;
    const form = new FormData(event.currentTarget);
    state.form = Object.fromEntries(form);
    state.sending = true;
    state.error = null;
    draw();
    const answer = await call('POST', '/book', { type: state.type.slug, ...(pass && { pass }), start: state.picked, timeZone: state.tz, name: form.get('name'), email: form.get('email'),
      notes: form.get('notes'), website: form.get('website') });
    if (!answer.ok) return failed(answer);
    const latest = answer.data.status === 'pending' ? await settled(answer.data.token, record => record.status === 'pending') : answer.data;
    finish({ ...answer.data, ...latest }, String(form.get('email')));
  }

  async function move(start) {
    if (state.sending) return;
    state.sending = true;
    state.error = null;
    draw();
    const answer = await call('POST', '/booking/' + moving.token + '/reschedule', { start });
    if (!answer.ok) return failed(answer);
    const latest = answer.data.change ? await settled(moving.token, record => Boolean(record.change)) : answer.data;
    const record = { ...answer.data, ...latest };
    if (!record.change && record.start !== start) return failed({ status: 409, data: { error: 'That time is no longer available. Your meeting stays where it was. Pick another one.' } });
    finish(record);
  }

  function failed(answer) {
    state.sending = false;
    state.error = answer.data.error || 'Something went wrong. Try again.';
    if (answer.status === 409) {
      state.step = 'pick';
      state.picked = null;
      return load();
    }
    draw();
  }

  function finish(record, email) {
    state.sending = false;
    if (record.status === 'declined' || record.status === 'expired') {
      return failed({ status: 409, data: { error: 'That time was just taken. Pick another one.' } });
    }
    const manage = '/' + encodeURIComponent(handle) + '/booking/' + record.token;
    const start = record.change?.start ?? record.start, end = record.change?.end ?? record.end;
    const waiting = record.status === 'pending' || Boolean(record.change);
    const title = waiting ? (moving ? 'Change received' : 'Request received') : (moving ? 'Meeting moved' : 'You are booked');
    show(h('div', { class: 'card done' },
      h('div', { class: 'check', 'aria-hidden': 'true' }, waiting ? '…' : '✓'),
      h('h1', {}, title),
      h('p', { class: 'lead' }, state.type.title + ' with ' + state.owner.name),
      h('p', { class: 'when' }, range(start, end)),
      h('p', { class: 'muted' }, zoneName(state.tz)),
      waiting
        ? h('p', { class: 'notice', role: 'status' }, state.owner.name + '’s calendar is offline at the moment. This time is held for you. ' +
            (moving ? 'Google sends an updated invitation once the calendar has confirmed the change. Until then the meeting stays at its current time.'
              : 'The Google Calendar invitation is your confirmation and arrives once the calendar is back. If none arrives, the meeting is not booked.'))
        : h('p', { class: 'muted' }, email ? 'A calendar invitation with the Google Meet link is on its way to ' + email + '.'
            : 'An updated calendar invitation is on its way.'),
      h('p', {}, h('a', { href: manage }, waiting ? 'Check, reschedule or cancel' : 'Reschedule or cancel'))));
  }

  function draw() {
    const { type, owner, view, tz } = state;
    if (state.step === 'form' && state.picked !== null) {
      const saved = state.form || {};
      show(h('div', { class: 'card scheduler' },
        info(type, owner, h('p', { class: 'when' }, range(state.picked, state.picked + length())), h('p', { class: 'muted' }, zoneName(tz))),
        h('form', { class: 'pad form', onsubmit: submit },
          h('button', { type: 'button', class: 'link', onclick: () => { state.step = 'pick'; draw(); } }, '← Change time'),
          h('h2', {}, 'Your details'),
          h('label', {}, 'Name', h('input', { name: 'name', required: true, minlength: '2', maxlength: '100', autocomplete: 'name', autofocus: true, value: saved.name })),
          h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true, maxlength: '254', autocomplete: 'email', value: saved.email })),
          h('label', {}, h('span', {}, 'Anything I should know before the call? ', h('span', { class: 'muted' }, '(optional)')),
            h('textarea', { name: 'notes', rows: '4', maxlength: '2000' }, saved.notes || '')),
          h('div', { class: 'trap', 'aria-hidden': 'true' }, h('label', {}, 'Website', h('input', { name: 'website', tabindex: '-1', autocomplete: 'off' }))),
          state.error && h('p', { class: 'error', role: 'alert' }, state.error),
          h('button', { type: 'submit', class: 'primary', disabled: state.sending }, state.sending ? 'Booking…' : 'Book meeting'))));
      if (!state.sending) app.querySelector('input[name=name]')?.focus();
      return;
    }

    const now = Date.now(), today = zonedDay(now, tz);
    const firstMonth = { y: today.year, m: today.month };
    const last = zonedDay(state.slots?.at(-1) ?? now + type.maxDaysAhead * DAY, tz);
    const lastMonth = { y: last.year, m: last.month };
    const byDay = new Map();
    for (const ms of state.slots || []) {
      const key = ymd(zonedDay(ms, tz));
      if (byDay.has(key)) byDay.get(key).push(ms); else byDay.set(key, [ms]);
    }
    const firstWeekday = new Date(Date.UTC(view.y, view.m - 1, 1)).getUTCDay();
    const blanks = (firstWeekday - state.weekStart + 7) % 7;
    const dayCount = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate();
    const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(view.y, view.m - 1, 1));
    const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
    // 1 January 2023 was a Sunday.
    const weekdayNames = Array.from({ length: 7 }, (_, i) => weekdayFmt.format(Date.UTC(2023, 0, 1 + ((state.weekStart + i) % 7))));
    const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
    const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz });
    const daySlots = state.day ? byDay.get(state.day) ?? [] : [];
    const inMonth = [...byDay.keys()].some(key => key.startsWith(view.y + '-' + String(view.m).padStart(2, '0')));
    const changeMonth = target => { state.view = target; state.day = null; state.picked = null; draw(); };

    show(h('div', { class: 'card scheduler' },
      info(type, owner,
        moving && h('p', { class: 'muted' }, 'Currently: ', h('s', {}, range(moving.start, moving.start + length()))),
        moving && h('button', { type: 'button', class: 'link', onclick: moving.back }, '← Keep the current time')),
      h('section', { class: 'pad calendar', 'aria-label': 'Pick a day' },
        h('h2', {}, moving ? 'Pick a new time' : 'Pick a day and time'),
        h('div', { class: 'month' },
          h('button', { type: 'button', class: 'icon', 'aria-label': 'Previous month', disabled: monthIndex(view) <= monthIndex(firstMonth), onclick: () => changeMonth(prevMonth(view)) }, '‹'),
          h('strong', { 'aria-live': 'polite' }, monthTitle),
          h('button', { type: 'button', class: 'icon', 'aria-label': 'Next month', disabled: monthIndex(view) >= monthIndex(lastMonth), onclick: () => changeMonth(nextMonth(view)) }, '›')),
        h('div', { class: 'grid' },
          weekdayNames.map(name => h('span', { class: 'weekday' }, name)),
          Array.from({ length: blanks }, () => h('span')),
          Array.from({ length: dayCount }, (_, i) => {
            const key = ymd({ year: view.y, month: view.m, day: i + 1 }), open = byDay.has(key);
            return h('button', { type: 'button', class: 'day' + (key === state.day ? ' selected' : '') + (key === ymd(today) ? ' today' : ''), disabled: !open,
              'aria-pressed': String(key === state.day), 'aria-label': dayLabel.format(Date.UTC(view.y, view.m - 1, i + 1)) + (open ? '' : ', no times'),
              onclick: () => { state.day = key; state.picked = null; draw(); } }, String(i + 1));
          })),
        h('label', { class: 'zone' }, 'Time zone',
          h('select', { onchange: event => { state.tz = event.target.value; state.day = null; state.picked = null; state.view = null; state.first = true; load(); } },
            state.zones.map(zone => h('option', { value: zone, selected: zone === tz }, zoneName(zone)))))),
      h('section', { class: 'pad times', 'aria-label': 'Pick a time' },
        state.loadError && h('p', { class: 'error', role: 'alert' }, state.loadError + ' ', h('button', { type: 'button', class: 'link', onclick: load }, 'Retry')),
        state.error && h('p', { class: 'error', role: 'alert' }, state.error),
        state.slots === null && h('p', { class: 'muted' }, 'Loading…'),
        state.slots !== null && !state.open && h('p', { class: 'notice' }, 'Booking is paused at the moment. Please try again later.'),
        state.slots !== null && state.open && !inMonth && h('p', { class: 'muted' }, state.slots.length ? 'No free times this month.' : 'No free times at the moment.'),
        state.day && daySlots.length > 0 && [
          h('h3', {}, dayLabel.format(Date.parse(state.day + 'T00:00:00Z'))),
          h('ul', { class: 'slots' }, daySlots.map(ms => h('li', { class: ms === state.picked ? 'open' : '' },
            h('button', { type: 'button', class: 'slot', 'aria-pressed': String(ms === state.picked), onclick: () => { state.picked = ms; draw(); } }, timeFmt.format(ms)),
            ms === state.picked && (moving
              ? h('button', { type: 'button', class: 'primary', disabled: state.sending, onclick: () => move(ms) }, state.sending ? 'Moving…' : 'Move')
              : h('button', { type: 'button', class: 'primary', onclick: () => { state.step = 'form'; draw(); } }, 'Next')))))])));
    if (state.picked !== null) app.querySelector('.slots .primary')?.focus();
  }

  await load();
}

// -------------------------------------------------------------- manage
async function manage(token) {
  const { ok, data } = await call('GET', '/booking/' + token);
  if (!ok) return message('Booking not found', h('p', { class: 'muted' }, data.error || 'This booking does not exist or is cancelled already.'));
  const state = { record: data, mode: 'view', sending: false, error: null };
  const again = () => h('p', {}, h('a', { href: '/' + encodeURIComponent(handle) + '/' + data.type.slug }, 'Book a new time'));

  async function cancel() {
    state.sending = true;
    state.error = null;
    draw();
    const answer = await call('POST', '/booking/' + token + '/cancel', {});
    state.sending = false;
    if (!answer.ok) state.error = answer.data.error || 'Could not cancel. Try again.';
    else {
      const latest = answer.data.change ? await settled(token, record => Boolean(record.change)) : answer.data;
      state.record = { ...answer.data, ...latest };
      state.mode = 'view';
    }
    draw();
  }

  function draw() {
    const { record } = state, { type, owner } = record;
    const who = owner ? ' with ' + owner.name : '';
    document.title = type.title + who;
    if (state.mode === 'reschedule') return scheduler(type.slug, { token, start: record.start, back: () => { state.mode = 'view'; draw(); } });
    const when = whenText(record.start, record.end, detectedZone()) + ' (' + zoneName(detectedZone()) + ')';
    const leaving = record.change?.kind === 'cancel';
    if (record.status === 'cancelled' || leaving) {
      return message('Meeting cancelled',
        h('p', { class: 'muted' }, leaving ? 'Google sends the cancellation as soon as the calendar has been updated.'
          : record.note === 'removed' ? 'This meeting was removed from the calendar.' : 'The calendar event is removed and a cancellation is on its way by email.'), again());
    }
    if (record.status === 'declined' || record.status === 'expired') {
      return message('This meeting is not booked',
        h('p', { class: 'muted' }, record.status === 'expired' ? 'The request could not be confirmed in time.' : 'The time was taken before the request could be confirmed.'), again());
    }
    const pending = record.status === 'pending';
    show(h('div', { class: 'card done' },
      h('h1', {}, type.title),
      h('p', { class: 'lead' }, who.trim()),
      h('p', { class: 'when' }, when),
      pending && h('p', { class: 'notice', role: 'status' }, 'Waiting for confirmation. This time is held for you. The Google Calendar invitation is your confirmation; if none arrives, the meeting is not booked.'),
      record.change?.kind === 'move' && h('p', { class: 'notice', role: 'status' }, 'A move to ' + whenText(record.change.start, record.change.end, detectedZone()) +
        ' is waiting for the calendar. Until it is confirmed the meeting stays at the time above.'),
      record.note === 'move-declined' && h('p', { class: 'notice' }, 'The new time you asked for was no longer free. The meeting stays at the time above.'),
      !pending && !record.change && h('p', { class: 'muted' }, 'The Google Meet link is in your calendar invitation.'),
      state.error && h('p', { class: 'error', role: 'alert' }, state.error),
      state.mode === 'confirm'
        ? h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'danger', disabled: state.sending, onclick: cancel }, state.sending ? 'Cancelling…' : 'Yes, cancel the meeting'),
            h('button', { type: 'button', class: 'secondary', disabled: state.sending, onclick: () => { state.mode = 'view'; draw(); } }, 'Keep it'))
        : h('div', { class: 'actions' },
            record.open && h('button', { type: 'button', class: 'primary', onclick: () => { state.mode = 'reschedule'; draw(); } }, 'Reschedule'),
            h('button', { type: 'button', class: 'secondary', onclick: () => { state.mode = 'confirm'; draw(); } }, 'Cancel meeting'))));
  }
  draw();
}

if (!handle) message('No booking page here');
else if (second === 'booking' && third) manage(third);
else if (second === 'with' && third) home(third);
else if (second === 'once' && third) scheduler(null, null, third);
else if (second) scheduler(second);
else home();
