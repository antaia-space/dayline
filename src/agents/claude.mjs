import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cliEnv, findCli, runCli } from './cli.mjs';

const suggestions = ['haiku', 'sonnet', 'opus'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
const modelId = /^[a-z0-9][a-z0-9._:/-]{0,119}$/i;
const plans = { pro: 'Pro', max: 'Max', ultra: 'Ultra', team: 'Team', enterprise: 'Enterprise' };

// --bare disables the subscription login. Safe and restricted modes retain the
// native login while skipping user/project customizations. Managed policy still applies.
const isolate = [
  '--safe-mode', '--restricted', '--setting-sources', '', '--strict-mcp-config',
  '--settings', JSON.stringify({ disableAllHooks: true, disableWorkflows: true }),
];

function environment() {
  const env = cliEnv();
  delete env.GOOGLE_CLOUD_PROJECT;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

async function inEmptyDirectory(work) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dayline-claude-'));
  try {
    await chmod(cwd, 0o500);
    return await work(cwd);
  } finally {
    await chmod(cwd, 0o700);
    await rm(cwd, { recursive: true, force: true });
  }
}

function accountStatus(reply) {
  const status = { installed: true, signedIn: false, models: suggestions };
  let auth;
  try { auth = JSON.parse(reply.stdout); } catch { /* Handle unsupported or unavailable clients below. */ }
  if (auth?.loggedIn !== true || reply.code !== 0) {
    status.detail = auth?.loggedIn === false ? 'Sign in to Claude Code with your Claude subscription.' :
      'The Claude Code client could not verify sign-in. Update the official client and check again.';
    return status;
  }
  const plan = typeof auth.subscriptionType === 'string' ? auth.subscriptionType.toLowerCase() : '';
  if (auth.authMethod !== 'claude.ai' || auth.apiProvider !== 'firstParty' || !Object.hasOwn(plans, plan) ||
      (auth.apiKeySource && auth.apiKeySource !== 'none')) {
    status.detail = 'Claude Code must report a first-party Claude subscription. Sign in through the official client and check again.';
    return status;
  }
  return { ...status, signedIn: true, plan: plans[plan], detail: 'Using the subscription signed in to Claude Code.' };
}

const count = value => Number.isSafeInteger(value) && value >= 0;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function usageTotals(overall, models) {
  function field(top, perModel) {
    if (count(overall?.[top])) return overall[top];
    if (!models.length || !models.every(([, data]) => count(data?.[perModel]))) return undefined;
    const sum = models.reduce((total, [, data]) => total + data[perModel], 0);
    return count(sum) ? sum : undefined;
  }
  const uncached = field('input_tokens', 'inputTokens');
  const cacheRead = field('cache_read_input_tokens', 'cacheReadInputTokens');
  const cacheWrite = field('cache_creation_input_tokens', 'cacheCreationInputTokens');
  const output = field('output_tokens', 'outputTokens');
  const result = {};
  // Anthropic reports three separate input buckets. Dayline's input total
  // includes cache reads and writes, with cache reads also shown as a subset.
  if (count(uncached)) {
    const total = uncached + (cacheRead ?? 0) + (cacheWrite ?? 0);
    if (count(total)) result.inputTokens = total;
  }
  if (count(cacheRead)) result.cachedInputTokens = cacheRead;
  if (count(output)) result.outputTokens = output;
  return result;
}

function parseEstimate(reply, requested) {
  if (reply.code !== 0) throw new Error('Claude Code could not complete the estimate. Check the subscription sign-in and usage limit.');
  let run;
  try { run = JSON.parse(reply.stdout); } catch { throw new Error('Claude Code returned an unreadable estimate.'); }
  if (run?.type !== 'result' || run.subtype !== 'success' || run.is_error !== false || !isObject(run.structured_output)) {
    throw new Error('Claude Code did not return a valid structured estimate.');
  }
  const models = Object.entries(isObject(run.modelUsage) ? run.modelUsage : {}).filter(([name, value]) => modelId.test(name) && isObject(value));
  let model = models.length === 1 ? models[0][0] : undefined;
  if (models.length > 1) {
    const names = models.map(([name]) => name);
    if (names.includes(requested)) model = requested;
    else if (requested) {
      const matches = names.filter(name => name.split('-').includes(requested));
      if (matches.length === 1) model = matches[0];
    }
  }
  return { output: run.structured_output, model, usage: usageTotals(run.usage, models) };
}

export function createClaudeAdapter({ locate = findCli, run = runCli } = {}) {
  async function inspect(binary, cwd, env) {
    try {
      const reply = await run(binary, [...isolate, 'auth', 'status', '--json'], { cwd, env, timeoutMs: 12000, maxBytes: 65536 });
      return accountStatus(reply);
    } catch {
      return { installed: true, signedIn: false, detail: 'The Claude Code client could not verify your subscription sign-in.', models: suggestions };
    }
  }

  async function claudeStatus() {
    const binary = locate('claude');
    if (!binary) return { installed: false, signedIn: false, detail: 'Install the official Claude Code CLI to connect your subscription.', models: suggestions };
    return inEmptyDirectory(cwd => inspect(binary, cwd, environment()));
  }

  async function claudeEstimate({ model = '', instructions, input, schema }) {
    if (typeof model !== 'string' || (model && !modelId.test(model))) throw new Error('Choose a model with a valid Claude model ID.');
    if (!isObject(input) || typeof instructions !== 'string' || !instructions.trim() || !isObject(schema)) throw new Error('Claude Code received an invalid estimate request.');
    const binary = locate('claude');
    if (!binary) throw new Error('Install the official Claude Code CLI to estimate with your subscription.');
    return inEmptyDirectory(async cwd => {
      const env = environment();
      const verified = await inspect(binary, cwd, env);
      if (!verified.signedIn) throw new Error(verified.detail);
      const args = [
        ...isolate, '-p', '--no-session-persistence', '--no-chrome', '--disable-slash-commands',
        '--tools', '', '--disallowedTools', 'mcp__*', '--permission-mode', 'dontAsk',
        '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--system-prompt', instructions,
      ];
      if (model) args.push('--model', model);
      let reply;
      try {
        reply = await run(binary, args, { cwd, env, input: JSON.stringify(input) + '\n', timeoutMs: 65000, maxBytes: 1000000 });
      } catch { throw new Error('Claude Code could not finish the estimate before the local client deadline.'); }
      return parseEstimate(reply, model);
    });
  }
  return { claudeStatus, claudeEstimate };
}

export const { claudeStatus, claudeEstimate } = createClaudeAdapter();
