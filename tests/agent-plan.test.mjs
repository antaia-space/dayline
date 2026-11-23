import test from 'node:test';
import assert from 'node:assert/strict';
import { agentPlanReceipt, applyAgentPlan, createPlanContext, previewAgentPlan } from '../src/agent-plan.mjs';
import { DaylineService } from '../src/service.mjs';
import { defaultSettings } from '../src/store.mjs';
import { estimateTask } from '../src/planner.mjs';

const monday = '2026-11-23', tuesday = '2026-11-24', friday = '2026-11-27';
const id = n => n.toString(16).padStart(32,'0');
const at = (day,time) => `${day}T${time}:00.000Z`;
const agent = {provider:'codex',model:'fixture',effort:'low',inputTokens:102,outputTokens:38};
const request = (n,text,contextDay=monday) => ({requestId:id(n),text,contextDay});

function fixture(saved, google={}) {
  const store = {state:saved ? structuredClone(saved) : {version:1,tasks:[],accounts:[],settings:{...defaultSettings(),timeZone:'UTC'}}, writes:0,
    save() {
      if (this.fail) throw new Error('Simulated disk failure');
      this.saved = structuredClone(this.state); this.writes++;
    }};
  const h = {store,now:at(monday,'08:00'),estimates:0};
  const service = new DaylineService({store,google,clock:() => new Date(h.now),bundledClient:{clientId:'fixture'},vault:{open:value=>value},
    estimate(text,context) { h.estimates++; return estimateTask(text,context); }});
  h.service = service;
  h.add = async (n,title,note,day) => {
    const taskId = await service.createTask({requestId:id(n),text:note || title + ' for 25 minutes',...(day && {day})});
    if (title) await service.editTask(taskId,{title});
    return service.findTask(taskId);
  };
  h.context = body => createPlanContext(service,body);
  h.preview = (body,context,actions,receipt=agent) => service.run(() => previewAgentPlan(service,body,context,actions,receipt));
  h.apply = (body,preview) => service.run(() => applyAgentPlan(service,{...body,planId:preview.planId}));
  return h;
}
const alias = (context,task) => Object.keys(context.bindings.targets).find(key => context.bindings.targets[key].id === task.id);
const steps = task => task.subtasks.map(({title,done}) => [title,done]);

test('provider context distinguishes the real today and selected day, caps relevant aliases and excludes private notes, addresses and external meetings', async () => {
  const h = fixture();
  const visible = await h.add(1,'Follow up with partners','Private note with confidential invoice number',tuesday);
  const crossDay = await h.add(2,'Vendor approval','Talk about stratovolcano refinancing in private',friday);
  const hidden = await h.add(3,'Personal archive','Unrelated boxes',friday);
  const external = await h.add(4,'Confidential board meeting','External',tuesday);
  external.remote = {calendarAppointment:true,calendarId:'real-calendar@example.test',eventId:id(808)};
  visible.title += ' at https://private.example.test/a';
  visible.subtasks=[{id:id(101),title:'Contact someone@example.test',done:false}];
  const ctx = h.context(request(20,'Can you help me with the stratovolcano work?',tuesday));
  assert.deepEqual([ctx.modelContext.today,ctx.modelContext.viewDay],[monday,tuesday]);
  assert.deepEqual(new Set(ctx.modelContext.tasks.map(t=>t.title)),new Set(['Follow up with partners at [link]','Vendor approval']));
  assert.ok(alias(ctx,crossDay)); assert.equal(alias(ctx,hidden),undefined); assert.equal(alias(ctx,external),undefined);
  assert.deepEqual(ctx.modelContext.tasks.find(t=>t.alias===alias(ctx,visible)).subtasks.map(s=>s.title),['Contact [email]']);
  assert.doesNotMatch(JSON.stringify(ctx.modelContext),/private|confidential|stratovolcano|@|https:|[a-f\d]{32}/i);
  const untitled=await h.add(5,'Temporary title','Please prepare orbital slides at https://private.example.test',tuesday); delete untitled.title;
  const legacy=h.context(request(21,'What is on the planner?',tuesday));
  assert.match(legacy.modelContext.tasks.find(row=>row.alias===alias(legacy,untitled)).title,/Prepare orbital slides at \[link\]/i);
  for (let n=0;n<30;n++) h.service.data.tasks.push({...structuredClone(visible),id:id(200+n),title:'Planner row '+n,
    subtasks:Array.from({length:20},(_,i)=>({id:id(500+n*20+i),title:'Checklist item '+i,done:false}))});
  const bounded=h.context(request(23,'What is on my Tuesday?',tuesday)).modelContext;
  assert.equal(bounded.tasks.length,24); assert.ok(bounded.omittedTasks>0);
  assert.ok(bounded.tasks.every(task=>task.subtasks.length<=16)); assert.equal(bounded.tasks.reduce((n,task)=>n+task.subtasks.length,0),120);
});

