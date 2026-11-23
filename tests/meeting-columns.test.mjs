import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAgenda, renderWeek } from '../web/views.js';
import { createMeetingFeed } from '../web/meetings.js';

const day='2026-11-23', next='2026-11-24', instant=time=>day+'T'+time+':00Z';
const event=(id,start,end,extra={})=>({id,title:'Meeting '+id,start:instant(start),end:instant(end),joinUrl:'https://meet.example.test/'+id,...extra});

function fixture(t) {
  class Element {
    constructor(tag) {
      Object.assign(this,{tag,children:[],className:'',dataset:{},attributes:{},textContent:'',style:{setProperty(key,value){this[key]=value;}}});
      this.classList={add:name=>{this.className+=' '+name;}};
    }
    setAttribute(key,value){this.attributes[key]=value;}
    append(...items){this.children.push(...items);}
    replaceChildren(...items){this.children=items;}
  }
  const elements=new Map(),previous=globalThis.document;
  const get=id=>{if(!elements.has(id))elements.set(id,Object.assign(new Element('div'),{id}));return elements.get(id);};
  globalThis.document={getElementById:get,createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),createTextNode:text=>Object.assign(new Element('text'),{textContent:text})};
  t.after(()=>{if(previous)globalThis.document=previous;else delete globalThis.document;});
  const state={settings:{timeZone:'UTC',workDays:[1,2,3,4,5],startTime:'09:00',endTime:'17:00',calendarMode:'availability',excludedCalendarIds:[]},
    now:instant('08:00'),tasks:[],categories:[],busy:[],busyStart:instant('00:00'),busyEnd:next+'T00:00Z',connection:{connected:true,accounts:[{sub:'fixture',mode:'availability',meetingDetails:true}]}};
  function render(events) {
    state.busy=events.filter(e=>!e.allDay && !e.transparent).map(({start,end})=>({start,end}));
    const context={monday:day,selected:day,today:day,events};
    renderAgenda(state,context); renderWeek(state,context);
  }
  return {get,state,render,surfaces:()=>[get('agenda'),get('week-board')]};
}
const nodes=root=>[root,...root.children.flatMap(nodes)];
const byClass=(root,cls)=>nodes(root).filter(n=>n.className.split(' ').includes(cls));
const action=(root,name)=>nodes(root).filter(n=>n.dataset.action===name);
const words=node=>nodes(node).map(n=>n.textContent).join(' ');
const idOf=card=>action(card,'meeting-details')[0].dataset.id;
const cards=root=>Object.fromEntries(byClass(root,'meeting-card').map(card=>[idOf(card),card]));
const interval=card=>card.style.gridRow.split('/').map(Number);

test('Day and Week align same starts, reuse the short lane, and keep adjacent and all-day meetings independent',t=>{
  const h=fixture(t),allDay=event('holiday','00:00','23:59',{allDay:true,startDate:day,endDate:next,transparent:true});
  const events=[event('A','09:00','10:00'),event('B','09:00','09:30'),event('C','09:30','10:00'),event('next','10:00','10:30'),allDay];
  h.render(events);
  for(const surface of h.surfaces()) {
    const groups=byClass(surface,'meeting-overlap'); assert.equal(groups.length,1);
    const [group]=groups, c=cards(group);
    assert.equal(group.attributes.role,'group'); assert.deepEqual(Object.keys(c).sort(),['A','B','C']);
    assert.notEqual(c.A.style.gridColumn,c.B.style.gridColumn); assert.equal(c.B.style.gridColumn,c.C.style.gridColumn);
    const [as,ae]=interval(c.A),[bs,be]=interval(c.B),[cs,ce]=interval(c.C);
    assert.ok(ae>as && be>bs && ce>cs); assert.deepEqual([as,be,ae],[bs,cs,ce]);
    assert.deepEqual(Object.keys(cards(surface)).sort(),['A','B','C','holiday','next']); assert.match(words(cards(surface).holiday),/All day/);
    for(const original of events) {
      const card=cards(surface)[original.id],triggers=action(card,'meeting-details'),links=byClass(card,'meeting-join');
      assert.equal(triggers.length,1); const [button]=triggers;
      assert.deepEqual([button.tag,button.attributes['aria-label'],button.attributes['aria-haspopup']],['button','Meeting details for '+original.title,'dialog']);
      assert.equal(links.length,1); assert.deepEqual([links[0].tag,links[0].href,links[0].target],['a',original.joinUrl,'_blank']);
    }
  }
  for(const summary of ['agenda-summary','week-summary']) assert.match(words(h.get(summary)),/5 meetings/);
});

