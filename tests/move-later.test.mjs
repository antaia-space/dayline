import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { DaylineService } from '../src/service.mjs';
import { defaultSettings } from '../src/store.mjs';
import { startServer } from '../src/http.mjs';
import { applyAgentPlan, createPlanContext, previewAgentPlan } from '../src/agent-plan.mjs';

const monday='2026-11-23', tuesday='2026-11-24', wednesday='2026-11-25', saturday='2026-11-28';
const id=n=>n.toString(16).padStart(32,'0');
const at=(day,time,zone='UTC')=>DateTime.fromISO(day+'T'+time,{zone}).toUTC().toISO();
const pick=(task,day,n)=>({day,requestId:id(n),sourceStart:task.start,sourceEnd:task.end});
const webRoot=fileURLToPath(new URL('../web/',import.meta.url));

function fixture({saved,google,zone='UTC',now=at(monday,'08:00',zone)}={}) {
  const store={state:saved ? structuredClone(saved) : {version:1,settings:{...defaultSettings(),timeZone:zone},accounts:[],tasks:[]},writes:0,
    save(){if(this.fail) throw new Error('No disk available'); this.writes++; this.saved=structuredClone(this.state);}};
  const h={now,store};
  const s=h.s=new DaylineService({store,google,clock:()=>new Date(h.now),bundledClient:{clientId:'fixture'},vault:{open:v=>v}});
  h.add=async(n,title,day=monday,note=title+' for 30 minutes')=>{
    const taskId=await s.createTask({requestId:id(n),text:note,day}); await s.editTask(taskId,{title}); return s.findTask(taskId);
  };
  h.safe=task=>s.snapshot().tasks.find(row=>row.id===task.id);
  h.move=(task,body)=>s.run(()=>s.moveTaskLater(task.id,body));
  h.chat=(n,text)=>s.run(()=>s.runPlannerCommand({requestId:id(n),text}));
  return h;
}

