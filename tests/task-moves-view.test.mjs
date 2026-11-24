import test from 'node:test';
import assert from 'node:assert/strict';
import {freeTimeRows,renderAgenda,renderWeek,renderBacklog} from '../web/views.js';
import {moveDates,movesByDay,nextMoveCheck,placeControls,placeDays,placedMessage} from '../web/task-moves.js';

const mon='2026-11-23', tue='2026-11-24', wed='2026-11-25';
const at=(day,time)=>day+'T'+time+':00Z';
const settings={timeZone:'UTC',workDays:[1,2,3,4,5],startTime:'09:00',endTime:'17:00',calendarMode:'availability'};
const move=(id,day,toDay)=>({id,day,toDay,start:at(day,'10:15'),end:at(day,'10:35'),timeZone:'UTC'});
const task={id:'task',text:'Submit samples',minutes:20,category:'admin',start:at(wed,'09:00'),end:at(wed,'09:20'),done:false,
  movedSlots:[move('first',mon,tue),move('second',tue,wed)]};

function fixture(t) {
  class Element {
    constructor(tag) { Object.assign(this,{tag,children:[],className:'',dataset:{},attributes:{},style:{setProperty(key,value){this[key]=value;}}});
      this.classList={add:name=>{this.className+=' '+name;}}; }
    append(...children) {this.children.push(...children);}
    replaceChildren(...children) {this.children=children;}
    setAttribute(key,value) {this.attributes[key]=value;}
  }
  const elements=new Map(), previous=globalThis.document;
  const get=id=>{if(!elements.has(id))elements.set(id,Object.assign(new Element('div'),{id}));return elements.get(id);};
  globalThis.document={createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),getElementById:get,
    createTextNode:text=>Object.assign(new Element('text'),{textContent:text})};
  t.after(()=>{globalThis.document=previous;});
  const all=node=>node && typeof node==='object' ? [node,...node.children.flatMap(all)] : [];
  const text=node=>node && typeof node==='object' ? [node.textContent||'',...node.children.map(text)].join(' ') : String(node||'');
  return {get,all,text,match:(id,action)=>all(get(id)).filter(n=>n.dataset.action===action)};
}

test('day and week show each nonblocking move at its original time and preserve one editable task and one set of minutes',t=>{
  const dom=fixture(t), state={settings,categories:[],connection:{connected:false},busy:[{start:at(mon,'10:00'),end:at(mon,'11:00')}],tasks:[task],now:at(wed,'08:30')};
  const context={monday:mon,selected:mon,today:wed,weekends:true};
  renderAgenda(state,context);renderWeek(state,context);renderBacklog(state);
  assert.deepEqual(dom.match('agenda','move-destination').map(n=>[n.dataset.day,n.dataset.movedSlot]),[[tue,'first']]);
  assert.match(dom.text(dom.get('agenda')),/10:15.*Submit samples.*10:15–10:35 · 20m.*Moved to Tue, Nov 24/);
  assert.match(dom.text(dom.get('agenda')),/Calendar busy.*1h/);
  assert.match(dom.text(dom.get('agenda-summary')),/^\s*0 tasks\s*$/);
  assert.equal(dom.match('agenda','edit-task').length,0);
  assert.deepEqual(dom.match('week-board','move-destination').map(n=>n.dataset.day),[tue,wed]);
  assert.equal(dom.match('week-board','edit-task').length,1);
  assert.match(dom.text(dom.get('week-summary')),/1 task.*20m planned/);
  assert.equal(dom.text(dom.get('backlog-count')).trim(),'0');
  state.tasks=[{...task,start:null,end:null,issue:'No open work period fits.'}];
  renderAgenda(state,{...context,selected:wed});renderBacklog(state);
  assert.equal(dom.match('agenda','edit-task').length,0); assert.equal(dom.match('backlog-content','edit-task').length,1);
  const empty={...state,settings:{...settings,workDays:[]},busy:[]};
  renderAgenda(empty,context);assert.equal(dom.match('agenda','move-destination').length,1);
  assert.doesNotMatch(dom.text(dom.get('agenda')),/No tasks are scheduled/);
});

