import test from 'node:test';
import assert from 'node:assert/strict';
import {createChecklistEdits,checklistRequest,validSubtaskTitle} from '../web/checklist-edits.js';

function storage() {
  const entries = new Map();
  return {getItem:key=>entries.get(key),setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)};
}
const parent = 'task', id = 'a'.repeat(32), other = 'b'.repeat(32), requestId='c'.repeat(32);

test('builds guarded local requests and validates Unicode labels by character', () => {
  assert.deepEqual(checklistRequest({kind:'add',parent,id,title:'Collect notes'}),['/api/tasks/task/subtasks','POST',{id,title:'Collect notes'}]);
  assert.deepEqual(checklistRequest({kind:'rename',parent,id,title:'New',expectedTitle:'Old',requestId}),['/api/tasks/task/subtasks/'+id,'PATCH',{title:'New',expectedTitle:'Old',requestId}]);
  assert.deepEqual(checklistRequest({kind:'remove',parent,id,expectedTitle:'Old',requestId}),['/api/tasks/task/subtasks/'+id,'DELETE',{expectedTitle:'Old',requestId}]);
  assert.deepEqual(checklistRequest({kind:'toggle',parent,id,done:true,expectedDone:false,requestId}),['/api/tasks/task/subtasks/'+id,'PATCH',{done:true,expectedDone:false,requestId}]);
  assert.ok(validSubtaskTitle(' ✨ '.trim().repeat(160))); assert.ok(validSubtaskTitle('🎨'.repeat(160)));
  for (const name of ['', '  ', 'a\nb', 'one\u2028two', '🎨'.repeat(161)]) assert.equal(validSubtaskTitle(name),false);
});

test('rapid additions retain entry order and a failed request survives reload with the identical child ID',async () => {
  const saved=storage(), task={id:parent,subtasks:[]}, requests=[];
  let release, rejectFirst=true;
  const opts={storage:saved,refresh:async()=>{},changed(){},api:async (url,method,body)=>{
    requests.push({url,method,body:{...body}});
    if (rejectFirst) { rejectFirst=false; await new Promise(resolve=>{release=resolve;}); throw Error('Connection interrupted'); }
    task.subtasks.push({id:body.id,title:body.title,done:false});
  }};
  const first=createChecklistEdits(opts);
  const one=first.submit({parent,id,kind:'add',title:'Choose materials'});
  const two=first.submit({parent,id:other,kind:'add',title:'Reserve the room'});
  assert.deepEqual(first.items(task).map(row=>row.title),['Choose materials','Reserve the room']);
  await Promise.resolve(); assert.equal(requests.length,1);
  release();await Promise.all([one,two]);
  assert.deepEqual(requests.map(r=>r.body.id),[id,other]);
  assert.equal(first.items(task).find(row=>row.id===id).change.state,'failed');
  const reloaded=createChecklistEdits(opts);
  const retry=reloaded.retry(parent,id);
  assert.equal(reloaded.retry(parent,id),undefined);
  await retry;
  assert.deepEqual(requests[0],requests[2]);
  assert.equal(reloaded.items(task).filter(row=>row.change).length,0);
  assert.equal(task.subtasks.filter(row=>row.id===id).length,1);
});

test('a conflict preserves both names and exposes the server version after dismissal',async () => {
  const task={id:parent,subtasks:[{id,title:'Updated elsewhere',done:false}]};
  const edits=createChecklistEdits({changed(){},refresh:async()=>{},api:async()=>{throw Object.assign(Error('The name changed in another window.'),{status:409});}});
  await edits.submit({kind:'rename',parent,id,expectedTitle:'Original',title:'My draft'});
  const [row]=edits.items(task);
  assert.equal(row.title,'Updated elsewhere'); assert.equal(row.change.title,'My draft'); assert.equal(row.change.conflict,true);
  assert.equal(edits.retry(parent,id),undefined); edits.dismiss(parent,id);
  assert.deepEqual(edits.items(task),task.subtasks);
});

test('a lost receipt reuses the same guarded mutation ID and an acknowledged remote change stays authoritative',async()=>{
  let task={id:parent,subtasks:[{id,title:'Reserve the room',done:false}]},attempts=[];
  const edits=createChecklistEdits({changed(){},findTask:()=>task,refresh:async()=>{task=structuredClone(task);},
    api:async(_url,_method,body)=>{attempts.push({...body}); if(attempts.length===1)throw Error('Offline');}});
  await edits.submit({kind:'toggle',parent,id,done:true,expectedDone:false});
  assert.equal(edits.items(task)[0].change.state,'failed');
  await edits.retry(parent,id);
  assert.match(attempts[0].requestId,/^[a-f0-9]{32}$/); assert.deepEqual(attempts[0],attempts[1]);
  assert.deepEqual(edits.items(task),task.subtasks);
});
