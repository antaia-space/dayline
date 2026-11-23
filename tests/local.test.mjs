import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, developmentVault } from '../src/store.mjs';
import { DaylineService } from '../src/service.mjs';
import { startServer } from '../src/http.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

test('paired app and browser share one planner; visiting a calendar link requires confirmation', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dayline-test-'));
  const service = new DaylineService({ store: openStore(dir), vault: developmentVault(dir), clock: () => new Date('2026-11-23T08:00:00Z') });
  const app = await startServer({ service, webRoot, port: 0, intervalMs: 0 });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true }); });
  async function pair() {
    const response = await fetch(app.launchUrl(), { redirect: 'manual' });
    assert.equal(response.status, 303);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const desktop = await pair();
  const browser = await pair();
  const state = async cookie => (await fetch(app.origin + '/api/state', { headers: { cookie } })).json();
  const write = (pathname, method, data, cookie) => fetch(app.origin + pathname, {
    method, headers: { cookie, Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  assert.equal((await fetch(app.origin + '/api/state')).status, 401);
  await write('/api/settings', 'PATCH', { timeZone: 'UTC' }, desktop);
  const input = { text: 'Write notes for 25 minutes', requestId: 'a'.repeat(32) };
  await Promise.all([write('/api/tasks', 'POST', input, desktop), write('/api/tasks', 'POST', input, desktop)]);
  const tasks = (await state(browser)).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].minutes, 25);
  assert.equal(tasks[0].start, '2026-11-23T09:00:00.000Z');
  const action = await fetch(app.origin + '/action/' + tasks[0].id + '?done=1', { headers: { cookie: browser } });
  assert.equal(action.status, 200);
  assert.match(await action.text(), /action-dialog/);
  assert.equal((await state(desktop)).tasks[0].done, false);
  const confirm = await write('/api/tasks/' + tasks[0].id, 'PATCH', { done: true }, browser);
  assert.equal(confirm.status, 200);
  assert.equal((await state(desktop)).tasks[0].done, true);
  assert.equal(openStore(dir).state.tasks[0].done, true);
});

test('the development vault round-trips a client without saving plaintext in planner data', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dayline-vault-'));
  t.after(() => rm(dir, { recursive: true }));
  const store = openStore(dir);
  const service = new DaylineService({ store, vault: developmentVault(dir) });
  await service.configure({ clientId: 'example.apps.googleusercontent.com', clientSecret: 'example-desktop-client' });
  assert.ok(service.snapshot().connection.configured);
  assert.equal((await service.client()).clientSecret, 'example-desktop-client');
  assert.ok(!(await readFile(path.join(dir, 'planner.json'), 'utf8')).includes('example-desktop-client'));
});