test('one reviewed multi-task plan commits updates, steps and duration training once, preserving notes, IDs, prior estimates and provider receipt after restart', async () => {
  const h=fixture(), atlas=await h.add(1,'Atlas migration','Outline data migration for 40 minutes'), budget=await h.add(2,'Budget review','Check accounts for 25 minutes');
  const input=request(22,'Break down the Atlas migration, and move and shorten Budget review for Tuesday.');
  const ctx=h.context(input), a=alias(ctx,atlas), b=alias(ctx,budget);
  const actions=[{op:'subtask.add',task:a,title:'Prepare rollback'}, {op:'subtask.add',task:a,title:'Verify exports'},
    {op:'update',task:b,day:tuesday,time:'10:00',deltaMinutes:-5,title:'Budget check'}];
  const before=structuredClone(h.service.data.tasks), count=h.store.writes;
  const preview=await h.preview(input,ctx,actions);
  assert.equal(preview.kind,'preview',preview.message); assert.deepEqual(preview.agent,agent);
  assert.deepEqual(preview.taskIds,[atlas.id,budget.id]); assert.match(preview.steps.join(' '),/rollback.*exports.*2026-11-24 at 10:00.*20 min.*Budget check/);
  assert.deepEqual(h.service.data.tasks,before); assert.equal(h.store.writes,count+1); assert.equal(h.service.data.durationLearning,undefined);
  assert.deepEqual(await h.preview(input,ctx,[{op:'complete',task:b}],{provider:'claude'}),preview);
  const [applied,replay]=await Promise.all([h.apply(input,preview),h.apply(input,preview)]);
  assert.equal(applied.kind,'applied',applied.message); assert.deepEqual(applied,replay); assert.deepEqual(applied.agent,agent);
  assert.equal(h.store.writes,count+2); assert.equal(h.estimates,2);
  assert.deepEqual(steps(atlas),[['Prepare rollback',false],['Verify exports',false]]);
  assert.deepEqual([budget.title,budget.text,budget.start,budget.end,budget.minutes,budget.baseMinutes],['Budget check','Check accounts for 25 minutes',at(tuesday,'10:00'),at(tuesday,'10:20'),20,25]);
  assert.equal(h.service.data.durationLearning.examples.length,1);
  const restart=fixture(h.store.saved);
  assert.deepEqual(await restart.apply(input,preview),applied); assert.deepEqual(restart.service.data.tasks,h.service.data.tasks);
  assert.deepEqual(agentPlanReceipt(restart.service,input.requestId,input.text),applied);
  await assert.rejects(restart.apply({...input,text:'Something else'},preview),/different wording|no longer belongs/);
});

test('paraphrases and unfamiliar metaphors can propose a single named visible task; genuine equal candidates require clarification even when the model picks both',async () => {
  const h=fixture(), slide=await h.add(1,'Prepare investor presentation'), spare=await h.add(2,'Approve invoices');
  for(const [n,wording] of [[30,'Can we turn the slides into three small wins?'],[31,'Could you turn my pitch story into bite-sized milestones?']]) {
    const input=request(n,wording),ctx=h.context(input),p=await h.preview(input,ctx,[{op:'subtask.add',task:alias(ctx,slide),title:'Clarify audience'}]);
    assert.equal(p.kind,'preview',p.message); assert.match(p.steps[0],/Prepare investor presentation/); assert.equal(slide.subtasks.length,0);
  }
  const second=await h.add(3,'Prepare partner presentation');
  const input=request(32,'Break the slides into milestones'),ctx=h.context(input);
  const ambiguous=await h.preview(input,ctx,[{op:'subtask.add',task:alias(ctx,slide),title:'Sketch narrative'}, {op:'subtask.add',task:alias(ctx,second),title:'Sketch narrative'}]);
  assert.deepEqual([ambiguous.kind,ambiguous.reason,ambiguous.agent],['clarification','agent',agent]);
  assert.match(ambiguous.message,/investor presentation.*partner presentation/); assert.deepEqual(steps(spare),[]);
  const next=request(33,'Give each presentation a narrative outline'),all=h.context(next);
  assert.equal((await h.preview(next,all,[{op:'subtask.add',task:alias(all,slide),title:'Sketch narrative'}, {op:'subtask.add',task:alias(all,second),title:'Sketch narrative'}])).kind,'preview');
});

