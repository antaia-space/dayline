import test from 'node:test';
import assert from 'node:assert/strict';
import { createCurrentTime,currentPosition,minuteTicker,timelineBlock } from '../web/current-time.js';

test('the active timed task wins an overlap; exact boundaries change tasks and elapsed/available segments use their own height',()=>{
  const task={kind:'task',from:-15,to:45,top:55,bottom:255};
  const meeting={kind:'meeting',from:-40,to:10,top:270,bottom:320};
  const gap={kind:'available',from:-10,to:10,top:10,bottom:50};
  assert.deepEqual(currentPosition([gap,meeting,task],true),{y:105,anchor:task,active:task});
  assert.equal(currentPosition([meeting],false).active,meeting);
  assert.equal(currentPosition([gap],true).y,30);
  const previous={...task,from:-60,to:0}, next={...task,from:0,to:60,top:310,bottom:350};
  assert.deepEqual(currentPosition([previous,next],true),{y:310,anchor:next,active:next});
});

test('compressed weeks place the marker between tasks, after all-day banners and around historical marker rows without assigning active work',()=>{
  const prior={kind:'task',from:-57,to:-17,top:10,bottom:90},later={kind:'task',from:34,to:54,top:150,bottom:190};
  const position=currentPosition([prior,later],true);assert.equal(position.y,110);assert.equal(position.active,undefined);
  const moved={kind:'point',from:-2,to:-2,top:95,bottom:123};
  assert.ok(currentPosition([prior,moved,later],true).y>moved.bottom);
  const completed={kind:'finished',from:-10,to:50,top:20,bottom:80};
  assert.equal(currentPosition([completed],true).active,undefined);
  const banner={kind:'banner',from:-900,to:200,top:25,bottom:65};
  assert.equal(currentPosition([banner],true).y,68);assert.equal(currentPosition([banner],false),null);
  assert.equal(currentPosition([],false),null);
});

test('the local minute timer aligns with the paired clock, skips missed minutes on wake, and sleeps without fetching or repainting an offscreen view',()=>{
  let wall=10000,visible=true,next=null,delay=0;
  const calls=[];
  const ticker=minuteTicker(when=>calls.push(when),{now:()=>wall,visible:()=>visible,
    schedule(fn,ms){next=fn;delay=ms;return 3;},cancel(){next=null;}});
  const source=Date.parse('2026-11-23T13:30:42.250Z');ticker.sync(source);
  assert.deepEqual(calls,[source]);assert.equal(delay,17750);
  wall+=delay;next();assert.equal(calls.at(-1),Date.parse('2026-11-23T13:31:00Z'));assert.equal(delay,60000);
  visible=false;ticker.wake();assert.equal(next,null);assert.equal(calls.length,2);
  wall+=5*3600000+3250;visible=true;ticker.wake();assert.equal(calls.length,3);assert.equal(delay,56750);
  assert.equal(calls.at(-1),Date.parse('2026-11-23T18:31:03.250Z'));
  ticker.stop();assert.equal(next,null);
});

function browser(t,day,zone){
  const saved=new Map();
  const replace=(key,value)=>{saved.set(key,globalThis[key]);globalThis[key]=value;};
  class Node {
    constructor(tag='div',top=0,height=0,left=20,right=420){
      Object.assign(this,{tag,children:[],dataset:{},className:'',attributes:{},style:{removeProperty(k){delete this[k];}},parentElement:null,rect:{top,bottom:top+height,height,left,right,width:right-left}});
      this.classList={add:k=>{this.className+=' '+k;},remove:k=>{this.className=this.className.split(' ').filter(c=>c!==k).join(' ');}};
    }
    append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}
    querySelectorAll(){return this.children.filter(n=>n.dataset.clockBlock);}
    getBoundingClientRect(){return this.rect;}
    getClientRects(){return [this.rect];}
    setAttribute(k,v){this.attributes[k]=v;}
    removeAttribute(k){delete this.attributes[k];}
    addEventListener(){}
  }
  const region=new Node('div',100,600,0,450);region.dataset.clockDay=day;
  const root=new Node(); root.querySelector=selector=>selector==='[data-clock-day="'+region.dataset.clockDay+'"]' ? region : null;
  replace('window',{addEventListener(){}});replace('document',{hidden:false,createElement:tag=>new Node(tag),addEventListener(){}});
  replace('ResizeObserver',class{observe(){} disconnect(){}});replace('getComputedStyle',node=>node.tracks);
  replace('setTimeout',()=>1);replace('clearTimeout',()=>{});
  t.after(()=>{for(const [key,value] of saved) {if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
  const renderer=createCurrentTime({root,getSettings:()=>({timeZone:zone,startTime:'00:00',endTime:'23:59',workDays:[1,2,3,4,5,6,7]})});
  return {region,renderer,block:(entry,top,height)=>{const n=timelineBlock(new Node('div',top,height),entry);region.append(n);return n;},line:()=>region.children.find(n=>n.className==='current-time-line')};
}

test('a repeated planner-local hour selects the correct absolute task, with one accessible marker and no highlight on another day',t=>{
  const h=browser(t,'2026-11-01','America/Los_Angeles');
  const task=(id,offset)=>({kind:'task',start:70,end:110,task:{id,title:id,start:'2026-11-01T01:10:00'+offset,end:'2026-11-01T01:50:00'+offset}});
  const first=h.block(task('First occurrence','-07:00'),140,80),second=h.block(task('Second occurrence','-08:00'),270,100);
  h.renderer.sync('2026-11-01T08:30:00Z');const line=h.line();
  assert.deepEqual([line.dataset.day,line.dataset.currentTime,line.dataset.currentTask],['2026-11-01','01:30','First occurrence']);
  assert.ok(Math.abs(parseFloat(line.style.top)-80)<.1);assert.equal(first.attributes['aria-current'],'time');
  h.renderer.sync('2026-11-01T09:30:00Z');assert.equal(h.line(),line);assert.equal(line.dataset.currentTask,'Second occurrence');
  assert.equal(first.attributes['aria-current'],undefined);assert.equal(second.attributes['aria-current'],'time');
  assert.ok(Math.abs(parseFloat(line.style.top)-220)<.1);assert.match(line.attributes['aria-label'],/Current time .*Second occurrence/);
  assert.equal(line.children.filter(n=>n.className==='current-time-dot').length,1);
  h.renderer.sync('2026-11-02T08:10:00Z');assert.equal(h.line(),undefined);assert.equal(second.attributes['aria-current'],undefined);
});

test('staggered meetings use the measured pixel tracks and row gaps of their scrollable grid, independent of card text length',t=>{
  const h=browser(t,'2026-11-23','UTC'),base=Date.parse('2026-11-23T09:00:00Z');
  const group=h.block({kind:'overlap',start:540,end:600,cells:[{from:base,to:base+40*60000},{from:base+20*60000,to:base+60*60000}]},150,120);
  group.tracks={gridTemplateRows:'22px 60px 30px',rowGap:'4px'};
  h.renderer.sync('2026-11-23T09:30:00Z');const line=h.line();
  assert.ok(Math.abs(parseFloat(line.style.top)-106)<.1);assert.equal(line.dataset.currentTask,undefined);
  assert.equal(line.style.left,'20px');assert.equal(line.style.right,'30px');
});
