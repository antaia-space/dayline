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

test('a burst survives window restart and two windows deliver the three captures in order',async t => {
  const env = browser(t);
  const sends = [];
  let active = 0;
  const api = async (_url,method,body) => {
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