test('steps can be renamed, removed, added, or individually checked with normal parent completion and reservation release',async () => {
  const h=fixture(), task=await h.add(1,'Atlas migration');
  task.subtasks=[{id:id(101),title:'Test',done:false},{id:id(102),title:'Cleanup',done:false}];
  const input=request(40,'Refine the Atlas migration checklist and close it'),ctx=h.context(input),a=alias(ctx,task);
  const p=await h.preview(input,ctx,[{op:'subtask.rename',task:a,subtask:a+'.s1',title:'Verify rollback'},
    {op:'subtask.remove',task:a,subtask:a+'.s2'}, {op:'subtask.check',task:a,subtask:a+'.s1',done:true}]);
  assert.equal(p.kind,'preview',p.message); assert.match(p.steps.at(-1),/completes the parent/);
  assert.equal((await h.apply(input,p)).kind,'applied'); assert.deepEqual([task.done,task.start,task.completedDay],[true,null,monday]);
  const next=request(41,'Add smoke test to the completed Atlas migration'),c=h.context(next);
  const reopen=await h.preview(next,c,[{op:'subtask.add',task:alias(c,task),title:'Smoke test'}]);
  assert.equal(reopen.kind,'preview',reopen.message); assert.match(reopen.steps[0],/reopens/); await h.apply(next,reopen);
  assert.deepEqual(steps(task),[['Verify rollback',true],['Smoke test',false]]); assert.equal(task.done,false);
  const finish=request(42,'Finish the Atlas migration'),fc=h.context(finish);
  const done=await h.preview(finish,fc,[{op:'complete',task:alias(fc,task)}]);
  assert.equal((await h.apply(finish,done)).kind,'applied'); assert.equal(task.start,null); assert.ok(task.subtasks.every(s=>s.done));
  const undo=request(43,'Reopen the Atlas migration and its checklist'),uc=h.context(undo);
  const open=await h.preview(undo,uc,[{op:'reopen',task:alias(uc,task)}]);
  assert.equal((await h.apply(undo,open)).kind,'applied'); assert.ok(task.start); assert.ok(task.subtasks.every(s=>!s.done));
});

test('invalid fields, native IDs, crossed child aliases, unknown operations and a failed final step never partially edit tasks or train durations',async () => {
  const h=fixture(), atlas=await h.add(1,'Atlas'),budget=await h.add(2,'Budget');
  atlas.subtasks=[{id:id(101),title:'Verify rollback',done:false}]; budget.subtasks=[{id:id(102),title:'File it',done:false}];
  const bad=[(a,b)=>({op:'create',task:a,title:'A new task'}), (a,b)=>({op:'update',task:atlas.id,minutes:15}),
    (a,b)=>({op:'update',task:'__proto__',title:'Surprise'}), (a,b)=>({op:'subtask.remove',task:a,subtask:b+'.s1'}),
    a=>({op:'update',task:a,time:'25:99'}), a=>({op:'update',task:a,day:'2026-02-30'}), a=>({op:'update',task:a,minutes:0}),
    a=>({op:'update',task:a,minutes:10,delete:true}), a=>({op:'subtask.add',task:a,title:'Verify rollback'}),
    a=>({op:'update',task:a,day:monday,time:'17:10'})];
  const before=structuredClone(h.service.data.tasks);
  for(const [i,invalid] of bad.entries()) {
    const input=request(50+i,'Give Atlas and Budget some changes'),ctx=h.context(input),a=alias(ctx,atlas),b=alias(ctx,budget);
    const r=await h.preview(input,ctx,[{op:'update',task:a,minutes:10},invalid(a,b)]);
    assert.equal(r.kind,'clarification',`invalid ${i}: ${r.message}`); assert.equal(r.reason,'agent');
    assert.deepEqual(h.service.data.tasks,before); assert.equal(h.service.data.durationLearning,undefined);
    assert.deepEqual(agentPlanReceipt(h.service,input.requestId,input.text),r);
  }
});

