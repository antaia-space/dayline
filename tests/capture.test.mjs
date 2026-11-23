import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DaylineService } from '../src/service.mjs';
import { TaskAgents } from '../src/agents/manager.mjs';
import { defaultSettings } from '../src/store.mjs';
import { startServer } from '../src/http.mjs';

const picked={provider:'gemini',model:'gemini-4-hydrogen'};
const webRoot=fileURLToPath(new URL('../web/',import.meta.url));
const now=new Date('2026-11-23T08:00:00Z');
const id=n=>n.toString(16).padStart(32,'0');
async function paired(t,adapter) {
  const store={state:{version:1,settings:{...defaultSettings(),timeZone:'UTC'},accounts:[],tasks:[],agent:{...picked}},save(){}};
  const agents=new TaskAgents({store,adapters:{gemini:{estimate:adapter}}});
  const service=new DaylineService({store,vault:{},clock:()=>now});
  const app=await startServer({service,agents,webRoot,port:0,intervalMs:0});
  t.after(()=>app.close());
  const cookie=(await fetch(app.launchUrl(),{redirect:'manual'})).headers.get('set-cookie').split(';')[0];
  const send=(body,session=cookie)=>fetch(app.origin+'/api/capture',{method:'POST',
    headers:{cookie:session,origin:app.origin,'content-type':'application/json'},body:JSON.stringify(body)});
  return {service,agents,send,store};
}

test('the same composer captures a real-world to-do and moves an existing task without consulting a model', async t=>{
  const {service,send}=await paired(t,()=>assert.fail('A direct command used the subscription.'));
  const original=await service.createTask({text:'Clean up the test deployment for 30 minutes'});
  const fresh={text:'Move furniture to storage on Wednesday',requestId:id(1)};
  assert.equal((await send(fresh,'')).status,401);
  assert.equal((await send(fresh)).status,202);
  await service.whenEstimatesIdle();
  const request={text:'Move the clean up test deployment task to Wednesday',requestId:id(2),captureTimeZone:'UTC'};
  const moved=await (await send(request)).json();
  assert.equal(moved.status,'applied');
  assert.deepEqual(moved.taskIds,[original]);
  assert.match(service.findTask(original).start,/^2026-11-25T/);
  assert.equal(service.findTask(original).minutes,30);
  assert.equal(service.data.tasks.length,2);
  await send(request);
  assert.equal(service.data.tasks.length,2);
});

test('a slower subscription interpretation shares one call across retries without blocking other captures', async t=>{
  let release,enter;
  const entered=new Promise(resolve=>{enter=resolve;});
  const requests=[];
  const {service,send}=await paired(t,async request=>{
    requests.push(request);enter();await new Promise(resolve=>{release=resolve;});
    return {model:picked.model,usage:{inputTokens:181,outputTokens:24},output:{intent:'change',subject:'sample inventory',instruction:'Move the sample inventory task to Wednesday'}};
  });
  const original=await service.createTask({text:'Review the sample inventory'});
  const request={text:'Wednesday would work better for the sample inventory',requestId:id(3)};
  const first=send(request);
  await entered;
  const duplicate=send(request);
  // The subscription call has not finished. A new local capture still goes through immediately.
  const another=await send({text:'File the cabinet labels',requestId:id(4)});
  assert.equal(another.status,202);
  release();
  const [a,b]=await Promise.all([first,duplicate].map(async res=>(await res).json()));
  assert.deepEqual([a.status,b.status],['applied','applied']);
  assert.deepEqual(a.taskIds,[original]);
  assert.equal(a.agent.model,'gemini-4-hydrogen');
  assert.deepEqual(requests[0].input,{text:request.text,today:'2026-11-23',currentTime:'08:00',timeZone:'UTC'});
  assert.match(requests[0].instructions,/cannot execute actions/);
  assert.equal(requests.length,1);
  assert.equal((await (await send(request)).json()).status,'applied');
  assert.equal(requests.length,1);
  assert.equal(service.data.tasks.length,2);
});

