import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { subtaskLabels } from '../src/subtasks.mjs';
import { DaylineService } from '../src/service.mjs';
import { defaultSettings } from '../src/store.mjs';
import { estimateTask } from '../src/planner.mjs';
import { TaskAgents, estimateSchema } from '../src/agents/manager.mjs';
import { startServer } from '../src/http.mjs';

const at = clock => new Date('2026-11-23T' + clock + ':00.000Z');
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const note = 'I need to clean out Morgan from google workspace, github, the pitchdeck and github';
const labels = ['Google Workspace', 'GitHub', 'pitch deck'];
const fixture = (tasks = []) => {
  const store = { state: { version: 1, settings: { ...defaultSettings(), timeZone: 'UTC' }, accounts: [], tasks },
    save() { this.saved = structuredClone(this.state); } };
  return { store, vault: {}, clock: () => at('08:00') };
};

test('explicit components become distinct checkboxes, and a single joint activity stays one task', () => {
  assert.deepEqual(subtaskLabels(note), labels);
  assert.deepEqual(subtaskLabels('Remove Robin from Inventory, Print Queue, and Reports'), ['Inventory','Print Queue','Reports']);
  assert.deepEqual(subtaskLabels('Pack a notebook and a charger for tomorrow'), ['notebook','charger']);
  assert.deepEqual(subtaskLabels('Agenda:\n- Opening remarks\n- Product demo\n- Wrap-up'), ['Opening remarks','Product demo','Wrap-up']);
  assert.deepEqual(subtaskLabels('Draft the flyer and send the invoice').map(s => s.toLowerCase()), ['draft the flyer','send the invoice']);
  assert.deepEqual(subtaskLabels('Meet Sam and Lee at 11:00',['Meet Sam','Meet Lee']), []);
  assert.deepEqual(subtaskLabels('Mow the lawn',['Gather supplies','Review results']), []);
  assert.deepEqual(subtaskLabels('Resolver primero nóminas, después facturas',['Nóminas','Facturas']), ['Nóminas','Facturas']);
});

test('the subscription agent captures the checklist in its single original estimate', async () => {
  const config = fixture();
  let calls = 0;
  const agents = new TaskAgents({store:config.store, adapters:{gemini:{estimate: async request => {
    calls++;
    assert.equal(request.model,'gemini-4-hydrogen');
    assert.deepEqual(request.schema.properties.subtasks,{type:'array',items:{type:'string'}});
    assert.ok(estimateSchema.required.includes('subtasks'));
    assert.match(request.instructions,/independently checkable/);
    return {model:request.model,usage:{outputTokens:22},output:{title:'Organiser le dossier',category:'admin',
      minutes:25,reason:'Review the two items.',earliestDay:null,latestDay:null,windowStart:null,windowEnd:null,deadlineTime:null,
      subtasks:['Factures','Contrats']}};
  }}}});
  agents.select({provider:'gemini',model:'gemini-4-hydrogen'});
  const service = new DaylineService({...config, estimate:(text,context)=>agents.estimate(text,context)});
  const id = await service.createTask({text:'Organiser le dossier avec factures et contrats'});
  const task = service.findTask(id);
  assert.deepEqual(task.subtasks.map(s => s.title),['Factures','Contrats']);
  assert.equal(task.agent.model,'gemini-4-hydrogen');
  service.setSubtaskDone(id,task.subtasks[0].id,true);
  assert.equal(calls,1);
  assert.equal(service.findTask(id).minutes,25);
});

