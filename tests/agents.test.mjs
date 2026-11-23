import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store.mjs';
import { DaylineService } from '../src/service.mjs';
import { TaskAgents } from '../src/agents/manager.mjs';
import { startServer } from '../src/http.mjs';

const suggestion = { category: 'writing', minutes: 35, reason: 'Allow a pass to outline and a pass to edit.',
  earliestDay: null, latestDay: null, windowStart: null, windowEnd: null, deadlineTime: null };
const now = new Date('2026-11-24T18:00:00Z');
async function planner(t, generate) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dayline-agent-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  store.state.settings.timeZone = 'America/Los_Angeles';
  const loginRequests = [];
  const agents = new TaskAgents({ store, adapters: { codex: {
    status: () => ({ installed: true, signedIn: true, models: [{ id: 'test-model', label: 'Test model' }] }),
    estimate: generate
  } }, launchLogin: async id => { loginRequests.push(id); } });
  const service = new DaylineService({ store, vault: {}, clock: () => now,
    estimate: (text, context) => agents.estimate(text, context) });
  return { service, agents, dir, store, loginRequests };
}

test('the paired app saves a subscription choice, sends only one task, and reports per-estimate usage', async t => {
  const requests = [];
  const { service, agents, dir, loginRequests } = await planner(t, async args => {
    requests.push(args);
    return { output: { ...suggestion, earliestDay: '2026-11-27' }, model: 'test-model', effort: 'low',
      usage: { inputTokens: 77, outputTokens: 35, cachedInputTokens: 4 } };
  });
  await service.createTask({ text: 'A private earlier task' });
  assert.equal(agents.selected.provider, 'local');
  const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
  const app = await startServer({ service, agents, port: 0, webRoot, intervalMs: 0 });
  t.after(() => app.close());
  const paired = await fetch(app.launchUrl(), { redirect: 'manual' });
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'Content-Type': 'application/json', Origin: app.origin };
  const post = (route, obj) => fetch(app.origin + route, { method: 'POST', headers, body: JSON.stringify(obj) });
  assert.equal((await fetch(app.origin + '/api/agent')).status, 401);
  assert.equal((await fetch(app.origin + '/api/agent', { method: 'POST', headers: { ...headers, Origin: 'https://foreign.invalid' }, body: '{}' })).status, 403);
  assert.equal((await post('/api/agent', { provider: 'other' })).status, 400);
  assert.equal((await post('/api/agent', { provider: 'codex', model: '--invalid' })).status, 400);
  assert.equal((await post('/api/agent/login', { provider: 'codex' })).status, 200);
  assert.deepEqual(loginRequests, ['codex']);
  assert.equal((await post('/api/agent', { provider: 'codex', model: 'test-model' })).status, 200);
  const text = 'Write a two-paragraph update by Friday';
  const input = { text, requestId: 'f'.repeat(32) };
  await Promise.all([post('/api/tasks', input), post('/api/tasks', input)]);
  const result = service.snapshot().tasks.at(-1);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].input, { task: text, today: '2026-11-24', currentTime: '10:00',
    timeZone: 'America/Los_Angeles', workDays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' });
  assert.match(requests[0].instructions, /quoted data/);
  assert.equal(result.earliestDay, null);
  assert.equal(result.latestDay, '2026-11-27');
  assert.equal(result.category, 'writing');
  assert.equal(result.minutes, 35);
  assert.equal(result.agent.model, 'test-model');
  assert.equal(result.agent.inputTokens, 77);
  const status = await (await fetch(app.origin + '/api/agent?provider=codex', { headers })).json();
  assert.equal(status.lastRun.outcome, 'success');
  assert.equal(status.lastRun.outputTokens, 35);
  assert.equal(openStore(dir).state.agent.provider, 'codex');
  await service.editTask(result.id, { done: true });
  assert.equal(requests.length, 1);
});

