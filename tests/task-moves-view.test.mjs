import test from 'node:test';
import assert from 'node:assert/strict';
import {renderAgenda,renderWeek,renderBacklog} from '../web/views.js';
import {moveDates,movesByDay,nextMoveCheck} from '../web/task-moves.js';

const mon='2026-11-23', tue='2026-11-24', wed='2026-11-25';
const at=(day,time)=>day+'T'+time+':00Z';
const settings={timeZone:'UTC',workDays:[1,2,3,4,5],startTime:'09:00',endTime:'17:00',calendarMode:'availability'};
const move=(id,day,toDay)=>({id,day,toDay,start:at(day,'10:15'),end:at(day,'10:35'),timeZone:'UTC'});
const task={id:'task',text:'Submit samples',minutes:20,category:'admin',start:at(wed,'09:00'),end:at(wed,'09:20'),done:false,
  movedSlots:[move('first',mon,tue),move('second',tue,wed)]};

function fixture(t) {
  class Element {
    constructor(tag) { Object.assign(this,{tag,children:[],className:'',dataset:{},attributes:{},style:{setProperty(){}}});
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
  assert.match(dom.text(dom.get('agenda')),/10:15 AM.*Submit samples.*Moved to Tue, Nov 24/);
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
  assert.equal(movesByDay([history],[mon,tue],'Asia/Tokyo').get(mon)[0].start,23*60+40);
  assert.equal(movesByDay([history],[mon,tue],'Asia/Tokyo').get(tue).length,0);
});
