// The Week view as a time grid: which hours it shows, where a block sits, and how overlapping blocks share a column.
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderWeek, weekHours, weekLanes } from '../web/views.js';

const settings = { timeZone: 'UTC', workDays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', calendarMode: 'availability' };
const block = (start, end) => ({ start, end });

test('the grid shows working hours, widened to whole hours around anything earlier or later', () => {
  assert.deepEqual(weekHours(settings, []), { start: 540, end: 1020 });
  assert.deepEqual(weekHours(settings, [block(510, 520), block(1110, 1200)]), { start: 480, end: 1200 });
  assert.deepEqual(weekHours({ ...settings, startTime: '08:30', endTime: '17:30' }, []), { start: 480, end: 1080 });
  assert.deepEqual(weekHours(settings, [block(0, 1440)]), { start: 0, end: 1440 });
});

test('overlapping blocks sit side by side and a freed lane is reused', () => {
  const a = block(540, 600), b = block(540, 570), c = block(570, 600), later = block(600, 630);
  const lanes = weekLanes([a, b, c, later]);
  assert.deepEqual([a, b, c, later].map(entry => lanes.get(entry)), [{ lane: 0, count: 2 }, { lane: 1, count: 2 }, { lane: 1, count: 2 }, { lane: 0, count: 1 }]);
  // Back-to-back blocks keep the full width.
  const first = block(510, 520), second = block(520, 580);
  assert.deepEqual([...weekLanes([first, second]).values()], [{ lane: 0, count: 1 }, { lane: 0, count: 1 }]);
  // A five-minute block is drawn ten minutes tall, so its neighbour moves beside it instead of under it.
  const brief = block(540, 545), next = block(545, 560);
  assert.deepEqual([...weekLanes([brief, next]).values()], [{ lane: 0, count: 2 }, { lane: 1, count: 2 }]);
});

test('every block is placed at its time and sized by its length; all-day and finished-early items stay off the grid', t => {
  class Element {
    constructor(tag) { Object.assign(this, { tag, children: [], className: '', dataset: {}, attributes: {}, textContent: '', style: { setProperty(key, value) { this[key] = value; } } });
      this.classList = { add: name => { this.className += ' ' + name; } }; }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
  }
  const elements = new Map(), previous = globalThis.document;
  const get = id => { if (!elements.has(id)) elements.set(id, Object.assign(new Element('div'), { id })); return elements.get(id); };
  globalThis.document = { getElementById: get, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    createTextNode: text => Object.assign(new Element('text'), { textContent: text }) };
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  const all = node => [node, ...node.children.flatMap(all)];
  const named = (root, cls) => all(root).filter(node => node.className.split(' ').includes(cls));
  const words = node => all(node).map(part => part.textContent).join(' ');

  const mon = '2026-11-23', at = time => mon + 'T' + time + ':00Z';
  const task = { id: 'call', text: 'Call the supplier', category: 'admin', minutes: 30, start: at('10:15'), end: at('10:45'), done: false, subtasks: [] };
  const brief = { ...task, id: 'note', text: 'Send a note', minutes: 5, start: at('08:30'), end: at('08:35') };
  const early = { id: 'early', text: 'Finished early', done: true, minutes: 30, start: null, end: null, completedDay: mon, subtasks: [] };
  const events = [{ id: 'dinner', title: 'Dinner', start: at('18:30'), end: at('20:00') },
    { id: 'holiday', title: 'Holiday', allDay: true, startDate: mon, endDate: '2026-11-24', start: at('00:00'), end: '2026-11-24T00:00:00Z', transparent: true }];
  const state = { settings, tasks: [task, brief, early], categories: [{ id: 'admin', name: 'Admin', color: '#b57538' }], busy: [], now: at('07:00'),
    connection: { connected: false } };
  renderWeek(state, { monday: mon, selected: mon, today: mon, weekends: false, events });

  const [axis, monday, tuesday] = get('week-board').children;
  assert.equal(get('week-board').children.length, 6, 'one hour axis and five days');
  assert.match(axis.className, /week-hours/);
  assert.deepEqual(named(axis, 'week-hour').map(mark => mark.textContent), ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00']);
  assert.match(words(axis), /All day/);

  const [body] = named(monday, 'day-body');
  assert.deepEqual([body.dataset.clockDay, body.style['--grid-minutes'], body.style['--work-from'], body.style['--work-to']], [mon, '720', '60', '540']);
  const slots = Object.fromEntries(named(body, 'week-slot').map(slot => [words(slot).match(/Call the supplier|Send a note|Dinner/)[0], slot]));
  const place = slot => [slot.style['--from'], slot.style['--minutes'], slot.style['--lane'], slot.style['--lanes']];
  assert.deepEqual(place(slots['Call the supplier']), ['135', '30', '0', '1']);
  assert.deepEqual(place(slots['Send a note']), ['30', '10', '0', '1'], 'a five-minute task is drawn ten minutes tall');
  assert.deepEqual(place(slots.Dinner), ['630', '90', '0', '1']);
  assert.match(slots['Call the supplier'].className, /is-task is-short/);
  assert.match(slots['Send a note'].className, /is-brief/);
  assert.equal(slots['Call the supplier'].style['--task-color'], '#b57538');
  // The same controls as before are inside the block, for the keyboard and for tests of each control.
  assert.deepEqual(all(slots['Call the supplier']).filter(node => node.dataset.action).map(node => node.dataset.action),
    ['toggle-task', 'edit-task', 'adjust-duration', 'adjust-duration']);

  assert.match(words(named(monday, 'week-allday')[0]), /Holiday/);
  assert.doesNotMatch(words(body), /Holiday|Finished early/);
  assert.match(words(named(monday, 'week-foot')[0]), /Completed.*Finished early/);
  // An empty day still has the full grid, so the days line up.
  assert.equal(named(tuesday, 'day-body')[0].style['--grid-minutes'], '720');
  assert.equal(named(tuesday, 'week-slot').length, 0);
});
