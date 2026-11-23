import assert from 'node:assert/strict';
import test from 'node:test';
import {agendaBlockSize,releasedCompletionDay,renderAgenda,renderBacklog,renderWeek} from '../web/views.js';

const day = '2026-12-01';
const start = Date.parse(day+'T09:00:00Z');
const at = minute => new Date(start+minute*60000).toISOString();
const size = (minutes,fields={},type='task') => agendaBlockSize({
  kind:type,start:540,end:540+minutes,[type]:{start:at(0),end:at(minutes),...fields}
},day,'UTC');

test('visible task and meeting lengths use a bounded scale and shortened tasks use their booked interval', () => {
  assert.ok(size(5).minimumRem < size(30).minimumRem);
  assert.ok(size(30).minimumRem < size(60).minimumRem);
  assert.ok(size(60).minimumRem < size(120).minimumRem);
  assert.deepEqual(size(120),size(480));
  assert.deepEqual(size(30),size(30,{},'meeting'));
  assert.deepEqual(size(5,{minutes:60,calendarFit:{originalMinutes:60}}),size(5));
  assert.equal(size(5).compact,true);
  assert.equal(size(30).compact,false);
  assert.ok(size(1440,{allDay:true}).minimumRem < size(30).minimumRem);
  assert.deepEqual(agendaBlockSize({kind:'busy',start:0,end:1440},day,'UTC'),size(1440,{allDay:true}));
  assert.ok(agendaBlockSize({kind:'available',start:540,end:1020},day,'UTC').minimumRem < size(60).minimumRem);
});

test('places released completed tasks under their original day without reserving time or growing Unscheduled', t => {
  class FakeElement {
    constructor(tag) { this.tag=tag; this.className=''; this.textContent=''; this.children=[]; this.dataset={}; this.attributes={};
      this.style={setProperty(){}}; this.classList={add:name=>{this.className+=' '+name;}}; }
    setAttribute(name,value) { this.attributes[name]=value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=children; }
  }
  const elements=new Map(), previous=globalThis.document;
  globalThis.document={createElement:tag=>new FakeElement(tag),createElementNS:(_,tag)=>new FakeElement(tag),
    createTextNode:text=>Object.assign(new FakeElement('text'),{textContent:text}),
    getElementById(id){ if(!elements.has(id)) elements.set(id,Object.assign(new FakeElement('div'),{id})); return elements.get(id); }};
  t.after(()=>{ if(previous) globalThis.document=previous; else delete globalThis.document; });
  const flatten=node=>[node,...node.children.flatMap(flatten)];
  const text=node=>flatten(node).map(part=>part.textContent).join(' ');
  const named=(id,cls)=>flatten(elements.get(id)).filter(part=>part.className.split(' ').includes(cls));
  const released={id:'early',text:'Finish early',done:true,minutes:30,start:null,end:null,completedDay:day,completedAt:'2026-11-30T18:00:00Z'};
  const past={id:'history',text:'Short history',done:true,minutes:60,start:at(60),end:at(72)};
  const state={tasks:[released,past],categories:[],busy:[],connection:{connected:false},
    settings:{timeZone:'UTC',workDays:[1,2,3,4,5],startTime:'09:00',endTime:'12:00',calendarMode:'availability'},now:at(-30)};
  const context={monday:'2026-11-30',selected:day,today:day,weekends:false};
  renderAgenda(state,context); renderWeek(state,context); renderBacklog(state);
  for(const id of ['week-board','agenda']){
    const [section]=named(id,'completed-section');
    assert.match(section.attributes['aria-label'],/Dec 1/);
    assert.match(text(section),/Completed.*Finish early/);
    const [toggle]=flatten(section).filter(part=>part.dataset.action==='toggle-task');
    assert.equal(toggle.dataset.id,'early'); assert.equal(toggle.attributes['aria-pressed'],'true');
  }
  assert.deepEqual(named('agenda','agenda-task').map(text).map(value=>value.includes('Short history')),[true]);
  assert.match(text(elements.get('agenda-summary')),/12m planned/);
  assert.match(text(elements.get('week-summary')),/12m planned/);
  assert.equal(text(elements.get('backlog-count')),'0');
  assert.match(text(named('agenda','agenda-free')[0]),/Until 10:00 AM · 1h/);
  const replaced={...released,completedPlannedSlot:{start:at(0),end:at(5)}};
  const next={id:'next',text:'Review samples',minutes:10,done:false,start:at(0),end:at(10)};
  const second={...released,id:'another',text:'File a note',completedPlannedSlot:{start:at(2),end:at(7)}};
  const unmatched={...released,id:'outside',text:'After hours',completedPlannedSlot:{start:at(240),end:at(245)}};
  state.tasks=[replaced,second,next,unmatched];
  renderAgenda(state,context); renderWeek(state,context);
  const [replacement]=named('agenda','has-completed');
  assert.match(text(replacement),/Review samples.*Completed early.*Finish early.*Originally 9:00 AM–9:05 AM.*File a note/);
  assert.equal(named('agenda','completed-row').length,3);
  assert.equal(named('week-board','completed-row').length,3);
  assert.match(text(named('agenda','completed-section').at(-1)),/After hours/);
  assert.match(text(elements.get('agenda-summary')),/10m planned/);
  assert.match(text(named('agenda','agenda-free')[0]),/2h 50m/);
  state.tasks=[replaced]; renderAgenda(state,context);
  assert.match(text(named('agenda','has-completed')[0]),/Unallocated work time.*Completed early/);
  state.tasks=[{...released,allDay:true,startDate:day,endDate:'2026-12-02',hasCalendarEvent:true},past];
  renderAgenda(state,context);
  assert.equal(named('agenda','agenda-task').length,1);
  assert.equal(named('agenda','completed-row').length,1);
  state.tasks=[past]; renderAgenda(state,context); renderWeek(state,context);
  assert.equal(named('agenda','completed-section').length,0);
  assert.equal(named('week-board','completed-section').length,0);
  assert.equal(releasedCompletionDay({...released,completedDay:null,earliestDay:day,latestDay:day},'UTC'),day);
  assert.equal(releasedCompletionDay({...released,completedDay:null},'UTC'),'2026-11-30');
});

test('uses elapsed time across a clock change and only sizes the visible slice of overnight events', () => {
  const spring = {kind:'meeting',start:105,end:195,
    meeting:{start:'2026-03-08T01:45:00-08:00',end:'2026-03-08T03:15:00-07:00'}};
  assert.deepEqual(agendaBlockSize(spring,'2026-03-08','America/Los_Angeles'),size(30));
  const overnight = {kind:'meeting',start:0,end:5,meeting:{start:'2026-11-30T22:00:00Z',end:day+'T00:05:00Z'}};
  assert.deepEqual(agendaBlockSize(overnight,day,'UTC'),size(5));
});
