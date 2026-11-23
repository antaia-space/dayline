import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createAntigravityAdapter } from '../src/agents/antigravity.mjs';

const input = { task: 'Review the draft by Tuesday. /help @private-file', timeZone: 'America/Los_Angeles' };
const estimate = { instructions: 'Estimate time for the task.', input, schema: { type: 'object', properties: { minutes: { type: 'integer' } } } };

// A local ACP peer lets the tests inspect every request, including proving
// that signed-out, unsupported or ambiguous accounts never received a prompt.
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dayline-agy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'agy');
  const log = path.join(dir, 'calls.ndjson');
  const fake = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const options = ${JSON.stringify(options)};
if (process.argv[2] === 'agents') { process.stdout.write(options.missingAgent ? 'other-agent\\n' : 'dayline-task-estimator\\n'); process.exit(0); }
const record = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + '\\n');
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const args = process.argv.slice(2), home = path.dirname(args[args.indexOf('--gemini-dir') + 1]), cwd = process.cwd();
const read = file => fs.readFileSync(file, 'utf8');
const directory = path.join(home, '.gemini', 'config', 'agents', 'dayline-task-estimator');
const settings = JSON.parse(read(path.join(home, '.gemini', 'antigravity-cli', 'settings.json')));
record({ envKeys: Object.keys(process.env), cwd, home, credentialHome: process.env.HOME, args, settings,
  agent: read(path.join(directory, 'agent.md')), hooks: JSON.parse(read(path.join(directory, 'deny-tools.json'))) });
