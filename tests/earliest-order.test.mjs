import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureHandler } from '../src/capture.mjs';
import { createPlanContext, previewAgentPlan, applyAgentPlan } from '../src/agent-plan.mjs';
import { TaskAgents } from '../src/agents/manager.mjs';
import { estimateTask } from '../src/planner.mjs';
import { parsePlannerCommand } from '../src/planner-commands.mjs';
import { DaylineService } from '../src/service.mjs';
import { defaultSettings } from '../src/store.mjs';
import { asksForEarliest } from '../src/start-preference.mjs';

const day = '2026-11-24', previousDay = '2026-11-23';
const at = (time, date = day) => `${date}T${time}:00.000Z`;
const id = n => n.toString(16).padStart(32,'0');
const note = 'call hotel tomorrow morning to ask about a conference room - 10 min - as early in the day as possible, because of timezone difference';
const deck = 'Prepare the presentation tomorrow for 60 minutes';
const meeting = {start:at('10:30'),end:at('11:00')};
const request = (n,text) => ({requestId:id(n),text});

function fixture({ saved, connected = false, busy = [meeting], now = at('12:00',previousDay) } = {}) {
  const state = saved ? structuredClone(saved) : {version:1,tasks:[],accounts:connected ? [{sub:'work',mode:'availability',secret:'synthetic'}] : [],
    settings:{...defaultSettings(),timeZone:'UTC',startTime:'08:30'}};
  const h = {state, busy, reads:0, estimates:[]};
  const store = {state, save() { h.saved = structuredClone(state); }};
  const google = {refreshToken:async()=>({access_token:'synthetic'}),listCalendars:async()=>[{id:'work',name:'Work',primary:true,writable:false}],
    getBusy:async()=>{h.reads++; return h.busy;}};
  h.service = new DaylineService({store,google,clock:()=>new Date(now),vault:{open:val=>val},bundledClient:{clientId:'fixture'},
    estimate(text,context) { h.estimates.push(text); return {...estimateTask(text,context),title:text===note ? 'Call hotel' : undefined}; }});
  h.starts = (...numbers) => numbers.map(n => h.service.findTask(id(n)).start);
  return h;
}

test('an earliest-morning capture moves ahead of flexible work within verified Google availability and preserves estimate FIFO', async () => {
  const h=fixture({connected:true});
  const capture=createCaptureHandler(h.service,null);
  assert.deepEqual(await capture(request(1,deck)),{id:id(1)});
  assert.deepEqual(await capture(request(2,note)),{id:id(2)});
  h.service.startEstimateWorker(); await h.service.whenEstimatesIdle();
  assert.deepEqual(h.estimates,[deck,note]);
  assert.equal(h.service.error,null);
  assert.deepEqual(h.starts(2,1),[at('08:30'),at('08:40')]);
  const hotel=h.service.findTask(id(2));
  assert.deepEqual([hotel.text,hotel.minutes,hotel.earliestDay,hotel.latestDay,hotel.windowEnd],[note,10,day,day,'12:00']);
  h.busy=[{start:at('08:30'),end:at('09:00')},meeting]; await h.service.queueSync();
  assert.deepEqual(h.starts(2,1),[at('09:00'),at('09:10')]);
  assert.deepEqual(h.estimates,[deck,note]); assert.ok(h.reads>=2);
  h.service.stopEstimateWorker();
});

