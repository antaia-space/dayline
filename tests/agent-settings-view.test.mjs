import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentSettings, estimateActivity } from '../web/agent.js';

test('saving applies to the next capture immediately and the receipt reflects the provider that actually ran', async t => {
  const nodes = new Map();
  class Control {
    constructor() { this.listeners = {}; this.value = ''; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    removeAttribute(key) { delete this[key]; }
    replaceChildren(...children) { this.children = children; }
    dispatch(type) { return this.listeners[type]({preventDefault(){}}); }
  }
  const control = key => {
    if (!nodes.has(key)) nodes.set(key,new Control());
    return nodes.get(key);
  };
  const previous = {document:globalThis.document,Option:globalThis.Option};
  globalThis.document = {getElementById:control,createElement:() => new Control()};
  globalThis.Option = class { constructor(label,value) { this.label=label; this.value=value; } };
  t.after(() => {
    for (const [key,value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  let selected = {provider:'codex',model:'gpt-6.2-sol',effort:'low'};
  const previousRun = {...selected,at:'2026-11-01T15:30:00Z',outcome:'success',outputTokens:11};
  const chosen = {provider:'gemini',model:'gemini-hydrogen'};
  const requests = [], applied = [];
  const api = async (path,method,body) => {
    requests.push({path,method});
    if (method === 'POST') return selected = body;
    const provider = new URL(path,'http://localhost').searchParams.get('provider');
    return {provider,installed:true,signedIn:true,selected,lastRun:previousRun,models:[{id:chosen.model}]};
  };
  const settings = createAgentSettings({api,toast(){},errorAt(){},onSaved:selection => applied.push(selection)});
  await settings.open({selectedAgent:selected,lastAgentRun:previousRun,tasks:[],settings:{timeZone:'Asia/Kathmandu'}});
  control('agent-provider').value=chosen.provider;
  await control('agent-provider').dispatch('change');
  control('agent-model').value=chosen.model;
  control('agent-model').dispatch('input');
  assert.match(control('agent-current').textContent,/New tasks use OpenAI via Codex/);
  await control('agent-form').dispatch('submit');
  assert.deepEqual(applied,[chosen]);
  assert.equal(requests.length,3);
  assert.match(control('agent-current').textContent,/New tasks use Google Gemini · gemini-hydrogen/);
  assert.match(control('agent-run').textContent,/Completed · OpenAI via Codex/);
  assert.match(control('agent-run').textContent,/21:15(?:\s|$)/);
  assert.match(control('agent-run-context').textContent,/Google Gemini/);
  settings.update({selectedAgent:chosen,lastAgentRun:previousRun,settings:{timeZone:'America/Los_Angeles'},tasks:[{estimateState:'estimating',estimateAgent:chosen}]});
  assert.match(control('agent-run').textContent,/07:30(?:\s|$)/);
  assert.match(control('agent-activity').textContent,/Estimating now · Google Gemini · gemini-hydrogen/);
  const failure = {...chosen,at:'2026-11-02T10:00:00Z',outcome:'pending',notice:'Google could not complete this estimate.'};
  settings.update({selectedAgent:chosen,lastAgentRun:failure,tasks:[{estimateState:'failed',agent:failure}]});
  assert.match(control('agent-run').textContent,/Estimate unavailable · Google Gemini · gemini-hydrogen/);
  assert.equal(control('agent-run-notice').textContent,failure.notice);
  assert.equal(control('agent-run-context').hidden,true);
  assert.equal(control('agent-activity').hidden,true);
  assert.equal(requests.length,3);
});

test('the active provider comes from the captured job and a running task takes precedence over queued work', () => {
  const tasks = [{estimateState:'queued',estimateAgent:{provider:'claude',model:'claude-example'}},
    {estimateState:'estimating',estimateAgent:{provider:'gemini',model:'gemini-hydrogen'},agent:{provider:'codex'}},
    {estimateState:'failed',agent:{provider:'codex'}}];
  assert.equal(estimateActivity(tasks),'Estimating now · Google Gemini · gemini-hydrogen · 1 more queued');
  assert.equal(estimateActivity(tasks.slice(0,1)),'Queued for estimation · Anthropic via Claude Code · claude-example');
  assert.equal(estimateActivity(tasks.slice(2)),'');
});