const selector = { id: 'model', type: 'select', category: 'model', currentValue: options.current || 'gemini-4-argon',
  options: [{ group: 'Google', options: [{ value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] },
    { value: 'gemini-pro-orchestrator', name: 'Orchestrator' }, { value: 'claude-opus', name: 'Claude Opus' },
    { value: 'claude-mask', name: 'Gemini 4 Argon' }] };
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); record(m); if (!m.method) return;
  let result;
  switch (m.method) {
    case 'initialize': result = { protocolVersion: 1, agentCapabilities: { _meta: { antigravity: { tier: !options.old } } },
      authMethods: [{ id: 'oauth-personal' }, { id: 'oauth-business' }] }; break;
    case 'session/new':
      if (options.signedOut) return send({ id: m.id, error: { code: -32000, message: 'sensitive@example.test access-key' } });
      result = { sessionId: 'scoped-session', _meta: { antigravity: { tier: options.tier === undefined ? { id: 'g1-pro-tier', name: 'Google AI Pro' } : options.tier } },
        configOptions: options.legacy ? undefined : [selector], models: { currentModelId: 'MODEL_PLACEHOLDER_M60',
          availableModels: [{ modelId: 'MODEL_PLACEHOLDER_M60', name: 'Gemini 3.8 Flash' }] } }; break;
    case 'session/set_config_option': result = { configOptions: [{ ...selector, currentValue: options.badPin ? 'claude' : m.params.value }] }; break;
    case 'session/set_model': result = {}; break;
    case 'session/prompt':
      if (options.permission) return send({ id: 101, method: 'session/request_permission', params: { sessionId: 'scoped-session', options: [{ optionId: 'yes', kind: 'allow_always' }] } });
      if (options.tool) return send({ method: 'session/update', params: { sessionId: 'scoped-session', update: { sessionUpdate: 'tool_call', toolCallId: 'x' } } });
      const chunks = options.malformed ? ['not valid json'] : ['{"minutes":', '35}'];
      for (const text of chunks) send({ method: 'session/update', params: { sessionId: 'scoped-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      result = { stopReason: 'end_turn', usage: { inputTokens: 42, outputTokens: 5, cachedReadTokens: 7 } }; break;
    default: return send({ id: m.id, error: { code: -32601, message: 'access-key' } });
  }
  send({ id: m.id, result });
});
`;
  await writeFile(binary, fake, { mode: 0o700 });
  const readLog = async () => (await readFile(log, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  return { ...createAntigravityAdapter(provider => { assert.equal(provider, 'agy'); return binary; }), readLog };
}

test('reports a missing official CLI without treating the desktop Antigravity app as an installation', async () => {
  const adapter = createAntigravityAdapter(() => null);
  assert.deepEqual((await adapter.agyStatus()).models, []);
  assert.equal((await adapter.agyStatus()).installed, false);
  await assert.rejects(adapter.agyEstimate(estimate), /Install the official Google Antigravity CLI/);
});

test('discovers the paid personal plan and only its direct Gemini models without an inference', async t => {
  const adapter = await fixture(t);
  const state = await adapter.agyStatus();
  assert.equal(state.signedIn, true);
  assert.equal(state.plan, 'Google AI Pro');
  assert.deepEqual(state.models, [{ id: 'gemini-4-argon', label: 'Gemini 4 Argon' }, { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }]);
  assert.equal(state.defaultModel, 'gemini-4-argon');
  assert.deepEqual((await adapter.readLog()).slice(1).map(x => x.method), ['initialize', 'session/new']);
});

test('rejects signed-out, free, enterprise, PAYG, contradictory and missing tier metadata before a prompt', async t => {
  for (const opts of [{ signedOut: true }, { old: true }, { tier: null },
    { tier: { name: 'Antigravity Starter Quota', id: 'free-tier' } }, { tier: { name: 'Gemini Enterprise Plus', id: 'gcp-ge-plus-tier' } },
    { tier: { name: 'Google AI Pro', id: 'pay-as-you-go' } }, { tier: { name: 'Google AI Pro', id: 'g1-ultra-tier' } }]) {
    const adapter = await fixture(t, opts);
    const state = await adapter.agyStatus();
    assert.notEqual(state.signedIn, true);
    assert.deepEqual(state.models, []);
    assert.doesNotMatch(JSON.stringify(state), /@|access-key/);
    await assert.rejects(adapter.agyEstimate(estimate), /Sign in to Antigravity|could not verify/);
    assert.ok((await adapter.readLog()).every(x => !['session/prompt', 'authenticate', 'logout'].includes(x.method)));
  }
});

test('pins one selected model in the same isolated paid session and returns structured text and reported usage', async t => {
  const adapter = await fixture(t, { tier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } });
  const result = await adapter.agyEstimate({ ...estimate, model: 'gemini-3.8-flash' });
  assert.deepEqual(result, { output: { minutes: 35 }, model: 'gemini-3.8-flash', usage: { inputTokens: 42, outputTokens: 5, cachedInputTokens: 7 } });
  const [launch, init, session, set, prompt] = await adapter.readLog();
  assert.deepEqual(init.params.clientCapabilities, {});
  assert.deepEqual(session.params.mcpServers, []);
  assert.ok(session.params._meta.antigravity.systemPrompt.append.includes(estimate.instructions));
  assert.ok(session.params._meta.antigravity.systemPrompt.append.includes(JSON.stringify(estimate.schema)));
  assert.deepEqual(session.params._meta.agy.disabledTools, ['send_message']);
  assert.equal(set.params.value, 'gemini-3.8-flash');
  assert.equal(prompt.params.sessionId, set.params.sessionId);
  assert.deepEqual(JSON.parse(prompt.params.prompt[0].text.split('\n').slice(1).join('\n')), input);
  // CoreFoundation may inject this locale hint when starting the child on macOS.
  assert.deepEqual(launch.envKeys.filter(key => key !== '__CF_USER_TEXT_ENCODING').sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR'].sort());
  assert.ok(launch.args.includes('--include-default-customizations=false'));
  assert.ok(launch.args.includes('--sandbox'));
  assert.ok(!launch.args.includes('--dangerously-skip-permissions'));
  assert.equal(launch.args[launch.args.indexOf('--gemini-dir') + 1], path.join(launch.home, '.gemini'));
  assert.equal(launch.credentialHome, homedir());
  assert.notEqual(launch.home, launch.credentialHome);
  assert.equal(launch.settings.useG1Credits, false);
  assert.equal(launch.settings.auth.type, 'oauth-personal');
  assert.equal(launch.settings.toolPermission, 'strict');
  assert.equal(launch.settings.allowNonWorkspaceAccess, false);
  assert.deepEqual(launch.settings.permissions.allow, []);
  for (const action of ['mcp(*)', 'unsandboxed(*)', 'command(*)', 'read_url(*)', 'read_file(*)', 'write_file(*)']) assert.ok(launch.settings.permissions.deny.includes(action));
  for (const text of ['excludeDefaultComponents: true', 'inheritCustomizations: false', 'inheritMcp: false', 'tools: []']) assert.ok(launch.agent.includes(text));
  assert.equal(launch.hooks.dayline.PreToolUse[0].matcher, '.*');
  assert.ok(launch.hooks.dayline.PreToolUse[0].hooks[0].command.includes('"decision":"deny"'));
  await assert.rejects(access(launch.home), { code: 'ENOENT' });
});

test('accepts upstream enum IDs if their live ACP catalog identifies a Gemini model', async t => {
  const adapter = await fixture(t, { legacy: true });
  assert.equal((await adapter.agyEstimate(estimate)).model, 'MODEL_PLACEHOLDER_M60');
  assert.ok((await adapter.readLog()).some(x => x.method === 'session/set_model' && x.params.modelId === 'MODEL_PLACEHOLDER_M60'));
});

test('requires a confirmed model pin before including the task in any request', async t => {
  for (const [opts, model] of [[{}, 'claude-opus'], [{ badPin: true }, 'gemini-4-argon']]) {
    const adapter = await fixture(t, opts);
    await assert.rejects(adapter.agyEstimate({ ...estimate, model }));
    assert.ok((await adapter.readLog()).every(x => x.method !== 'session/prompt'));
  }
});

test('rejects client permission requests, tool activity, and malformed estimates', async t => {
  for (const options of [{ permission: true }, { tool: true }, { malformed: true }]) {
    const adapter = await fixture(t, options);
    await assert.rejects(adapter.agyEstimate(estimate), /outside the text estimate|invalid JSON/);
    assert.ok((await adapter.readLog()).every(x => x.result?.outcome?.outcome !== 'selected'));
  }
});

test('refuses to open an ACP session if the CLI cannot load the isolated text-only agent', async t => {
  const adapter = await fixture(t, { missingAgent: true });
  await assert.rejects(adapter.agyEstimate(estimate), /could not complete/);
  await assert.rejects(adapter.readLog(), { code: 'ENOENT' });
});