test('an older saved note repairs the actual order once, and a newer manual order survives restart and subsequent checks', async () => {
  const original=fixture({connected:true});
  await original.service.createTask(request(1,deck)); await original.service.createTask(request(2,note));
  const old=original.state.tasks.sort((a,b)=>a.id.localeCompare(b.id));
  Object.assign(old[0],{start:at('08:30'),end:at('09:30')});
  Object.assign(old[1],{start:at('09:30'),end:at('09:40')}); delete old[1].startOrder;
  const h=fixture({saved:original.state}); await h.service.queueSync();
  assert.deepEqual(h.starts(2,1),[at('08:30'),at('08:40')]);
  h.service.reorderTask(id(2),{placement:'after',targetId:id(1),day});
  await h.service.queueSync(); assert.deepEqual(h.starts(1,2),[at('08:30'),at('09:30')]);
  const restarted=fixture({saved:h.saved}); await restarted.service.queueSync();
  assert.deepEqual(restarted.starts(1,2),h.starts(1,2));
  assert.deepEqual([h.estimates,restarted.estimates],[[],[]]);
  // Old builds timestamped the dragged presentation even if the call was the other row.
  old[0].orderRequestedAt=at('12:30',previousDay);
  const manual=fixture({saved:original.state}); await manual.service.queueSync();
  assert.deepEqual(manual.starts(1,2),[at('08:30'),at('09:30')]);
  // A verified drag on another day does not suppress the original early request.
  original.state.tasks.unshift({...old[0],id:id(7),start:at('13:00',previousDay),end:at('14:00',previousDay),
    earliestDay:null,latestDay:null,orderRequestedAt:at('12:30',previousDay)});
  delete original.state.tasks.find(t=>t.id===id(1)).orderRequestedAt;
  const separate=fixture({saved:original.state}); await separate.service.queueSync();
  assert.deepEqual(separate.starts(2,1),[at('08:30'),at('08:40')]);
});

test('absolute top and an existing-task command use the same protected day order, even with no eligible target peer', async () => {
  const h=fixture();
  for(const [n,text] of [[1,'Check in tomorrow at 08:30 for 15 minutes'],[2,deck],[3,'Call hotel tomorrow for 10 minutes']]) await h.service.createTask(request(n,text));
  await h.service.editTask(id(3),{title:'Hotel call'});
  const capture=createCaptureHandler(h.service,null);
  const input=request(4,'Move the hotel call to first thing');
  const result=await capture(input);
  assert.equal(result.status,'applied',result.message); assert.deepEqual(result.taskIds,[id(3)]);
  assert.deepEqual(h.starts(1,3,2),[at('08:30'),at('08:45'),at('08:55')]);
  assert.deepEqual(await capture(input),result);
  for (const text of ['I would like the hotel call to be as early as possible','Could the hotel call go first thing?', 'The hotel call should be the first available slot']) {
    const phrasing=await capture({text,requestId:id(20+text.length)});
    assert.equal(phrasing.status,'applied',phrasing.message); assert.deepEqual(phrasing.taskIds,[id(3)]);
  }
  h.service.reorderTask(id(3),{targetId:id(2),placement:'after',day});
  h.service.reorderTask(id(3),{placement:'first',day});
  assert.deepEqual(h.starts(1,3,2),[at('08:30'),at('08:45'),at('08:55')]);
  assert.throws(()=>h.service.reorderTask(id(1),{placement:'first',day}),{status:409});
  assert.throws(()=>h.service.reorderTask(id(3),{placement:'first',day:previousDay}),{status:409});
  const next=await capture(request(5,'Move the hotel call to Wednesday first thing'));
  assert.equal(next.status,'applied',next.message); assert.equal(h.service.findTask(id(3)).start,at('08:30','2026-11-25'));
  h.service.reorderTask(id(3),{placement:'first',day:'2026-11-25'});
  assert.equal(h.service.findTask(id(3)).start,at('08:30','2026-11-25')); assert.equal(h.estimates.length,3);
});