test('a failed disk write retains the complete preview and previous tasks and learning; one retry can commit the plan',async () => {
  const h=fixture(), atlas=await h.add(1,'Atlas migration'), req=request(70,'Give Atlas ten more minutes and add rollout prep');
  const c=h.context(req),a=alias(c,atlas),p=await h.preview(req,c,[{op:'update',task:a,deltaMinutes:10},{op:'subtask.add',task:a,title:'Rollout prep'}]);
  const state=structuredClone(h.service.data);
  h.store.fail=true;
  await assert.rejects(h.apply(req,p),/disk failure/);
  assert.deepEqual(h.service.data,state); assert.deepEqual(h.store.saved,state);
  h.store.fail=false;
  assert.equal((await h.apply(req,p)).kind,'applied'); assert.equal(atlas.minutes,35); assert.equal(atlas.subtasks.length,1);
  assert.equal(h.service.data.durationLearning.examples.length,1);
});

test('targets and peer matches are revalidated before preview and apply, while unrelated changes do not invalidate an individual plan',async () => {
  const h=fixture(), north=await h.add(1,'North design brief');
  const req=request(80,'Break the design brief into steps'),c=h.context(req),p=await h.preview(req,c,[{op:'subtask.add',task:alias(c,north),title:'Draft figures'}]);
  assert.equal(p.kind,'preview'); await h.add(2,'South design brief');
  const invalid=await h.apply(req,p);
  assert.deepEqual([invalid.kind,invalid.reason,invalid.agent],['clarification','agent',agent]); assert.match(invalid.message,/North design brief.*South design brief/);
  assert.deepEqual(steps(north),[]); assert.deepEqual(await h.apply(req,p),invalid);
  const renamed=request(81,'Add research to the North design brief'),before=h.context(renamed);
  await h.service.editTask(north.id,{title:'Different deliverable'});
  assert.match((await h.preview(renamed,before,[{op:'subtask.add',task:alias(before,north),title:'Research'}])).message,/changed since/i);
  const stable=request(82,'Add a review to the Different deliverable'),live=h.context(stable),ok=await h.preview(stable,live,[{op:'subtask.add',task:alias(live,north),title:'Review inputs'}]);
  await h.add(3,'Refuel bicycle','Refuel bicycle for 10 minutes',friday);
  assert.equal((await h.apply(stable,ok)).kind,'applied');
  const protectedReq=request(83,'Give the Different deliverable another 15 minutes'),protectedCtx=h.context(protectedReq),protect=await h.preview(protectedReq,protectedCtx,[{op:'update',task:alias(protectedCtx,north),deltaMinutes:15}]);
  north.remote={calendarAppointment:true,calendarId:'shared',eventId:id(999)};
  assert.match((await h.apply(protectedReq,protect)).message,/changed since/); assert.equal(north.minutes,25);
});

test('a typed priority plan obeys the grip rules, detects order changes during model processing, and keeps existing fixed clocks',async () => {
  const h=fixture(),atlas=await h.add(1,'Atlas'),budget=await h.add(2,'Budget'),extra=await h.add(3,'Pencils'),fixed=await h.add(4,'Standup','Meet at 11:00 for 15 minutes');
  const req=request(90,'Put Budget ahead of Atlas and keep the other things intact'),c=h.context(req);
  const op={op:'order',task:alias(c,budget),other:alias(c,atlas),placement:'before'};
  h.service.data.tasks=[atlas,budget,fixed,extra]; // fixed membership is immaterial to flexible priority
  const p=await h.preview(req,c,[op]); assert.equal(p.kind,'preview',p.message);
  assert.equal((await h.apply(req,p)).kind,'applied'); assert.deepEqual([budget.start,atlas.start,fixed.start],[at(monday,'09:00'),at(monday,'09:25'),at(monday,'11:00')]);
  const input=request(91,'Put Atlas ahead of Budget'),snapshot=h.context(input);
  h.service.data.tasks=[budget,extra,atlas,fixed]; // a second window changes priority before task timestamps have been refreshed
  const stale=await h.preview(input,snapshot,[{op:'order',task:alias(snapshot,atlas),other:alias(snapshot,budget),placement:'before'}]);
  assert.equal(stale.kind,'clarification'); assert.match(stale.message,/changed since/);
  const broad=request(92,'Rebalance my schedule'),all=h.context(broad);
  assert.match((await h.preview(broad,all,[{op:'update',task:alias(all,fixed),day:tuesday}])).message,/fixed appointment/);
});