test('staggered overlaps show their own times across three simultaneous meetings and preserve moved and released-completion actions',t=>{
  const h=fixture(t);
  h.state.tasks=[{id:'moved',title:'Moved review',text:'Moved review',done:false,minutes:10,start:next+'T09:00Z',end:next+'T09:10Z',
    movedSlots:[{id:'old',day,toDay:next,start:instant('09:28'),end:instant('09:38'),timeZone:'UTC'}]},
    {id:'done',text:'Early check',done:true,minutes:10,start:null,end:null,completedDay:day,completedPlannedSlot:{start:instant('09:40'),end:instant('09:50')}}];
  h.render([event('one','09:00','10:00'),event('two','09:15','10:20'),event('three','09:35','09:55',{transparent:true})]);
  for(const surface of h.surfaces()) {
    const [group]=byClass(surface,'meeting-overlap'),c=cards(group);
    assert.equal(new Set(Object.values(c).map(card=>card.style.gridColumn)).size,3);
    const [a,ae]=interval(c.one),[b,be]=interval(c.two),[d,de]=interval(c.three);
    assert.ok(a<b && b<d && d<de && de<ae && ae<be);
    assert.match(words(c.two),/9:15 AM/); assert.match(words(c.three),/9:35 AM/);
    assert.match(words(c.three),/Free/);
    assert.deepEqual(action(surface,'move-destination').map(n=>[n.dataset.id,n.dataset.day]),[['moved',next]]);
    assert.deepEqual(byClass(surface,'completed-row').map(row=>action(row,'toggle-task')[0].dataset.id),['done']);
    assert.equal(action(group,'move-destination').length,0);
  }
  assert.match(words(h.get('agenda')),/Originally 9:40 AM/);
});

test('pushing a moved or canceled meeting through the live feed rebuilds both views and drops its old controls',async t=>{
  const h=fixture(t),a=event('a','09:00','10:00'),early=event('b','10:00','10:30');
  let source=[a,early],calls=0,paints=0;
  const feed=createMeetingFeed({live:()=>true,read:async()=>{calls++;return {events:source,warnings:[]};},changed:()=>{paints++;h.render(feed.current.events);}});
  async function update(){feed.update(h.state,day,true);await new Promise(resolve=>setImmediate(resolve));}
  await update(); for(const surface of h.surfaces()) assert.equal(byClass(surface,'meeting-overlap').length,0);
  source=[a,event('b','09:20','09:45',{title:'Amended appointment',joinUrl:'https://meet.example.test/new-link'})];
  await update();
  for(const surface of h.surfaces()) {
    const [group]=byClass(surface,'meeting-overlap'),c=cards(group);
    assert.deepEqual(Object.keys(c).sort(),['a','b']);assert.match(words(c.b),/Amended appointment/);assert.equal(byClass(c.b,'meeting-join')[0].href,source[1].joinUrl);
  }
  source=[a]; await update();
  for(const surface of h.surfaces()) {assert.equal(byClass(surface,'meeting-overlap').length,0);assert.deepEqual(Object.keys(cards(surface)),['a']);assert.doesNotMatch(words(surface),/Amended appointment/);}
  assert.deepEqual([calls,paints],[3,3]);
});
