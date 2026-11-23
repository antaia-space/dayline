import assert from 'node:assert/strict';
import test from 'node:test';
import {createCalendarUpdates} from '../web/calendar-updates.js';
import {createMeetingFeed} from '../web/meetings.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
function setup(refresh = async () => {}) {
  let time=0,shown=true,id=0,checks=0,reads=0,invalidations=0;
  const streams=[],timers=new Map();
  const updates=createCalendarUpdates({open() {
    const listeners=new Map();
    const stream={readyState:1,closed:false,addEventListener:(name,handler)=>listeners.set(name,handler),
      close(){ this.closed=true; },emit(name,payload){ listeners.get(name)?.({data:JSON.stringify(payload)}); }};
    streams.push(stream);return stream;
  },refresh:async()=>{ reads++;await refresh(); },invalidate:()=>{ invalidations++; },check:async()=>{ checks++; },
  canCheck:()=>true,visible:()=>shown,now:()=>time,
  schedule:(fn,ms)=>{timers.set(++id,{fn,at:time+ms});return id;},cancel:key=>timers.delete(key)});
  async function advance(ms) {
    const end=time+ms;
    for (;;) {
      const first=[...timers.entries()].sort((a,b)=>a[1].at-b[1].at)[0];
      if (!first || first[1].at>end) break;
      timers.delete(first[0]);time=first[1].at;first[1].fn();await turn();
    }
    time=end;await turn();
  }
  return {updates,streams,advance,show:value=>{shown=value;},counts:()=>({checks,reads,invalidations})};
}

test('calendar revisions coalesce across a burst and require one follow-up if a read is already running',async () => {
  let release;
  const env=setup(()=>new Promise(resolve=>{release=resolve;}));
  env.updates.connect();const stream=env.streams[0];stream.emit('open');
  for (const revision of [0,0,2,1,'3',-1,2]) stream.emit('calendar',{revision});
  assert.deepEqual(env.counts(),{checks:0,reads:0,invalidations:2});
  await env.advance(50);
  stream.emit('calendar',{revision:3});stream.emit('calendar',{revision:4});
  await env.advance(500);
  assert.equal(env.counts().reads,1);
  release();await turn();await env.advance(50);
  assert.deepEqual(env.counts(),{checks:0,reads:2,invalidations:4});
  release();await turn();
  stream.emit('error');stream.emit('open');stream.emit('calendar',{revision:0});
  await env.advance(50);
  assert.equal(env.streams.length,1);assert.equal(env.counts().reads,3);
  assert.equal(env.counts().checks,1);
  release();
});

test('focus, visibility and online share one wake check, release hidden streams, and recover from a closed local connection',async () => {
  const env=setup();
  env.updates.wake();env.updates.wake();env.updates.wake();
  env.streams[0].emit('open');env.streams[0].emit('calendar',{revision:6});
  await env.advance(70);
  assert.equal(env.counts().checks,1);assert.equal(env.counts().reads,1);
  env.updates.poll();await env.advance(70);assert.equal(env.counts().checks,1);
  env.show(false);env.updates.sleep();assert(env.streams[0].closed);
  env.streams[0].emit('calendar',{revision:9});env.updates.poll();await env.advance(3000);
  assert.equal(env.counts().reads,2);
  env.show(true);env.updates.wake();env.streams[1].emit('open');env.streams[1].emit('calendar',{revision:6});
  await env.advance(70);assert.equal(env.counts().checks,2);assert.equal(env.counts().reads,3);
  env.streams[1].readyState=2;env.streams[1].emit('error');assert(!env.updates.connected);
  await env.advance(1010);assert.equal(env.streams.length,3);
  await env.advance(3000);env.updates.poll();await env.advance(55);assert.equal(env.counts().checks,3);
});

test('a connected window reads the visible week on invalidation, ignores stale responses and keeps identical content mounted',async () => {
  const state={connection:{connected:true,lastSync:'first',accounts:[{sub:'work',mode:'availability',meetingDetails:true}]},
    settings:{timeZone:'UTC',calendarMode:'availability',excludedCalendarIds:[]}};
  const calls=[];let paints=0,time=1000;
  const feed=createMeetingFeed({now:()=>time,live:()=>true,changed:()=>{paints++;},
    read:(url,signal)=>new Promise(resolve=>calls.push({url,signal,resolve}))});
  const monday='2026-11-23';
  feed.update(state,monday);feed.invalidate();assert(calls[0].signal.aborted);
  feed.update(state,monday);calls[1].resolve({events:[{id:'updated'}],warnings:[]});await turn();
  calls[0].resolve({events:[{id:'stale'}],warnings:[]});await turn();
  assert.equal(feed.current.events[0].id,'updated');assert.equal(paints,1);
  state.connection.lastSync='later';time+=120000;feed.update(state,monday);
  assert.equal(calls.length,2);
  feed.update(state,monday,true);calls[2].resolve({events:[{id:'updated'}],warnings:[]});await turn();
  assert.equal(paints,1);
});
