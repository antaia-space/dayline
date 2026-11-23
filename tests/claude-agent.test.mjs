import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir, stat } from 'node:fs/promises';
import { createClaudeAdapter } from '../src/agents/claude.mjs';

const subscription = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'team' };
const task = { task: 'Draft a release note', today: '2026-11-23', currentTime: '08:00', timeZone: 'UTC',
  workDays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' };
const estimate = { model: 'sonnet', instructions: 'Estimate the task in supplied JSON.', input: task, schema: {
  type: 'object', properties: { minutes: { type: 'integer' } }, required: ['minutes'], additionalProperties: false,
} };
const result = { type: 'result', subtype: 'success', is_error: false, structured_output: { minutes: 45 },
  modelUsage: { 'claude-sonnet-example': { inputTokens: 5, outputTokens: 12, cacheReadInputTokens: 11, cacheCreationInputTokens: 2 } } };

function setup(auth = subscription, generation = result) {
  const calls = [];
  const fake = createClaudeAdapter({
    locate: provider => { assert.equal(provider, 'claude'); return '/fixture/official-claude'; },
    run: async (binary, args, options) => {
      const generationCall = args.includes('-p');
      assert.equal(binary, '/fixture/official-claude');
      calls.push({ args, options });
      assert.deepEqual(await readdir(options.cwd), []);
      assert.equal((await stat(options.cwd)).mode & 0o777, 0o500);
      const response = generationCall ? generation : auth;
      if (response instanceof Error) throw response;
      return { stdout: JSON.stringify(response), stderr: 'simulated private diagnostic', code: 0 };
    },
  });
  return { ...fake, calls };
}

test('Claude status reports subscription metadata without identity or credential output', async () => {
  const mock = setup({ ...subscription, email: 'person@example.test', orgId: 'private-test-organization' });
  const status = await mock.claudeStatus();
  assert.equal(status.installed, true);
  assert.equal(status.signedIn, true);
  assert.equal(status.plan, 'Team');
  assert.deepEqual(status.models.map(model => model.id), ['haiku', 'sonnet', 'opus']);
  assert.doesNotMatch(JSON.stringify(status), /person@example|private-test-organization/);
  assert.deepEqual(mock.calls[0].args.slice(-3), ['auth', 'status', '--json']);
  assert.equal(mock.calls.length, 1);
  await assert.rejects(access(mock.calls[0].options.cwd), { code: 'ENOENT' });
});

test('Claude rejects non-subscription routes before any task data is passed to the client', async () => {
  for (const overrides of [
    { loggedIn: false }, { authMethod: 'api_key' }, { authMethod: 'api_key_helper' },
    { authMethod: 'third_party' }, { authMethod: 'oauth_token' }, { apiProvider: 'bedrock' },
    { apiProvider: 'vertex' }, { apiProvider: 'foundry' }, { apiKeySource: '/login managed key' },
    { subscriptionType: null }, { subscriptionType: 'console' }, { apiProvider: null },
  ]) {
    const mock = setup({ ...subscription, ...overrides });
    await assert.rejects(mock.claudeEstimate(estimate), /Claude|subscription/);
    assert.equal(mock.calls.length, 1, JSON.stringify(overrides));
    assert.equal(mock.calls[0].options.input, undefined);
    await assert.rejects(access(mock.calls[0].options.cwd), { code: 'ENOENT' });
  }
});

test('Claude estimate sends just the task context over stdin with tools and persistence disabled', async () => {
  const mock = setup();
  const answer = await mock.claudeEstimate(estimate);
  assert.deepEqual(answer, { output: { minutes: 45 }, model: 'claude-sonnet-example',
    usage: { inputTokens: 18, outputTokens: 12, cachedInputTokens: 11 } });
  assert.equal(mock.calls.length, 2);
  const [{ args: status, options: statusOptions }, { args, options }] = mock.calls;
  assert.equal(statusOptions.cwd, options.cwd);
  assert.equal(statusOptions.env, options.env);
  for (const invocation of [args, status]) {
    for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config']) assert.ok(invocation.includes(flag));
    assert.equal(invocation[invocation.indexOf('--setting-sources') + 1], '');
    assert.equal(JSON.parse(invocation[invocation.indexOf('--settings') + 1]).disableAllHooks, true);
    assert.ok(!invocation.includes('--bare'));
    assert.ok(!invocation.includes('--dangerously-skip-permissions'));
  }
  for (const flag of ['-p', '--no-session-persistence', '--disable-slash-commands', '--no-chrome']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'mcp__*');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.equal(args[args.indexOf('--system-prompt') + 1], estimate.instructions);
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), estimate.schema);
  for (const key of Object.keys(options.env)) assert.doesNotMatch(key, /API_KEY|AUTH_TOKEN|AWS_|GOOGLE_|AZURE_|ANTHROPIC_|OAUTH|BASE_URL/);
  assert.ok(!args.some(arg => arg.includes(task.task)));
  assert.deepEqual(JSON.parse(options.input), task);
  await assert.rejects(access(options.cwd), { code: 'ENOENT' });
});