test('explicit durations, chosen day, and local exact-time constraints survive a model estimate', async t => {
  const { service, agents } = await planner(t, async () => ({ output: suggestion, model: 'test-model', effort: 'low' }));
  agents.select({ provider: 'codex', model: 'test-model' });
  await service.createTask({ text: 'Write notes at 3pm for 12 minutes tomorrow', day: '2026-11-27' });
  const [task] = service.snapshot().tasks;
  assert.deepEqual([task.minutes, task.earliestDay, task.latestDay, task.windowStart, task.windowEnd],
    [12, '2026-11-27', '2026-11-27', '15:00', '15:12']);
  await service.editTask(task.id, { text: 'Write notes tomorrow at 3pm' });
  const edited = service.snapshot().tasks[0];
  assert.deepEqual([edited.minutes, edited.windowStart, edited.windowEnd, edited.agent.model], [35, '15:00', '15:35', 'test-model']);
});

test('provider errors or malformed estimates stay pending and preserve the selected account', async t => {
  let calls = 0;
  const { service, agents } = await planner(t, async () => {
    if (++calls === 1) throw new Error('Untrusted diagnostics or email address');
    return { output: { ...suggestion, earliestDay: '2026-02-31' }, model: 'test-model', effort: 'low', usage: { outputTokens: 7 } };
  });
  agents.select({ provider: 'codex', model: 'test-model' });
  for (const text of ['Call Morgan for 15 minutes', 'File an invoice']) await service.createTask({ text });
  const [first, second] = service.snapshot().tasks;
  assert.equal(first.minutes, 15);
  assert.equal(first.agent.outcome, 'pending');
  assert.equal(first.start, null);
  assert.doesNotMatch(first.agent.notice, /Untrusted/);
  assert.equal(second.category, 'admin');
  assert.equal(second.agent.outputTokens, 7);
  assert.equal(second.agent.outcome, 'pending');
  assert.equal(second.start, null);
  assert.equal(agents.selected.provider, 'codex');
  assert.equal(calls, 2);
});

test('Codex pins gpt-6.2-sol and low effort when the user selects it, including an older blank selection', async t => {
  const calls = [];
  const { service, agents, store } = await planner(t, async args => {
    calls.push(args);
    return { output: suggestion, model: args.model, effort: 'low', usage: { inputTokens: 11, outputTokens: 8 } };
  });
  assert.deepEqual(agents.select({ provider: 'codex', model: '' }), { provider: 'codex', model: 'gpt-6.2-sol', effort: 'low' });
  await service.createTask({ text: 'Draft a book club update' });
  assert.equal(calls[0].model, 'gpt-6.2-sol');
  const task = service.snapshot().tasks[0];
  assert.equal(task.agent.model, 'gpt-6.2-sol');
  assert.equal(task.agent.effort, 'low');
  assert.equal(task.agent.outcome, 'success');
  store.state.agent = { provider: 'codex', model: '', lastRun: task.agent };
  const restarted = new TaskAgents({ store });
  assert.deepEqual(restarted.selected, { provider: 'codex', model: 'gpt-6.2-sol', effort: 'low' });
  assert.deepEqual(store.state.agent.lastRun, task.agent);
});

test('desktop and browser retries share a single paid estimate for a waiting task', async t => {
  let calls = 0;
  let started, release;
  const atProvider = new Promise(resolve => { started = resolve; });
  const complete = new Promise(resolve => { release = resolve; });
  const { service, agents } = await planner(t, async ({ model }) => {
    if (++calls === 1) throw new Error('Codex could not complete the estimate.');
    started();
    await complete;
    return { output: suggestion, model, effort: 'low' };
  });
  agents.select({ provider: 'codex' });
  const id = await service.createTask({ text: 'Write the update' });
  assert.equal(service.snapshot().tasks[0].pendingEstimate, true);
  const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
  const server = await startServer({ service, agents, port: 0, intervalMs: 0, webRoot });
  t.after(() => server.close());
  const paired = await fetch(server.launchUrl(), { redirect: 'manual' });
  const headers = { origin: server.origin, cookie: paired.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const retry = () => fetch(server.origin + '/api/tasks/' + id + '/estimate', { method: 'POST', headers, body: '{}' });
  const first = retry();
  await atProvider;
  const second = retry();
  // A subsequent read on the same client lets the server accept both requests.
  await fetch(server.origin + '/api/state', { headers });
  release();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal(calls, 2);
  const [task] = service.snapshot().tasks;
  assert.equal(task.id, id);
  assert.equal(task.agent.outcome, 'success');
  assert.equal(task.minutes, 35);
  assert.ok(task.start);
});
