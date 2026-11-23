import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { CATEGORIES, estimateTask } from '../planner.mjs';
import { localStatus, makeEstimator } from '../estimate.mjs';
import { findCli, openProviderLogin } from './cli.mjs';
import { codexEstimate, codexStatus } from './codex.mjs';
import { googleAgent } from './google.mjs';
import { claudeEstimate, claudeStatus } from './claude.mjs';

export const codexModel = 'gpt-6.2-sol';
const instructions = readFileSync(new URL('./instructions.md', import.meta.url), 'utf8');
const providers = {
  codex: { status: codexStatus, estimate: codexEstimate },
  gemini: googleAgent,
  claude: { status: claudeStatus, estimate: claudeEstimate }
};
const categories = CATEGORIES.map(category => category.id);
const nullable = { type: ['string', 'null'] };
const properties = {
  category: { type: 'string', enum: categories },
  minutes: { type: 'integer' },
  earliestDay: nullable, latestDay: nullable, windowStart: nullable, windowEnd: nullable, deadlineTime: nullable,
  reason: { type: 'string' }
};
export const estimateSchema = { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
const modelId = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/;
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const day = /^\d{4}-\d{2}-\d{2}$/;
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
function providerId(value) {
  if (typeof value !== 'string' || (value !== 'local' && !Object.hasOwn(providers, value))) throw badRequest('Choose a task agent from the list.');
  return value;
}

function usageFields(usage = {}) {
  return Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens'].filter(key =>
    Number.isSafeInteger(usage[key]) && usage[key] >= 0).map(key => [key, usage[key]]));
}

function checked(output) {
  const fail = () => { throw new Error('The agent returned an estimate that Dayline could not use.'); };
  if (!output || Array.isArray(output) || typeof output !== 'object' ||
    Object.keys(output).some(key => !Object.hasOwn(properties, key)) ||
    estimateSchema.required.some(key => !Object.hasOwn(output, key))) fail();
  if (!categories.includes(output.category) || !Number.isSafeInteger(output.minutes) || output.minutes < 1 ||
    output.minutes > 1440 || typeof output.reason !== 'string' || !output.reason.trim() || output.reason.length > 400) fail();
  for (const key of ['earliestDay', 'latestDay']) {
    const value = output[key];
    if (value !== null && (typeof value !== 'string' || !day.test(value) ||
      DateTime.fromISO(value, { zone: 'utc' }).toISODate() !== value)) fail();
  }
  for (const key of ['windowStart', 'windowEnd', 'deadlineTime']) {
    const value = output[key];
    if (value !== null && (typeof value !== 'string' || (!clock.test(value) && !(key !== 'windowStart' && value === '24:00')))) fail();
  }
  if ((output.earliestDay && output.latestDay && output.earliestDay > output.latestDay) ||
      (output.windowStart && output.windowEnd && output.windowStart >= output.windowEnd) ||
      (output.deadlineTime && !output.latestDay)) fail();
  return output;
}

export class TaskAgents {
  constructor({ store, helperPath = null, adapters = providers, launchLogin = openProviderLogin }) {
    this.store = store;
    this.helperPath = helperPath;
    this.local = makeEstimator(helperPath);
    this.adapters = adapters;
    this.launchLogin = launchLogin;
    const saved = store.state.agent;
    if (saved?.provider === 'codex' && (!saved.model || saved.effort !== 'low')) {
      Object.assign(saved, { model: saved.model || codexModel, effort: 'low' });
      store.save();
    }
  }

  get selected() {
    const { provider = 'local', model = '' } = this.store.state.agent || {};
    return provider === 'codex' ? { provider, model: model || codexModel, effort: 'low' } : { provider, model };
  }

  async status(provider = this.selected.provider) {
    providerId(provider);
    const info = provider === 'local' ? await localStatus(this.helperPath) : await this.adapters[provider].status();
    const fixed = provider === 'codex' ? { defaultModel: codexModel, effort: 'low' } : {};
    return { ...info, ...fixed, provider, selected: this.selected, lastRun: this.store.state.agent?.lastRun || null };
  }

