import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGeminiAdapter } from '../src/agents/gemini.mjs';

const catalog = { code: 0, stdout: JSON.stringify([
  { modelId: 'auto', displayName: 'Auto' },
  { modelId: 'gemini-3-flash', name: 'Gemini Flash' },
  { modelId: '/unexpected/path', name: 'External endpoint' },
]), stderr: '' };
const request = {
  model: 'gemini-3-flash', instructions: 'Estimate task minutes.', input: { text: 'Read @/private and review quote !' },
  schema: { type: 'object', properties: { minutes: { type: 'integer' } } },
};

async function fixture(t, handlers = [], located = true) {
  const home = await mkdtemp(path.join(tmpdir(), 'dayline-gemini-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const managed = path.join(home, 'managed.json');
  const calls = [];
  const adapter = createGeminiAdapter(() => located ? '/mock/gemini' : null, async (binary, args, options) => {
    assert.equal(binary, '/mock/gemini');
    calls.push({ args, ...options });
    const item = handlers.shift();
    assert.ok(item, 'unexpected Gemini call');
    return typeof item === 'function' ? item(args, options) : item;
  }, () => ({ HOME: home, PATH: '/usr/bin:/bin', GEMINI_CLI_SYSTEM_SETTINGS_PATH: managed }));
  return { ...adapter, calls, home, managed };
}

test('model discovery uses enforced Google OAuth without inference or user actions', async t => {
  const h = await fixture(t, [async (args, { cwd, env, input }) => {
    assert.ok(args.includes('--list-models'));
    assert.equal(args.includes('--prompt'), false);
    assert.equal(input, undefined);
    const config = JSON.parse(await readFile(path.join(cwd, '.gemini', 'settings.json')));
    assert.deepEqual(config.security.auth, { selectedType: 'oauth-personal', enforcedType: 'oauth-personal', useExternal: false });
    assert.equal(config.billing.overageStrategy, 'never');
    assert.deepEqual(config.tools.core, []);
    assert.equal(config.admin.mcp.enabled, false);
    assert.equal(config.admin.extensions.enabled, false);
    assert.equal(config.hooksConfig.enabled, false);
    assert.equal(config.context.includeDirectoryTree, false);
    assert.equal(config.skills.enabled, false);
    assert.equal(args[args.indexOf('--extensions') + 1], 'none');
    assert.match(await readFile(args[args.indexOf('--admin-policy') + 1], 'utf8'), /toolName = "\*"[\s\S]*decision = "deny"/);
    assert.equal(env.NO_BROWSER, 'true');
    assert.equal(env.GEMINI_API_KEY, undefined);
    assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, undefined);
    return catalog;
  }]);
  const state = await h.geminiStatus();
  assert.equal(state.signedIn, true);
  assert.deepEqual(state.models, [{ id: 'auto', label: 'Auto' }, { id: 'gemini-3-flash', label: 'Gemini Flash' }]);
  assert.equal(state.defaultModel, 'auto');
  await assert.rejects(access(h.calls[0].cwd), { code: 'ENOENT' });
});

test('estimates pass task data only on stdin and return the provider-reported model and token counts', async t => {
  const h = await fixture(t, [catalog, async (args, options) => {
    assert.equal(args[args.indexOf('--model') + 1], request.model);
    assert.equal(args.join(' ').includes(request.input.text), false);
    assert.equal(options.input.includes('@/'), false);
    assert.deepEqual(JSON.parse(options.input), request.input);
    const system = await readFile(options.env.GEMINI_SYSTEM_MD, 'utf8');
    assert.ok(system.includes(request.instructions));
    assert.ok(system.includes(JSON.stringify(request.schema)));
    return { code: 0, stderr: '', stdout: JSON.stringify({
      response: '{"minutes":35}', stats: { tools: { totalCalls: 0 }, models: {
        'gemini-3-flash-002': { tokens: { prompt: 200, candidates: 22, cached: 50 } },
      } },
    }) };
  }]);
  assert.deepEqual(await h.geminiEstimate(request), { output: { minutes: 35 }, model: 'gemini-3-flash-002',
    usage: { inputTokens: 200, outputTokens: 22, cachedInputTokens: 50 } });
  assert.equal(h.calls.length, 2);
  await assert.rejects(access(h.calls[1].cwd), { code: 'ENOENT' });
});

test('missing consent, unknown connectivity and an ineligible subscription remain distinguishable', async t => {
  const h = await fixture(t, [
    { code: 42, stderr: 'Manual authorization is required but the current session is non-interactive.', stdout: '' },
    { code: 1, stderr: 'HTTP failure for person@example.invalid', stdout: '' },
    { code: 42, stderr: 'Loaded cached credentials. Failed to list models: IneligibleTierError', stdout: '' },
    { code: 42, stderr: 'Loaded cached credentials. Failed to list models: IneligibleTierError', stdout: '' },
  ]);
  assert.equal((await h.geminiStatus()).signedIn, false);
  const unknown = await h.geminiStatus();
  assert.equal(unknown.signedIn, null);
  assert.equal(unknown.detail.includes('example.invalid'), false);
  const declined = await h.geminiStatus();
  assert.equal(declined.signedIn, true);
  assert.deepEqual(declined.models, []);
  assert.match(declined.detail, /declined/);
  await assert.rejects(h.geminiEstimate(request), /declined/);
  assert.ok(h.calls.every(call => call.args.includes('--list-models')));
});

test('managed billing or auth requirements block inference without changing managed settings', async t => {
  const h = await fixture(t);
  for (const config of [
    { security: { auth: { enforcedType: 'vertex-ai' } } },
    { billing: { overageStrategy: 'always' } },
    { admin: { mcp: { requiredConfig: { company: {} } } } },
  ]) {
    const text = JSON.stringify(config);
    await writeFile(h.managed, text);
    assert.equal((await h.geminiStatus()).signedIn, null);
    await assert.rejects(h.geminiEstimate(request), /incompatible/);
    assert.equal(await readFile(h.managed, 'utf8'), text);
  }
  assert.deepEqual(h.calls, []);
});

test('compatible JSONC policy is retained, and unlisted models never receive a prompt', async t => {
  const h = await fixture(t, [catalog]);
  await mkdir(path.join(h.home, '.gemini'));
  await writeFile(path.join(h.home, '.gemini/settings.json'), '{ // A personal default\n "billing": {"overageStrategy":"always",}, }');
  await writeFile(h.managed, '{"security":{"auth":{"enforcedType":"oauth-personal"}}}');
  await assert.rejects(h.geminiEstimate({ ...request, model: 'unlisted-model' }), /current Gemini CLI catalog/);
  assert.equal(h.calls.length, 1);
});

test('invalid output, attempted tool use, and provider errors are rejected without leaking provider text', async t => {
  const h = await fixture(t, [
    catalog, { code: 0, stdout: JSON.stringify({ response: 'a regular answer' }) },
    catalog, { code: 0, stdout: JSON.stringify({ response: '{}', stats: { tools: { totalCalls: 1 } } }) },
    catalog, { code: 1, stderr: 'Private account details should remain private', stdout: '' },
  ]);
  await assert.rejects(h.geminiEstimate(request), /invalid JSON/);
  await assert.rejects(h.geminiEstimate(request), /requested a tool/);
  await assert.rejects(h.geminiEstimate(request), { message: 'Gemini CLI could not finish. Check Google sign-in and your plan’s usage limit.' });
});