test('a duration-based selector must pick the requested extreme and tied tasks clarify before any change',async () => {
  const h=fixture(),quick=await h.add(1,'Permissions','Check access for 10 minutes'),long=await h.add(2,'Migration','Plan for 50 minutes');
  const req=request(101,'Break the longest task into three checkable steps'),c=h.context(req);
  assert.match((await h.preview(req,c,[{op:'subtask.add',task:alias(c,quick),title:'Assess coverage'}])).message,/does not match/);
  const next=request(102,req.text),c2=h.context(next);
  const p=await h.preview(next,c2,[{op:'subtask.add',task:alias(c2,long),title:'Assess coverage'}]); assert.equal(p.kind,'preview',p.message);
  await h.add(3,'Compliance','Prepare for 50 minutes'); assert.equal((await h.apply(next,p)).kind,'clarification');
});

test('read-only connected application requests a fresh placement around real Google busy intervals without writing external events',async () => {
  const reads=[],writes=[];
  const google={refreshToken:({refreshToken})=>({access_token:refreshToken,expires_in:3600}),
    listCalendars:token=>[{id:token,name:token,primary:true,writable:false}],
    getBusy(token){ reads.push(token); return token==='home' ? [{start:at(tuesday,'09:00'),end:at(tuesday,'10:00')}] : []; },
    putTaskEvent(...args){writes.push(args);}, deleteEvent(...args){writes.push(args);}};
  const h=fixture(undefined,google), atlas=await h.add(1,'Atlas migration','Prepare for 25 minutes');
  h.service.data.accounts=['work','home'].map(sub=>({sub,email:sub+'@example.test',secret:sub,mode:'availability'}));
  const input=request(103,'Give Atlas a Tuesday slot and add an outline'),c=h.context(input),a=alias(c,atlas),p=await h.preview(input,c,[{op:'update',task:a,day:tuesday},{op:'subtask.add',task:a,title:'Prepare outline'}]);
  assert.equal(p.kind,'preview',p.message); assert.equal((await h.apply(input,p)).kind,'applied');
  assert.equal(atlas.start,null); assert.deepEqual(reads,[]); await h.service.queueSync();
  assert.deepEqual(new Set(reads),new Set(['work','home'])); assert.deepEqual(writes,[]);
  assert.equal(atlas.start,at(tuesday,'10:00')); assert.equal(atlas.text,'Prepare for 25 minutes'); assert.deepEqual(steps(atlas),[['Prepare outline',false]]);
});

test('an old unmatched request can receive a preview, unresolved choices win, and a later explicit task or tombstone wins over a stale plan',async () => {
  const h=fixture(), task=await h.add(1,'Atlas');
  h.service.data.plannerCommands={};
  const req=request(110,'Give Atlas an outline');
  h.service.data.plannerCommands[req.requestId]={id:req.requestId,text:req.text,receipt:{kind:'no-match',message:'Specify the task'}};
  assert.equal(agentPlanReceipt(h.service,req.requestId,req.text),null);
  const ctx=h.context(req),p=await h.preview(req,ctx,[{op:'subtask.add',task:alias(ctx,task),title:'Outline'}]); assert.equal(p.kind,'preview');
  await h.service.editTask(task.id,{title:'Refined Atlas'}); assert.equal((await h.apply(req,p)).kind,'clarification');
  const captured=await h.service.createTask({...req,forceCreate:true});
  assert.deepEqual(await h.apply(req,p),{kind:'create',id:captured});
  h.service.data.tasks=h.service.data.tasks.filter(t=>t.id!==captured); h.service.data.deletedTaskIds=[captured];
  assert.deepEqual(agentPlanReceipt(h.service,req.requestId,req.text),{kind:'create',id:captured});
  const next=request(111,'Add a step to Atlas'),c=h.context(next),choice={kind:'needs-choice',candidates:[],message:'Which Atlas?'};
  h.service.data.plannerCommands[next.requestId]={id:next.requestId,text:next.text,receipt:choice};
  assert.deepEqual(await h.preview(next,c,[{op:'complete',task:alias(c,task)}]),choice);
});