test('Claude leaves the model default to the client and reads actual aggregate token buckets', async () => {
  const mock = setup(subscription, { ...result, usage: {
    input_tokens: 8, cache_creation_input_tokens: 4, cache_read_input_tokens: 13, output_tokens: 7,
  }, modelUsage: { 'claude-haiku-example': {} } });
  const answer = await mock.claudeEstimate({ ...estimate, model: '' });
  assert.ok(!mock.calls[1].args.includes('--model'));
  assert.equal(answer.model, 'claude-haiku-example');
  assert.deepEqual(answer.usage, { inputTokens: 25, cachedInputTokens: 13, outputTokens: 7 });
});

test('Claude supports explicit model IDs, avoids guessing an unreported model and preserves missing usage', async () => {
  const exact = setup(subscription, { ...result, modelUsage: {
    'claude-small-test': { inputTokens: 2 }, 'claude-main-test': { inputTokens: 3 },
  } });
  const selected = await exact.claudeEstimate({ ...estimate, model: 'claude-main-test' });
  assert.equal(selected.model, 'claude-main-test');
  assert.deepEqual(selected.usage, { inputTokens: 5 });
  const omitted = setup(subscription, { ...result, modelUsage: undefined });
  const answer = await omitted.claudeEstimate({ ...estimate, model: '' });
  assert.equal(answer.model, undefined);
  assert.deepEqual(answer.usage, {});
});

test('Claude returns controlled failures on invalid input, missing CLI, timeouts and rejected output', async () => {
  const missing = createClaudeAdapter({ locate: () => null, run: () => assert.fail('No CLI should run') });
  assert.equal((await missing.claudeStatus()).installed, false);
  await assert.rejects(missing.claudeEstimate(estimate), /Install the official/);
  const invalid = setup();
  await assert.rejects(invalid.claudeEstimate({ ...estimate, model: '--settings' }), /valid Claude model/);
  await assert.rejects(invalid.claudeEstimate({ ...estimate, input: null }), /invalid estimate request/);
  assert.equal(invalid.calls.length, 0);
  for (const response of [
    { ...result, is_error: true, result: 'sensitive provider error' },
    { ...result, structured_output: null }, { ...result, subtype: 'error_max_structured_output_retries' },
    { ...result, structured_output: [] }, new Error('sensitive timeout detail'),
  ]) {
    const mock = setup(subscription, response);
    await assert.rejects(mock.claudeEstimate(estimate), error => {
      assert.match(error.message, /^Claude Code /);
      assert.doesNotMatch(error.message, /sensitive|simulated private/);
      return true;
    });
    await assert.rejects(access(mock.calls[0].options.cwd), { code: 'ENOENT' });
  }
});