test('existing tasks gain checkboxes offline and paired clients share partial progress, release and reopening', async t => {
  const config = fixture();
  const initial = new DaylineService(config);
  const id = await initial.createTask({text:note});
  const next = await initial.createTask({text:'Other task for 10 minutes'});
  const { start } = initial.findTask(id);
  delete initial.findTask(id).subtasks;
  const service = new DaylineService({...config,estimate(){assert.fail('Checking a subtask called the model.');}});
  const ids = service.findTask(id).subtasks.map(s => s.id);
  assert.deepEqual(config.store.saved.tasks.find(t => t.id === id).subtasks.map(s=>s.title),labels);
  const app = await startServer({service,webRoot,port:0,intervalMs:0});
  t.after(()=>app.close());
  const pair = async () => (await fetch(app.launchUrl(),{redirect:'manual'})).headers.get('set-cookie').split(';')[0];
  const desktop = await pair(), browser = await pair();
  const patch = (child,body,cookie=desktop) => fetch(app.origin+'/api/tasks/'+id+(child?'/subtasks/'+child:''),{
    method:'PATCH',headers:{cookie,origin:app.origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const read = async () => (await (await fetch(app.origin+'/api/state',{headers:{cookie:browser}})).json()).tasks;
  const get = async () => (await read()).find(t=>t.id===id);
  assert.equal((await patch(ids[0],{done:true},'')).status,401);
  assert.equal((await patch('f'.repeat(32),{done:true})).status,404);
  assert.equal((await patch(ids[0],{done:1})).status,400);
  assert.equal((await patch(ids[0],{done:true})).status,200);
  assert.equal((await patch(ids[0],{done:true},browser)).status,200);
  let task = await get();
  assert.equal(task.done,false);
  assert.equal(task.start,start);
  assert.deepEqual(task.subtasks.map(s=>s.done),[true,false,false]);
  await Promise.all([patch(ids[1],{done:true},desktop),patch(ids[2],{done:true},browser)]);
  task = await get();
  assert.equal(task.done,true);
  assert.equal(task.start,null);
  assert.equal(task.completedPlannedSlot.start,start);
  assert.equal(task.completedDay,'2026-11-23');
  assert.equal((await read()).find(t=>t.id===next).start,start);
  await patch(ids[1],{done:false},browser);
  task = await get();
  assert.equal(task.done,false);
  assert.ok(task.start);
  assert.equal(task.completedPlannedSlot,undefined);
  assert.deepEqual(task.subtasks.map(s=>s.done),[true,false,true]);
  await patch(null,{done:true});
  assert.ok((await get()).subtasks.every(s=>s.done));
  await patch(null,{done:false});
  assert.ok((await get()).subtasks.every(s=>!s.done));
  const restored = new DaylineService({...config,store:{state:structuredClone(config.store.saved),save(){}}});
  assert.deepEqual(restored.findTask(id).subtasks, (await get()).subtasks);
});

test('edits retain checkmarks for matching items, remove obsolete ones, and roll back a failed save', async () => {
  const config = fixture();
  const service = new DaylineService(config);
  const id = await service.createTask({text:'Pack pens, paper and stamps'});
  const child = service.findTask(id).subtasks[1];
  service.setSubtaskDone(id,child.id,true);
  await service.editTask(id,{text:'Pack paper, clips and stamps'});
  const edited = service.findTask(id);
  assert.deepEqual(edited.subtasks.map(s=>s.title),['paper','clips','stamps']);
  assert.deepEqual(edited.subtasks[0],{...child,done:true});
  config.store.save = () => { throw new Error('disk is full'); };
  assert.throws(()=>service.setSubtaskDone(id,child.id,false),/disk is full/);
  assert.equal(service.findTask(id).subtasks[0].done,true);
});

test('checkmarks made during background estimation survive its asynchronous reply', async () => {
  const config = fixture();
  let reply, signal;
  const started = new Promise(resolve => { signal=resolve; });
  const service = new DaylineService({...config,estimate:(text,context) => new Promise(resolve=>{
    reply=()=>resolve(estimateTask(text,context)); signal();
  })});
  const id = service.enqueueTask({text:note});
  service.startEstimateWorker();
  await started;
  const github = service.findTask(id).subtasks[1];
  service.setSubtaskDone(id,github.id,true);
  reply();
  await service.estimateWorker;
  assert.deepEqual(service.findTask(id).subtasks[1],{...github,done:true});
  assert.ok(service.findTask(id).start);
});
