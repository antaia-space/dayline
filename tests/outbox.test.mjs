import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureOutbox } from '../web/outbox.js';

class BrowserStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key,value) { this.values.set(key,String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function browser(t) {
  const timers = new Map();
  const held = new Set();
  let sequence = 0;
  const win = {
    localStorage:new BrowserStorage(), sessionStorage:new BrowserStorage(),
    addEventListener() {},
    setTimeout(fn) { timers.set(++sequence,fn); return sequence; },
    clearTimeout(id) { timers.delete(id); }
  };
  const previous = new Map(['window','navigator'].map(k => [k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  Object.defineProperty(globalThis,'window',{value:win,configurable:true});
  Object.defineProperty(globalThis,'navigator',{value:{locks:{async request(name,opts,run) {
    if (held.has(name)) return run(null);
    held.add(name);
    try { return await run({name}); } finally { held.delete(name); }
  }}},configurable:true});
  t.after(() => { for (const [key,descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
  }});
  return {win,timers,async tick() {
    const batch = [...timers.values()];
    timers.clear();
    await Promise.all(batch.map(fn => fn()));
  }};
}
const task = (id,text) => ({id:id.repeat(32),text,day:'2026-11-24',implicit:false,createdAt:1795500000000});
const make = api => createCaptureOutbox({api,onChange() {},onAccepted() {},onRemoteChange() {}});

test('an agent proposal survives a reload and only its exact reviewed plan can be applied',async t => {
  const env = browser(t), sent = [], entry={...task('6','Give the workshop a rehearsal'),askPlanner:true};
  const planId='8'.repeat(32);
  const api = async (_url,_method,body) => {
    sent.push(body);
    return body.applyPlanId ? {kind:'command',status:'applied',message:'Applied the change.',taskIds:[]} :
      {kind:'command',status:'preview',message:'Review one change.',planId,steps:['Add rehearsal to workshop.'],taskIds:[]};
  };
  const first=make(api);
  first.add(entry); await env.tick();
  const restored=make(api);
  assert.deepEqual(restored.entries()[0].command.steps,['Add rehearsal to workshop.']);
  assert.equal(restored.decide(entry.id,{applyPlanId:'9'.repeat(32)}),false);
  assert.equal(restored.decide(entry.id,{applyPlanId:planId}),true);
  await env.tick();
  assert.deepEqual(sent.map(body=>[body.askPlanner,body.applyPlanId]),[[true,undefined],[true,planId]]);
  assert.deepEqual(restored.entries(),[]);
});

test('a burst survives window restart and two windows deliver the three captures in order',async t => {
  const env = browser(t);
  const sends = [];
  let active = 0;
  const api = async (url,method,body) => {
    assert.equal(url,'/api/capture');
    assert.equal(method,'POST');
    sends.push(body.text);
    assert.equal(++active,1);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return {id:body.requestId};
  };
  const first = make(api);
  for (const [id,text] of [['f','First'],['1','Second'],['b','Third']]) assert.equal(first.add(task(id,text)),true);
  assert.deepEqual(sends,[]);
  assert.equal(first.entries().length,3);
  env.timers.clear(); // the originating window closes before its first network call
  const a = make(api), b = make(api);
  a.reconcile([]); b.reconcile([]);
  await env.tick();
  assert.deepEqual(sends,['First','Second','Third']);
  assert.deepEqual(a.entries(),[]);
});

test('replayed transport uses one capture id, retains explicit/implicit dates, and clears only acknowledged entries',async t => {
  const env = browser(t);
  const accepted = new Set(), calls = [];
  let lost = true;
  const outbox = make(async (_url,_method,body) => {
    calls.push(body); accepted.add(body.requestId);
    if (lost) { lost = false; throw new Error('Lost response'); }
    return {id:body.requestId};
  });
  const a = {...task('a','In the viewed day'),implicit:true,captureTimeZone:'America/Los_Angeles',provider:'codex',model:'gpt-6.2-sol',effort:'low'};
  const b = task('b','On an explicit date');
  outbox.add(a);outbox.add(b);
  await env.tick();
  assert.equal(outbox.entries().length,2);
  assert.equal(calls.length,1);
  assert.equal(outbox.entries()[0].problem,'Lost response');
  outbox.retry(a.id);await env.tick();
  assert.deepEqual(calls.map(c=>c.requestId),[a.id,a.id,b.id]);
  assert.equal(calls[0].viewDay,a.day);assert.equal(calls[0].day,undefined);
  assert.equal(calls[0].capturedAt,a.createdAt);assert.equal(calls[0].captureTimeZone,a.captureTimeZone);
  assert.deepEqual(calls[1].captureAgent,{provider:'codex',model:'gpt-6.2-sol',effort:'low'});
  assert.equal(calls[2].captureAgent,undefined);
  assert.equal(calls[2].day,b.day);assert.equal(calls[2].viewDay,undefined);
  assert.equal(accepted.size,2);assert.deepEqual(outbox.entries(),[]);
});

test('a definitive rejection retains the text and does not hold up valid captures',async t => {
  const env = browser(t);
  const rejected = task('c','Keep this text for correction'), valid = task('d','Valid task');
  const sends = [];
  const outbox = make(async (_url,_method,body) => {
    sends.push(body.requestId);
    if (body.requestId === rejected.id) throw Object.assign(new Error('Invalid date.'),{status:400});
    return {id:body.requestId};
  });
  outbox.add(rejected);outbox.add(valid);await env.tick();await env.tick();
  assert.deepEqual(sends,[rejected.id,valid.id]);
  assert.equal(outbox.entries()[0].text,rejected.text);
  assert.equal(outbox.entries()[0].blocked,true);
  outbox.reconcile([{id:rejected.id}]);
  assert.deepEqual(outbox.entries(),[]);
});

test('unresolved commands survive later entries and reload, and the selected task is replayed with the original capture',async t => {
  const env = browser(t), calls = [], seen = [];
  const change = {...task('a','Move the review to Friday'),implicit:true,contextDay:'2026-11-23',captureTimeZone:'UTC',provider:'gemini',model:'example-model'};
  const ordinary = task('b','Buy envelopes'), target = 'c'.repeat(32);
  const prompt = {kind:'command',status:'choice',message:'Which review?',choices:[{id:target,title:'Sample review',detail:'Tuesday at 09:00'}]};
  let loseReply = true;
  const api = async (url,_method,body) => {
    assert.equal(url,'/api/capture');
    calls.push(body);
    if (body.requestId===ordinary.id) return {id:ordinary.id};
    if (!body.chosenTaskId) return prompt;
    if (loseReply) { loseReply=false; throw new Error('Connection interrupted'); }
    return {kind:'command',status:'applied',message:'Moved the review to Friday.',taskIds:[target]};
  };
  const outbox = make(api);
  outbox.add(change);outbox.add(ordinary);await env.tick();await env.tick();
  assert.deepEqual(calls.map(body=>body.requestId),[change.id,ordinary.id]);
  assert.equal(calls[0].contextDay,'2026-11-23');assert.equal(calls[0].viewDay,change.day);
  assert.equal(outbox.entries()[0].text,change.text);
  assert.deepEqual(outbox.entries()[0].command.choices,prompt.choices);
  const next = createCaptureOutbox({api,onChange(){},onRemoteChange(){},onAccepted:(item,result)=>seen.push(result)});
  next.reconcile([{id:target}]);await env.tick();
  assert.equal(calls.length,2);
  assert.equal(next.decide(change.id,{chosenTaskId:'unknown'}),false);
  assert.equal(next.decide(change.id,{chosenTaskId:target}),true);
  assert.equal(next.decide(change.id,{forceCreate:true}),false);
  await env.tick();next.retry(change.id);await env.tick();
  assert.deepEqual(calls[2],{...calls[0],chosenTaskId:target});
  assert.deepEqual(calls[3],calls[2]);
  assert.deepEqual(seen.at(-1).taskIds,[target]);
  assert.deepEqual(next.entries(),[]);
});

test('visible-day matching stays independent of a date pin and retries one explicit rematch after a lost response',async t => {
  const env=browser(t),calls=[];
  const original={...task('a','Move the office review to Friday'),contextDay:'2026-11-23'};
  let loseReply=true;
  const outbox=make(async (_url,_method,body)=>{
    calls.push(body);
    if (body.retryMatch && loseReply) { loseReply=false;throw new Error('Lost confirmation'); }
    return {kind:'command',status:'unmatched',message:'Could not find that review.'};
  });
  outbox.add(original);await env.tick();
  const first=calls[0];
  assert.equal(first.contextDay,original.contextDay);assert.equal(first.day,original.day);
  assert.equal(first.retryMatch,undefined);assert.equal(first.retryMatchId,undefined);
  outbox.decide(original.id,{retryMatch:true});await env.tick();
  const second=calls[1];assert.match(second.retryMatchId,/^[0-9a-f]{32}$/);
  assert.deepEqual(second,{...first,retryMatch:true,retryMatchId:second.retryMatchId});
  outbox.retry(original.id);await env.tick();assert.deepEqual(calls[2],second);
  outbox.decide(original.id,{retryMatch:true});await env.tick();
  assert.notEqual(calls[3].retryMatchId,second.retryMatchId);
});

test('unmatched and clarification requests wait for an explicit create or an acknowledged revision',async t => {
  const env = browser(t), calls = [];
  const first=task('a','Move the missing item'), second=task('b','Make it shorter'), revised={...task('c','Shorten the sample review by five minutes'),revises:second.id};
  const api = async (_path,_method,body) => {
    calls.push(body);
    if (body.forceCreate) return {id:body.requestId};
    if (body.requestId===revised.id) return {kind:'command',status:'applied',message:'Shortened the review.'};
    return {kind:'command',status:body.requestId===first.id?'unmatched':'clarify',message:'Which item do you mean?'};
  };
  const queue=make(api);
  queue.add(first);queue.add(second);await env.tick();await env.tick();
  assert.deepEqual(queue.entries().map(item=>item.command.status),['unmatched','clarify']);
  assert.ok(calls.every(body=>!body.forceCreate));
  queue.decide(first.id,{forceCreate:true});queue.add(revised);
  assert.ok(queue.entries().some(item=>item.id===second.id));
  await env.tick();await env.tick();
  assert.deepEqual(calls[2],{...calls[0],forceCreate:true});
  assert.equal(calls[3].revises,undefined);
  assert.deepEqual(queue.entries(),[]);
});
