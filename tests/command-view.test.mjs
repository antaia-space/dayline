import assert from 'node:assert/strict';
import test from 'node:test';
import { createAffectedTaskLinks,createCommandPrompts } from '../web/commands.js';

test('each saved request displays its original words and sends only the explicit choice for that request', t => {
  class Control {
    constructor(tag) { this.tag=tag; this.children=[]; this.dataset={}; this.listeners={}; }
    get childElementCount() { return this.children.length; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children=items; }
    contains(item) { return this===item || this.children.some(child=>child.contains(item)); }
    addEventListener(name,fn) { this.listeners[name]=fn; }
    setAttribute(name,value) { this[name]=value; }
    click() { if (!this.disabled) this.listeners.click?.(); }
  }
  const previous=globalThis.document;
  globalThis.document={activeElement:null,createElement:tag=>new Control(tag)};
  t.after(()=>{ if (previous) globalThis.document=previous; else delete globalThis.document; });
  const root=new Control('section'),decisions=[],edits=[],renders=[];
  const update=createCommandPrompts(root,{decide:(item,choice)=>decisions.push([item.id,choice]),
    edit:item=>edits.push(item.id),dismiss:item=>renders.push(item.id),retry(){},focusInput(){}});
  const a={id:'first',text:'Move the sample review to Friday',command:{status:'choice',message:'Which review?',
    choices:[{id:'alpha',title:'Review <draft>',detail:'Friday at 10:00'}]}};
  const b={id:'second',text:'Change the courier appointment',command:{status:'unmatched',message:'Which task do you mean?',choices:[]}};
  const all=node=>[node,...node.children.flatMap(all)];
  const byFocus=key=>all(root).find(control=>control.dataset.commandFocus===key);
  update([a,b]);
  assert.deepEqual(root.children.map(card=>card.children[0].textContent),[a.text,b.text]);
  assert.equal(byFocus('first-alpha').textContent,'Review <draft>');
  assert.equal(byFocus('first-alpha').children[0].textContent,'Friday at 10:00');
  assert.deepEqual(decisions,[]);
  byFocus('first-alpha').click();byFocus('second-new').click();byFocus('second-edit').click();
  assert.deepEqual(decisions,[['first',{chosenTaskId:'alpha'}],['second',{forceCreate:true}]]);
  assert.deepEqual(edits,['second']);
  update([{...a,decision:{chosenTaskId:'alpha'}},b]);
  assert.equal(byFocus('first-new').disabled,true);
  assert.equal(byFocus('first-alpha').disabled,true);
  assert.equal(byFocus('second-new').disabled,false);
  byFocus('second-dismiss').click();assert.deepEqual(renders,['second']);
  update([]);assert.equal(root.hidden,true);

  const result=new Control('details'),visits=[];
  const links=createAffectedTaskLinks(result,id=>visits.push(id));
  links([{id:'alpha',title:'Review <draft>'},{id:'beta',text:'Write summary'}]);
  assert.equal(result.children[0].textContent,'View 2 affected tasks');
  all(result).filter(control=>control.tag==='button')[1].click();
  assert.deepEqual(visits,['beta']);
  links([{id:'alpha',title:'Review <draft>'}]);assert.equal(result.hidden,true);
});