test('a moved task fills its former half hour up to the noon meeting and remains a link to the single live task',t=>{
  const dom=fixture(t), thurs='2026-11-26';
  const record={id:'vercel-move',day:mon,toDay:thurs,start:at(mon,'11:30'),end:at(mon,'12:00'),timeZone:'UTC'};
  const cleanup={...task,text:'Clean up Vercel',movedSlots:[record],minutes:10,start:at(thurs,'13:15'),end:at(thurs,'13:25')};
  const preceding={...cleanup,id:'preceding',text:'Earlier work',minutes:30,start:at(mon,'11:00'),end:at(mon,'11:30'),movedSlots:[]};
  const team={id:'team',title:'Team meeting',start:at(mon,'12:00'),end:at(mon,'13:00')};
  const state={settings:{...settings,startTime:'11:00',endTime:'13:00'},categories:[{id:'admin',name:'Admin',color:'#b57538'}],
    connection:{connected:false},busy:[],tasks:[cleanup,preceding],now:at(mon,'14:00')};
  const context={monday:mon,selected:mon,today:mon,events:[team]};
  renderAgenda(state,context);renderWeek(state,context);
  const rows=dom.get('agenda').children;
  assert.equal(rows.length,3);
  const [before,history,meeting]=rows;
  assert.deepEqual([before,history,meeting].map(row=>row.children[0].textContent),['11:00','11:30','12:00']);
  assert.equal(history.style['--agenda-block-height'],before.style['--agenda-block-height']);
  assert.match(dom.text(meeting),/Team meeting/);
  for(const view of ['agenda','week-board']) {
    const [link]=dom.match(view,'move-destination');
    assert.match(dom.text(link),/Clean up Vercel.*11:30–12:00 · 30m.*Moved to Thu, Nov 26/);
    assert.equal(link.dataset.day,thurs);
    assert.equal(link.dataset.clockBlock,'moved');
    assert.equal(link.style['--task-color'],'#b57538');
    assert.match(link.attributes['aria-label'],/Originally Monday, November 23, 2026, 11:30–12:00/);
    assert.deepEqual(dom.all(link).filter(n=>['toggle-task','adjust-duration','edit-task'].includes(n.dataset.action)),[]);
  }
  assert.match(dom.text(dom.get('agenda-summary')),/1 task.*30m planned/);
  renderAgenda(state,{...context,selected:thurs});
  assert.deepEqual(dom.match('agenda','edit-task').map(n=>n.dataset.id),[cleanup.id]);
  assert.match(dom.text(dom.get('agenda-summary')),/1 task.*10m planned/);
});

test('moved intervals replace only the covered portions of earlier free time',()=>{
  const history=[{start:690,end:720},{start:730,end:735}];
  const free=[{start:680,end:750}];
  assert.deepEqual(freeTimeRows(free,mon,at(mon,'12:20'),'UTC',history),[
    {start:680,end:690,kind:'elapsed'},{start:720,end:730,kind:'elapsed'},
    {start:735,end:740,kind:'elapsed'},{start:740,end:750,kind:'available'}]);
  assert.deepEqual(freeTimeRows(free,mon,at(mon,'11:35'),'UTC',history),[
    {start:680,end:690,kind:'elapsed'},{start:695,end:750,kind:'available'}]);
});

test('the move control is independent of task actions and uses server eligibility on elapsed tasks alone',t=>{
  const dom=fixture(t), active={...task,canMoveLater:true,start:at(mon,'09:00'),end:at(mon,'09:20'),movedSlots:[]};
  const state={settings,categories:[],connection:{connected:false},busy:[],tasks:[active,{...active,id:'done',done:true,canMoveLater:false},
    {...active,id:'protected',canMoveLater:false}],now:at(mon,'15:00')};
  const ctx={monday:mon,selected:mon,today:mon,weekends:false};
  renderWeek(state,ctx);renderAgenda(state,ctx);
  for (const surface of ['agenda','week-board']) {
    assert.deepEqual(dom.match(surface,'move-later').map(n=>n.dataset.id),['task']);
    assert.equal(dom.match(surface,'move-later')[0].attributes['aria-haspopup'],'dialog');
    assert.equal(dom.match(surface,'toggle-task').length,3); assert.equal(dom.match(surface,'adjust-duration').length,6);
  }
});

test('date limits and wall-clock history use planner days across time zones; ending reservations trigger a fresh eligibility read',()=>{
  const state={settings,now:at(mon,'15:00'),tasks:[{end:at(mon,'15:01'),done:true},{end:at(mon,'15:02'),done:false}]};
  assert.deepEqual(moveDates({start:at(mon,'09:00')},state),{min:tue,value:tue});
  assert.deepEqual(moveDates({start:at('2026-11-20','09:00')},state),{min:mon,value:mon});
  assert.deepEqual(moveDates({start:at('2026-11-20','09:00')},{...state,now:at('2026-11-20','18:00')}),{min:'2026-11-21',value:mon});
  assert.equal(nextMoveCheck(state),120075);
  assert.equal(nextMoveCheck({...state,now:at(mon,'15:02')}),null);
  const history={...task,movedSlots:[{...move('first',mon,tue),timeZone:'America/Los_Angeles',start:'2026-11-24T07:40Z',end:'2026-11-24T07:59Z'}]};
  const [slot]=movesByDay([history],[mon,tue],'Asia/Tokyo').get(mon);
  assert.deepEqual([slot.start,slot.end],[23*60+40,23*60+59]);
  assert.equal(movesByDay([history],[mon,tue],'Asia/Tokyo').get(tue).length,0);
});

