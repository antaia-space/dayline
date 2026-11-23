import assert from 'node:assert/strict';
import test from 'node:test';
import {addOrderHandle,orderRequest} from '../web/task-order.js';
import {fittedDuration,freeTimeRows} from '../web/views.js';

test('reorder controls send a same-list target and distinguish adjacent and long moves from no-ops', () => {
  const day = '2026-12-01', ids = ['draft','review','notes','email'];
  assert.deepEqual(orderRequest(ids,'notes','review','before',day),{targetId:'review',placement:'before',day});
  assert.deepEqual(orderRequest(ids,'draft','email','after',day),{targetId:'email',placement:'after',day});
  assert.deepEqual(orderRequest(ids,'draft','review','after','unscheduled'),{targetId:'review',placement:'after',day:'unscheduled'});
  for (const [source,target,placement] of [
    ['review','notes','before'],['notes','review','after'],['draft','draft','before'],
    ['draft','fixed','before'],['meeting','notes','after'],['draft','email','sideways']
  ]) assert.equal(orderRequest(ids,source,target,placement,day),null);
  assert.deepEqual(ids,['draft','review','notes','email']);
});

test('calendar-fit wording gives the planned and original durations only while the block is shorter', () => {
  const task = {minutes:25,calendarFit:{originalMinutes:30}};
  assert.equal(fittedDuration(task).label,'25m planned · 30m estimate');
  assert.match(fittedDuration(task).explanation,/5m.*calendar commitments/);
  assert.equal(fittedDuration({...task,minutes:30}),null);
  assert.equal(fittedDuration({...task,calendarFit:null}),null);
  assert.equal(fittedDuration({...task,pendingEstimate:true}),null);
});

test('a free period crossing now splits at the next usable minute in the working timezone', () => {
  const day = '2026-12-01', zone = 'America/Los_Angeles';
  const intervals = [{start:540,end:570},{start:600,end:720},{start:780,end:810}];
  assert.deepEqual(freeTimeRows(intervals,day,'2026-12-01T18:07:32Z',zone),[
    {start:540,end:570,kind:'elapsed'},{start:600,end:608,kind:'elapsed'},
    {start:608,end:720,kind:'available'},{start:780,end:810,kind:'available'}
  ]);
  assert.deepEqual(freeTimeRows([{start:600,end:608}],day,'2026-12-01T18:00:00Z',zone),[{start:600,end:608,kind:'available'}]);
  assert.ok(freeTimeRows(intervals,'2026-11-30','2026-12-01T18:07Z',zone).every(r => r.kind === 'elapsed'));
  assert.ok(freeTimeRows(intervals,'2026-12-02','2026-12-01T18:07Z',zone).every(r => r.kind === 'available'));
});

test('only server-authorized tasks render a named keyboard and pointer handle in their own group', t => {
  function node(tag) {
    return {tag,dataset:{},children:[],attributes:{},setAttribute(key,value){this.attributes[key]=value;},
      append(...items){this.children.push(...items);}};
  }
  const previous = globalThis.document;
  globalThis.document = {createElement:node};
  t.after(() => { if (previous) globalThis.document=previous; else delete globalThis.document; });
  const task = {id:'draft',title:'Prepare the outline'};
  const fixed = node('div');
  addOrderHandle(fixed,task,'2026-12-01','board');
  assert.deepEqual(fixed.children,[]);
  for (const [view,day] of [['agenda','2026-12-01'],['board','2026-12-01'],['backlog','unscheduled']]) {
    const row = node('div');
    addOrderHandle(row,{...task,canReorder:true},day,view);
    assert.deepEqual(row.dataset,{orderItem:'draft',orderDay:day,orderView:view});
    const [grip] = row.children;
    assert.equal(grip.tag,'button');
    assert.equal(grip.attributes['aria-label'],'Reorder Prepare the outline');
    assert.equal(grip.attributes['aria-haspopup'],'menu');
    assert.equal(grip.attributes['aria-keyshortcuts'],'ArrowUp ArrowDown');
    assert.equal(grip.dataset.focus,view+'-order-draft');
  }
});