test('an absent or ambiguous target never becomes a second task until explicitly requested',async t=>{
  const {service,send}=await paired(t,()=>assert.fail('Disambiguation should stay on this Mac.'));
  const a=await service.createTask({text:'Review invoices for the workshop'});
  const b=await service.createTask({text:'Review invoices for shipping'});
  const request={text:'Move the invoices task to Wednesday',requestId:id(5)};
  const choice=await (await send(request)).json();
  assert.equal(choice.status,'choice');
  assert.deepEqual(new Set(choice.choices.map(o=>o.id)),new Set([a,b]));
  assert.equal((await send({...request,chosenTaskId:id(123)})).status,409);
  const resolved=await (await send({...request,chosenTaskId:b})).json();
  assert.deepEqual(resolved.taskIds,[b]);
  assert.equal(service.data.tasks.length,2);
  const absent={text:'Move the telegraph task to Wednesday',requestId:id(6)};
  assert.equal((await (await send(absent)).json()).status,'unmatched');
  assert.equal(service.data.tasks.length,2);
  assert.equal((await send({...absent,forceCreate:true})).status,202);
  assert.equal((await send({...absent,forceCreate:true})).status,202);
  assert.equal(service.data.tasks.length,3);
});

test('an interpreter cannot introduce an unrelated subject or upgrade a single-task change to a bulk edit',async t=>{
  let reply={intent:'change',subject:'secret project',instruction:'Move the secret project task to Friday'};
  const {agents}=await paired(t,async()=>({model:picked.model,output:reply}));
  const phrase='Friday would work better for the inventory';
  let outcome=await agents.interpretCommand(phrase,{now,timeZone:'UTC'});
  assert.equal(outcome.intent,'clarify');
  reply={intent:'change',subject:'inventory',instruction:'Move all inventory tasks to Friday'};
  outcome=await agents.interpretCommand(phrase,{now,timeZone:'UTC'});
  assert.equal(outcome.intent,'clarify');
});

test('a paid clarification can be replayed after a restart or explicitly captured as new', async t=>{
  let calls=0;
  const {send,service,store}=await paired(t,async()=>{
    calls++; return {model:picked.model,output:{intent:'clarify',subject:'',instruction:''}};
  });
  const body={text:'I would rather do the inventory sooner',requestId:id(10)};
  assert.equal((await (await send(body)).json()).status,'clarify');
  assert.equal((await (await send(body)).json()).status,'clarify');
  assert.equal(calls,1);
  const restored=new DaylineService({store:{state:structuredClone(store.state),save(){}},clock:()=>now,vault:{}});
  assert.equal(restored.runPlannerCommand(body).kind,'clarification');
  assert.equal(service.data.tasks.length,0);
  assert.equal((await send({...body,forceCreate:true})).status,202);
  assert.equal(service.data.tasks.length,1);
});

test('the visible Tuesday presentation moves to real local today from the screenshot wording, including an explicitly retried old no-match', async t => {
  const { service, store, send } = await paired(t, () => assert.fail('Presentation matching must remain on this Mac.'));
  const incomplete = {text:'Move the Ic presnetation preparation to today', requestId:id(40),
    capturedAt:'2026-11-23T07:59:00.000Z', captureTimeZone:'UTC', contextDay:'2026-11-24'};
  const submit = async change => (await (await send({...incomplete,...change})).json());
  assert.equal((await submit({})).status,'unmatched');
  // Exercise a record saved by an earlier version, which had no contextDay.
  delete store.state.plannerCommands[incomplete.requestId].contextDay;
  const retry = {retryMatch:true,retryMatchId:id(50)};
  assert.equal((await submit(retry)).status,'unmatched');
  const text = 'Fill out IC presentation with all details and compare with Philip';
  const presentation = await service.createTask({text,day:'2026-11-24'});
  const original = structuredClone(service.findTask(presentation));
  const other = await service.createTask({text:'Buy markers tomorrow'});
  assert.equal((await submit({})).status,'unmatched');
  assert.equal((await submit(retry)).status,'unmatched');
  assert.match(service.findTask(presentation).start,/^2026-11-24T/);
  const second = {retryMatch:true,retryMatchId:id(51)};
  const applied = await submit(second);
  assert.deepEqual([applied.status,applied.taskIds],['applied',[presentation]]);
  const moved = service.findTask(presentation);
  assert.match(moved.start,/^2026-11-23T/);
  assert.deepEqual([moved.text,moved.minutes,moved.subtasks],[original.text,original.minutes,original.subtasks]);
  assert.equal((await submit(second)).status,'applied');
  assert.equal((await submit({})).status,'applied');
  assert.equal(store.state.tasks.length,2);
  assert.match(service.findTask(other).start,/^2026-11-24T/);
  const restarted = new DaylineService({ store:{state:structuredClone(store.state),save(){}}, clock:()=>now, vault:{} });
  assert.deepEqual(restarted.runPlannerCommand({...incomplete, ...second}).taskIds,[presentation]);
});