test('early notes tie in capture order, a later edit can request priority and ordinary early-related work stays flexible', async () => {
  const h=fixture();
  for(const [n,text] of [[1,deck],[2,note],[3,'Call the florist first thing tomorrow for 10 minutes'],[4,'Ask the cafe about early check-in tomorrow for 10 minutes']]) await h.service.createTask(request(n,text));
  assert.deepEqual(h.starts(2,3,1,4),[at('08:30'),at('08:40'),at('08:50'),at('09:50')]);
  await h.service.editTask(id(4),{text:'Ask the cafe tomorrow ASAP for 10 minutes'});
  assert.deepEqual(h.starts(2,3,4,1),[at('08:30'),at('08:40'),at('08:50'),at('09:00')]);
  for(const negative of ['Ask about early check-in','Buy the first thing on the list','Ask which first thing guests notice','Prepare the materials, not ASAP','Reply, no need to do it first thing']) {
    assert.equal(asksForEarliest(negative),false,negative);
  }
  assert.equal(parsePlannerCommand('Call the hotel first thing tomorrow',{tasks:[],timeZone:'UTC',now:new Date(at('12:00',previousDay))}).kind,'create');
});

test('the selected estimator cannot invent a 09:30 appointment from ASAP; explicit dayparts survive', async () => {
  const h=fixture(), model='fixture';
  const proposal={title:'Call hotel',category:'people',minutes:10,reason:'A short call.',earliestDay:null,latestDay:null,deadlineTime:null,windowStart:'09:30',windowEnd:'09:40'};
  const agent=new TaskAgents({store:h.service.store,adapters:{codex:{estimate:async()=>({output:proposal,model,effort:'low'})}}});
  const context={now:new Date(at('12:00',previousDay)),timeZone:'UTC',selection:{provider:'codex',model,effort:'low'}};
  const asap=await agent.estimate('Call hotel ASAP',context), morning=await agent.estimate(note,context);
  assert.deepEqual([asap.agent.outcome,asap.windowStart,asap.windowEnd],['success',null,null]);
  assert.deepEqual([morning.windowStart,morning.windowEnd],['00:00','12:00']);
});

test('a queued estimate resolves the intended day before ordering it among other days’ earliest requests', async () => {
  const h=fixture();
  await h.service.createTask(request(1,deck));
  await h.service.createTask(request(2,'Send invoices Wednesday ASAP for 10 minutes'));
  h.service.enqueueTask(request(3,note)); h.service.startEstimateWorker(); await h.service.whenEstimatesIdle();
  assert.deepEqual(h.starts(3,1,2),[at('08:30'),at('08:40'),at('08:30','2026-11-25')]);
  h.service.stopEstimateWorker();
});

test('an undated ASAP note can take today’s first opening even with a later day’s earlier-requested priority task', async () => {
  const h=fixture({now:at('07:15')});
  await h.service.createTask(request(1,'Prepare the presentation today for 60 minutes'));
  await h.service.createTask(request(2,'Send invoices Friday ASAP for 10 minutes'));
  await h.service.createTask(request(3,'Call hotel ASAP for 10 minutes'));
  assert.deepEqual(h.starts(3,1,2),[at('08:30'),at('08:40'),at('08:30','2026-11-27')]);
});

test('a reviewed multi-action agent plan can request the first opening without inventing a fixed start', async () => {
  const h=fixture(); await h.service.createTask(request(1,deck)); await h.service.createTask(request(2,'Call hotel tomorrow for 10 minutes'));
  await h.service.editTask(id(2),{title:'Hotel call'});
  const input={...request(3,'Put the hotel call first and add a checklist step to confirm the rate'),contextDay:day};
  const ctx=createPlanContext(h.service,input), alias=Object.keys(ctx.bindings.targets).find(key=>ctx.bindings.targets[key].id===id(2));
  const preview=previewAgentPlan(h.service,input,ctx,[{op:'first',task:alias},{op:'subtask.add',task:alias,title:'Confirm the rate'}]);
  assert.equal(preview.kind,'preview',preview.message); assert.deepEqual(h.starts(1,2),[at('08:30'),at('09:30')]);
  const result=applyAgentPlan(h.service,{...input,planId:preview.planId});
  assert.equal(result.kind,'applied',result.message); assert.deepEqual(h.starts(2,1),[at('08:30'),at('08:40')]);
  assert.equal(h.service.findTask(id(2)).subtasks[0].title,'Confirm the rate'); assert.equal(h.estimates.length,2);
});