test('a waiting task offers the next working days in one click, and a calendar problem is explained once above the list',t=>{
  const dom=fixture(t), fri='2026-11-27', nextMon='2026-11-30';
  const waiting={id:'a'.repeat(32),text:'Call the hotel',minutes:10,category:'admin',start:null,end:null,done:false,syncStatus:'attention'};
  const state={settings,categories:[],connection:{connected:true,error:null},busy:[],tasks:[waiting],now:at(mon,'10:00')};

  // Today while working time is left, then the following working days; weekends are skipped.
  assert.deepEqual(placeDays(state).map(d=>[d.day,d.label]),[[mon,'Today'],[tue,'Tomorrow'],[wed,'Wed, Nov 25'],['2026-11-26','Thu, Nov 26']]);
  assert.deepEqual(placeDays({...state,now:at(mon,'17:00')}).map(d=>d.label),['Tomorrow','Wed, Nov 25','Thu, Nov 26','Fri, Nov 27']);
  assert.deepEqual(placeDays({...state,now:at(fri,'18:00')}).map(d=>d.day)[0],nextMon);
  assert.deepEqual(placeDays({...state,settings:{...settings,workDays:[]}}),[]);

  renderBacklog(state);
  const days=()=>dom.match('backlog-content','place-task').map(n=>[n.dataset.day,n.textContent,n.attributes['aria-pressed']]);
  assert.deepEqual(days(),[[mon,'Today','false'],[tue,'Tomorrow','false'],[wed,'Wed, Nov 25','false'],['2026-11-26','Thu, Nov 26','false']]);
  assert.ok(dom.match('backlog-content','place-task').every(n=>n.dataset.id===waiting.id));
  const date=dom.all(dom.get('backlog-content')).find(n=>n.dataset.placeFor);
  assert.deepEqual([date.type,date.min,date.dataset.placeFor],['date',mon,waiting.id]);

  // A task kept for a day shows that day as chosen and offers to let Dayline pick again, also for a day beyond the offered ones.
  state.tasks=[{...waiting,earliestDay:tue,latestDay:tue,issue:'No open work period fits.'}];
  renderBacklog(state);
  assert.deepEqual(days(),[[mon,'Today','false'],[tue,'Tomorrow','true'],[wed,'Wed, Nov 25','false'],['2026-11-26','Thu, Nov 26','false'],['','Any day',undefined]]);
  assert.match(dom.text(dom.get('backlog-content')),/No open work period fits\./);
  state.tasks=[{...waiting,earliestDay:'2026-12-04',latestDay:'2026-12-04'}];
  renderBacklog(state);
  assert.deepEqual(days().slice(4),[['2026-12-04','Fri, Dec 4','true'],['','Any day',undefined]]);

  // Scheduled, finished and still-estimating tasks get no day buttons.
  for (const other of [{...waiting,start:at(tue,'09:00'),end:at(tue,'09:10')},{...waiting,done:true},{...waiting,pendingEstimate:true}]) assert.equal(placeControls(other,state),null);

  // Google could not be read: every task carries the same message. It is said once, with what brings the tasks back.
  const problem='Google no longer accepts Dayline’s access to ada@example.org. Reconnect that account under Settings → Calendars.';
  const held={...state,connection:{connected:true,error:problem},tasks:[{...waiting,issue:problem},{...waiting,id:'b'.repeat(32),issue:problem},
    {...waiting,id:'c'.repeat(32),issue:'No open work period fits.'}]};
  renderBacklog(held);
  const shown=dom.text(dom.get('backlog-content'));
  assert.equal(shown.split(problem).length-1,1);
  assert.match(shown,/2 tasks wait here because Dayline could not read Google Calendar.*As soon as the calendar can be read, Dayline plans them again, at the same time as before where that is still free\./);
  assert.match(shown,/No open work period fits\./);
  assert.equal(dom.match('backlog-content','refresh-availability').length,1);
  assert.equal(dom.match('backlog-content','calendar-settings').length,1);
  assert.equal(dom.match('backlog-content','place-task').length,12);

  // After a choice: where it landed, or why it still waits.
  assert.equal(placedMessage({...waiting,start:at(tue,'09:30'),end:at(tue,'09:40')},tue,state),'Scheduled for Tue, Nov 24, 09:30.');
  assert.equal(placedMessage({...waiting,issue:'No open work period fits.'},tue,state),'No free time on Tue, Nov 24. Still in Unscheduled. No open work period fits.');
  assert.equal(placedMessage(waiting,'',state),'No free time found yet. Still in Unscheduled.');
  assert.equal(placedMessage({...waiting,issue:problem},tue,held),'Saved for Tue, Nov 24. It gets a time once Google Calendar can be read.');
});
