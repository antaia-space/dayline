import test from 'node:test';
import assert from 'node:assert/strict';
import {overrunNote,subtaskSummary,taskChecklist} from '../web/subtasks.js';

test('calendar overruns have a note only for positive recorded minutes',()=>{
  assert.deepEqual(overrunNote({overrunMinutes:10}),{label:'+10m from free time',explanation:'Dayline added 10m of free time. It can extend an unfinished task by up to five minutes at a time.'});
  assert.match(overrunNote({overrunMinutes:2}).explanation,/added 2m.*up to five minutes/);
  for(const minutes of [0,-5,null,undefined]) assert.equal(overrunNote({overrunMinutes:minutes}),null);
});

test('renders scoped, native accessible checkboxes and retains disclosure choices through a rerender',t=>{
  function node(tag){return {tag,dataset:{},attrs:{},events:{},children:[],setAttribute(key,val){this.attrs[key]=val;},
    append(...children){this.children.push(...children);},addEventListener(type,handler){this.events[type]=handler;}};}
  const previous=globalThis.document;
  globalThis.document={createElement:node,createElementNS:(_,tag)=>node(tag),createTextNode:text=>({tag:'text',textContent:text})};
  t.after(()=>{if(previous)globalThis.document=previous;else delete globalThis.document;});
  const items=[{id:'one',title:'Confirm the folder',done:true},{id:'two',title:'Check <notes>',done:false}];
  const task={id:'fixture-parent',text:'Prepare a handoff',subtasks:items};
  assert.equal(taskChecklist({text:'Flat task'},'board'),null);
  const empty=taskChecklist({id:'blank-task',text:'Pack supplies',subtasks:[]},'board');
  assert.equal(empty.open,false);
  assert.equal(empty.children[0].textContent,'Add subtask');
  assert.equal(empty.children[2].children[0].attrs['aria-label'],'New subtask for Pack supplies');
  assert.equal(empty.children[2].children[1].dataset.stepAction,'add');
  const first=taskChecklist(task,'agenda',true),[summary,list]=first.children;
  assert.equal(first.open,true);
  assert.equal(summary.attrs['aria-label'],'Subtasks for Prepare a handoff, 1 of 2 complete');
  assert.equal(subtaskSummary(items),'1 of 2');
  const [box,title]=list.children[1].children[0].children;
  assert.deepEqual([box.tag,box.type,box.checked,box.dataset.parent,box.dataset.subtask,title.textContent],
    ['input','checkbox',false,task.id,'two','Check <notes>']);
  assert.equal(list.children[0].children[0].children[0].checked,true);
  summary.onclick();
  assert.equal(taskChecklist(task,'agenda',true).open,false);
  assert.equal(taskChecklist(task,'editor',true).open,true);
  assert.equal(taskChecklist({...task,syncStatus:'deleting'},'board').children[1].children[0].children[0].children[0].disabled,true);
});