test('a paired move preserves the old wall clock and the one real task, is nonblocking, and survives restart, further moves and an old browser replay',async t=>{
  const zone='America/Los_Angeles',h=fixture({zone});
  const task=await h.add(1,'Launch review'),neighbor=await h.add(2,'Buy supplies',tuesday);
  task.subtasks=[{id:id(50),title:'Collect data',done:true},{id:id(51),title:'Sign off',done:false}];
  task.overrunMinutes=5; task.end=at(monday,'09:35',zone); task.overrunWatchStart=task.start;
  const input=pick(task,tuesday,100); h.now=at(monday,'09:34',zone);
  assert.equal(h.safe(task).canMoveLater,false);
  h.now=at(monday,'09:35',zone); assert.equal(h.safe(task).canMoveLater,true);
  const server=await startServer({service:h.s,webRoot,port:0,intervalMs:0});t.after(()=>server.close());
  const pair=async()=>(await fetch(server.launchUrl(),{redirect:'manual'})).headers.get('set-cookie').split(';')[0];
  const post=(cookie,body,origin=server.origin)=>fetch(server.origin+'/api/tasks/'+task.id+'/move-later',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const [desktop,browser]=await Promise.all([pair(),pair()]);
  assert.equal((await post('',input)).status,401); assert.equal((await post(desktop,input,'https://example.test')).status,403);
  const receipts=await Promise.all([post(desktop,input),post(browser,input)]);
  assert.deepEqual(receipts.map(r=>r.status),[200,200]);
  const [receipt,duplicate]=await Promise.all(receipts.map(r=>r.json())); assert.deepEqual(receipt,duplicate);
  const marker=receipt.movedSlot;
  assert.deepEqual(marker,{id:marker.id,start:at(monday,'09:00',zone),end:at(monday,'09:35',zone),day:monday,toDay:tuesday,movedAt:h.now,timeZone:zone});
  assert.match(marker.id,/^[a-f0-9]{32}$/); assert.equal(h.safe(task).canMoveLater,false);
  assert.deepEqual(h.safe(task).movedSlots,[marker]); assert.deepEqual([task.id,task.text,task.minutes,task.start,task.end,neighbor.start,task.overrunMinutes],
    [id(1),'Launch review for 30 minutes',30,at(tuesday,'09:00',zone),at(tuesday,'09:30',zone),at(tuesday,'09:30',zone),undefined]);
  assert.deepEqual(task.subtasks.map(s=>s.done),[true,false]); assert.equal(h.s.data.tasks.length,2);
  assert.ok(!h.s.localBusy().some(range=>range.start===marker.start));
  const nextTime=at(tuesday,'10:00',zone),restarted=fixture({saved:h.store.saved,zone,now:nextTime});
  const same=restarted.s.findTask(task.id),second=pick(same,wednesday,101),receipt2=await restarted.move(same,second);
  assert.deepEqual((await restarted.move(same,input)),receipt);
  assert.notEqual(receipt2.movedSlot.id,marker.id); assert.deepEqual(restarted.safe(same).movedSlots.map(m=>[m.day,m.toDay]),[[monday,tuesday],[tuesday,wednesday]]);
  assert.deepEqual([same.start,same.end],[at(wednesday,'09:00',zone),at(wednesday,'09:30',zone)]);
  await assert.rejects(restarted.move(same,{...input,requestId:id(102)}),/scheduled time changed/);
  await assert.rejects(restarted.move(same,{...input,day:wednesday}),/different move/);
  await restarted.s.editTask(same.id,{done:true}); assert.equal(restarted.safe(same).movedSlots.length,2);
  await restarted.s.editTask(same.id,{done:false}); assert.equal(restarted.safe(same).movedSlots.length,2); assert.equal(restarted.s.data.tasks.length,2);
});

test('picker guards stale windows, complete/new/ongoing/held/shared appointments, prior dates and disk failure without partial history',async()=>{
  const h=fixture(),task=await h.add(1,'Atlas'); const body=pick(task,tuesday,10);
  await assert.rejects(h.move(task,body),/scheduled time changed/);
  h.now=at(monday,'09:20'); await assert.rejects(h.move(task,body),/scheduled time changed/);
  h.now=at(tuesday,'11:00');
  for(const fields of [{held:true},{done:true},{pendingEstimate:true},{deleting:true},{intent:{}},{estimateJob:{}},
    {kind:'meeting'}, {remote:{calendarAppointment:true}}, {remote:{allDay:true}}, {pausedSync:{remote:{manualTime:true}}}]) {
    const previous=Object.fromEntries(Object.keys(fields).map(k=>[k,task[k]])); Object.assign(task,fields);
    assert.equal(h.safe(task).canMoveLater,false); await assert.rejects(h.move(task,body),/scheduled time changed/);
    for(const [k,v] of Object.entries(previous)) { if(v===undefined) delete task[k]; else task[k]=v; }
  }
  await assert.rejects(h.move(task,{...body,sourceStart:at(monday,'08:59')}),/scheduled time changed/);
  await assert.rejects(h.move(task,{...body,day:monday}),/after the original/);
  h.now=at(wednesday,'11:00'); await assert.rejects(h.move(task,body),/today or a future/);
  await assert.rejects(h.move(task,{...body,sourceStart:undefined}),/valid later day/);
  const old=structuredClone(task); h.store.fail=true;
  await assert.rejects(h.move(task,{...body,day:wednesday}),/No disk available/); assert.deepEqual(task,old);
  h.store.fail=false; await h.move(task,{...body,day:wednesday}); assert.deepEqual(h.safe(task).movedSlots.map(m=>m.day),[monday]);
  assert.equal(task.start,at(wednesday,'11:00'));
});

test('editor, deterministic chat and reviewed agent moves retain elapsed slots only on explicit later dates; canceling the preview, a future move and other edits create no history',async()=>{
  const h=fixture(),task=await h.add(1,'Atlas migration'),future=await h.add(2,'Payroll',tuesday),ordinary=await h.add(3,'Permits');
  h.now=at(monday,'11:00');
  await h.s.editTask(ordinary.id,{title:'New permits',minutes:35}); assert.deepEqual(h.safe(ordinary).movedSlots,[]);
  await h.s.editTask(future.id,{day:wednesday}); assert.deepEqual(h.safe(future).movedSlots,[]);
  await h.s.editTask(task.id,{day:tuesday}); assert.equal(task.movedSlots.length,1); assert.equal(task.start,at(tuesday,'09:00'));
  h.now=at(tuesday,'10:00'); const command='Move the Atlas migration to Wednesday';
  const c=await h.chat(20,command); assert.equal(c.kind,'applied',c.message); assert.deepEqual(await h.chat(20,command),c);
  assert.equal(task.movedSlots.length,2);
  h.now=at(wednesday,'14:00');
  const input={requestId:id(21),text:'Give the Atlas migration a weekend slot',contextDay:wednesday}, ctx=createPlanContext(h.s,input);
  const alias=Object.keys(ctx.bindings.targets).find(k=>ctx.bindings.targets[k].id===task.id);
  const p=previewAgentPlan(h.s,input,ctx,[{op:'update',task:alias,day:saturday}]);
  assert.equal(p.kind,'preview',p.message); assert.match(p.steps[0],/marked Moved/); assert.equal(task.movedSlots.length,2);
  const restart=fixture({saved:h.store.saved,now:h.now}); const active=restart.s.findTask(task.id);
  assert.equal(active.movedSlots.length,2);
  const done=await restart.s.run(()=>applyAgentPlan(restart.s,{...input,planId:p.planId})); assert.equal(done.kind,'applied',done.message);
  assert.equal(active.movedSlots.length,3); assert.deepEqual([active.start,active.earliestDay,active.latestDay,active.syncStatus],[null,saturday,saturday,'attention']);
  assert.equal(restart.s.data.tasks.length,3);
  await restart.s.queueSync(); assert.equal(active.movedSlots.length,3);
});

test('today can be selected for yesterday even when its workday is full or has ended; moving to a non-work day also keeps the requested date',async()=>{
  const h=fixture(),a=await h.add(1,'Atlas'),b=await h.add(2,'Payroll'); h.now=at(tuesday,'18:00');
  await h.move(a,pick(a,tuesday,30)); await h.move(b,pick(b,saturday,31));
  assert.deepEqual([a.start,a.earliestDay,a.movedSlots[0].toDay,b.start,b.earliestDay,b.movedSlots[0].toDay],[null,tuesday,tuesday,null,saturday,saturday]);
});

test('read-only calendars supply fresh availability at the destination and never receive a history event or any writes',async()=>{
  const calls=[],writes=[]; let occupied=true;
  const google={refreshToken:({refreshToken})=>({access_token:refreshToken,expires_in:3600}),listCalendars:t=>[{id:t,name:t,primary:true,writable:false}],
    getBusy(token){calls.push(token);return occupied && token==='home' ? [{start:at(tuesday,'09:00'),end:at(tuesday,'10:40')}] : [];},
    putTaskEvent(...args){writes.push(args);},deleteTaskEvent(...args){writes.push(args);}};
  const h=fixture({google}),task=await h.add(1,'Atlas');
  h.now=at(monday,'10:00'); h.s.data.accounts=['home','work'].map(sub=>({sub,email:sub+'@example.test',secret:sub,mode:'availability'}));
  const request=pick(task,tuesday,40); await h.move(task,request);
  assert.equal(task.start,null); assert.equal(task.syncStatus,'pending');
  await h.s.queueSync(); assert.equal(task.start,at(tuesday,'10:40')); assert.deepEqual(new Set(calls),new Set(['home','work']));
  occupied=false; await h.s.queueSync(); assert.equal(task.start,at(tuesday,'09:00')); assert.deepEqual(writes,[]);
  assert.equal(h.s.data.tasks.length,1); assert.equal(h.safe(task).movedSlots.length,1);
});