  select({ provider, model = '' }) {
    providerId(provider);
    if (typeof model !== 'string' || (model && (!modelId.test(model) || provider === 'local'))) throw badRequest('Choose a valid model for this agent.');
    const lastRun = this.store.state.agent?.lastRun || null;
    this.store.state.agent = provider === 'codex'
      ? { provider, model: model || codexModel, effort: 'low', lastRun }
      : { provider, model, lastRun };
    this.store.save();
    return this.selected;
  }

  async login({ provider }) {
    providerId(provider);
    if (provider === 'local') throw badRequest('The local estimator is available on this Mac.');
    try { await this.launchLogin(provider === 'gemini' && findCli('agy') ? 'agy' : provider); }
    catch { throw badRequest('Dayline could not open the official client. Install it on this Mac and check again.'); }
    const choice = { codex: 'Sign in with ChatGPT', gemini: 'Google OAuth for your Google account', claude: 'your Claude subscription' }[provider];
    return { message: 'In the official client, choose ' + choice + '. Finish sign-in, then choose Check sign-in in Dayline.' };
  }

  async estimate(text, context) {
    const selection = this.selected;
    const { provider, model } = selection;
    const now = DateTime.fromJSDate(context.now, { zone: context.timeZone });
    // A retry interprets relative dates at capture time and receives a fresh usage timestamp.
    const run = { ...selection, at: new Date().toISOString(), outcome: 'success' };
    const rules = estimateTask(text, context);
    let result = rules;
    if (provider === 'local') {
      result = await this.local(text, context);
      run.model = result.engine === 'apple' ? 'Apple Foundation Models' : 'Built-in rules';
    } else {
      const { workDays, startTime, endTime } = this.store.state.settings;
      const input = { task: text, today: now.toISODate(), currentTime: now.toFormat('HH:mm'),
        timeZone: context.timeZone, workDays, startTime, endTime };
      try {
        const response = await this.adapters[provider].estimate({ model, instructions, input, schema: estimateSchema });
        if (provider === 'codex' && (response.model !== model || response.effort !== 'low')) {
          throw new Error('Codex did not confirm the requested model and reasoning effort.');
        }
        if (typeof response.model === 'string' && modelId.test(response.model)) run.model = response.model;
        Object.assign(run, usageFields(response.usage));
        const proposal = checked(response.output);
        const minutes = rules.explicitMinutes ? rules.minutes : proposal.minutes;
        const fixed = estimateTask(text, { ...context, estimatedMinutes: minutes });
        const knownDays = Boolean(fixed.earliestDay || fixed.latestDay);
        const knownWindow = Boolean(fixed.windowStart || fixed.windowEnd);
        result = { ...rules, category: proposal.category, minutes, reason: rules.explicitMinutes ? rules.reason : proposal.reason.trim(),
          earliestDay: knownDays ? fixed.earliestDay : proposal.earliestDay,
          latestDay: knownDays ? fixed.latestDay : proposal.latestDay,
          deadlineTime: knownDays ? fixed.deadlineTime : proposal.deadlineTime,
          windowStart: knownWindow ? fixed.windowStart : proposal.windowStart,
          windowEnd: knownWindow ? fixed.windowEnd : proposal.windowEnd };
      } catch (error) {
        run.outcome = 'pending';
        result = { ...rules, pendingEstimate: true, reason: 'Waiting for a model estimate.' };
        // Adapters emit curated client errors. Never persist CLI stderr or task input.
        const message = String(error?.message || '');
        run.notice = /^(?:Codex |Gemini |Claude |Antigravity |Google |The (?:agent|local|Codex|Gemini|Claude|Antigravity) |Install the official |Choose a model |Sign in to )/.test(message) &&
          message.length <= 190 && !/[\r\n]/.test(message) ? message : 'The selected model could not finish this estimate. Check the agent settings and retry.';
      }
    }
    // The service saves this record and the task together under its write queue.
    this.store.state.agent = { ...this.selected, lastRun: run };
    return { ...result, agent: run };
  }
}
