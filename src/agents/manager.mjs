import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { CATEGORIES, estimateTask } from '../planner.mjs';
import { localStatus, makeEstimator } from '../estimate.mjs';
import { durationCalibration, localTaskTitle, validTaskTitle, verifiedTaskTitle } from '../task-learning.mjs';
import { findCli, openProviderLogin } from './cli.mjs';
import { codexEstimate, codexModel, codexStatus } from './codex.mjs';
import { googleAgent } from './google.mjs';
import { claudeEstimate, claudeStatus } from './claude.mjs';

export { codexModel };
const instructions = readFileSync(new URL('./instructions.md', import.meta.url), 'utf8');
const commandInstructions = readFileSync(new URL('./command-instructions.md', import.meta.url), 'utf8');
const commandSchema = { type:'object', additionalProperties:false, required:['intent','subject','instruction'], properties:{
  intent:{type:'string',enum:['change','create','clarify']}, subject:{type:'string'}, instruction:{type:'string'}
} };
const comparable = text => text.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const providers = {
  codex: { status: codexStatus, estimate: codexEstimate },
  gemini: googleAgent,
  claude: { status: claudeStatus, estimate: claudeEstimate }
};
const categories = CATEGORIES.map(category => category.id);
const nullable = { type: ['string', 'null'] };
const properties = {
  title: { type: 'string' },
  subtasks: { type: 'array', items: { type: 'string' } },
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

export function agentSelection(input) {
  const provider = providerId(input?.provider);
  const model = input.model === undefined ? '' : input.model;
  if (typeof model !== 'string' || (model && (!modelId.test(model) || provider === 'local'))) {
    throw badRequest('Choose a valid model for this agent.');
  }
  return provider === 'codex' ? { provider, model: model || codexModel, effort: 'low' } : { provider, model };
}

function usageFields(usage = {}) {
  return Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens'].filter(key =>
    Number.isSafeInteger(usage[key]) && usage[key] >= 0).map(key => [key, usage[key]]));
}

function checked(output, text) {
  const fail = () => { throw new Error('The agent returned an estimate that Dayline could not use.'); };
  if (!output || Array.isArray(output) || typeof output !== 'object' ||
    Object.keys(output).some(key => !Object.hasOwn(properties, key)) ||
    estimateSchema.required.some(key => key !== 'title' && key !== 'subtasks' && !Object.hasOwn(output, key))) fail();
  // Older adapters can still supply estimates with locally inferred titles and checklists.
  if (Object.hasOwn(output, 'title') && !validTaskTitle(output.title)) fail();
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
  return { ...output, title: output.title ? verifiedTaskTitle(output.title.trim(), text) : localTaskTitle(text) };
}

export class TaskAgents {
  constructor({ store, helperPath = null, adapters = providers, launchLogin = openProviderLogin }) {
    this.store = store;
    this.helperPath = helperPath;
    this.local = makeEstimator(helperPath);
    this.adapters = adapters;
    this.launchLogin = launchLogin;
    const saved = store.state.agent;
    if (saved && (!Number.isSafeInteger(saved.selectedAt) || (saved.provider === 'codex' && (!saved.model || saved.effort !== 'low')))) {
      Object.assign(saved, this.selected, { selectedAt: Number.isSafeInteger(saved.selectedAt) ? saved.selectedAt : Date.now() });
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

  select(input) {
    const selection = agentSelection(input);
    const previous = this.store.state.agent;
    const same = this.selected.provider === selection.provider && this.selected.model === selection.model;
    const selectedAt = same && Number.isSafeInteger(previous?.selectedAt) ? previous.selectedAt : Date.now();
    this.store.state.agent = { ...selection, selectedAt, lastRun: previous?.lastRun || null };
    try { this.store.save(); }
    catch (error) { this.store.state.agent = previous; throw error; }
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

  async interpretCommand(text, { now, timeZone, selection = this.selected }) {
    const {provider,model} = selection;
    if (provider === 'local') return { intent:'clarify' };
    const when = DateTime.fromJSDate(now,{zone:timeZone});
    const input = { text, today:when.toISODate(), currentTime:when.toFormat('HH:mm'), timeZone };
    const response = await this.adapters[provider].estimate({model,instructions:commandInstructions,input,schema:commandSchema});
    if (provider === 'codex' && (response.model !== model || response.effort !== 'low')) {
      throw new Error('Codex did not confirm the requested model and reasoning effort.');
    }
    const claudeAlias = provider === 'claude' && ['haiku','sonnet','opus'].includes(model) && response.model?.split('-').includes(model);
    if (model && response.model !== model && !claudeAlias) throw new Error('The agent did not confirm the selected model.');
    const agent = { ...selection, model:response.model || model, ...usageFields(response.usage) };
    const output = response.output;
    if (output?.intent === 'create') return {intent:'create',agent};
    if (output?.intent !== 'change' || typeof output.subject !== 'string' || !output.subject.trim() ||
        typeof output.instruction !== 'string' || !output.instruction.trim() || output.instruction.length > 1000) return { intent:'clarify',agent };
    const subject = comparable(output.subject), instruction = comparable(output.instruction), source = comparable(text);
    const bulk = /\b(?:all|every|each|both|all of|tous|toutes|todos|todas|alle|beide)\b/u;
    if (!source.includes(subject) || !instruction.includes(subject) || (bulk.test(instruction) && !bulk.test(source))) return {intent:'clarify',agent};
    const relative = /^(?:move|put|prioriti[sz]e)\s+.+?\s+(?:before|after|ahead of|behind)\s+(?:the\s+)?(.+?)(?:\s+task)?[.!]?$/iu.exec(instruction);
    if (relative && !source.includes(relative[1])) return {intent:'clarify',agent};
    return { intent:'change', instruction:output.instruction.trim(), agent };
  }

  async estimate(text, context) {
    const requested = context.selection || this.selected;
    const selection = requested.provider === 'codex'
      ? { provider: 'codex', model: requested.model || codexModel, effort: 'low' } : requested;
    const { provider, model } = selection;
    const now = DateTime.fromJSDate(context.now, { zone: context.timeZone });
    // A retry interprets relative dates at capture time and receives a fresh usage timestamp.
    const run = { ...selection, at: new Date().toISOString(), outcome: 'success' };
    const rules = { ...estimateTask(text, context), title: localTaskTitle(text) };
    let result = rules;
    if (provider === 'local') {
      result = await this.local(text, context);
      run.model = result.engine === 'apple' ? 'Apple Foundation Models' : 'Built-in rules';
    } else {
      const { workDays, startTime, endTime } = context.workHours || this.store.state.settings;
      const input = { task: text, today: now.toISODate(), currentTime: now.toFormat('HH:mm'),
        timeZone: context.timeZone, workDays, startTime, endTime };
      const previous = !rules.explicitMinutes && durationCalibration(this.store.state, text, rules.category, context.taskId);
      if (previous) input.durationHistory = { activity: previous.activity, sampleCount: previous.sampleCount };
      try {
        const response = await this.adapters[provider].estimate({ model, instructions, input, schema: estimateSchema });
        if (provider === 'codex' && (response.model !== model || response.effort !== 'low')) {
          throw new Error('Codex did not confirm the requested model and reasoning effort.');
        }
        if (typeof response.model === 'string' && modelId.test(response.model)) run.model = response.model;
        Object.assign(run, usageFields(response.usage));
        const proposal = checked(response.output, text);
        const minutes = rules.explicitMinutes ? rules.minutes : proposal.minutes;
        const fixed = estimateTask(text, { ...context, estimatedMinutes: minutes });
        const knownDays = Boolean(fixed.earliestDay || fixed.latestDay);
        const knownWindow = Boolean(fixed.windowStart || fixed.windowEnd);
        result = { ...rules, title: proposal.title, subtasks: proposal.subtasks, category: proposal.category, minutes, reason: rules.explicitMinutes ? rules.reason : proposal.reason.trim(),
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
    if (!result.pendingEstimate) {
      const baseMinutes = result.minutes;
      const history = !rules.explicitMinutes && durationCalibration(this.store.state, text, result.category, context.taskId);
      const minutes = history?.changeMinutes ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, baseMinutes + history.changeMinutes)) : baseMinutes;
      result = { ...result, title: result.title || rules.title, baseMinutes, estimatedMinutes: minutes, minutes };
      if (minutes !== baseMinutes) {
        const fixed = estimateTask(text, { ...context, estimatedMinutes: minutes });
        if (fixed.windowStart || fixed.windowEnd) Object.assign(result, { windowStart: fixed.windowStart, windowEnd: fixed.windowEnd });
        const delta = Math.abs(minutes - baseMinutes);
        result.reason += ` Your past edits ${minutes > baseMinutes ? 'add' : 'subtract'} ${delta} ${delta === 1 ? 'minute' : 'minutes'}.`;
      }
    }
    // Queued work is committed by the service only if that estimate is still
    // current. An older in-flight request must not replace the latest receipt.
    if (!context.selection) this.store.state.agent = { ...this.store.state.agent, ...this.selected, lastRun: run };
    return { ...result, agent: run };
  }
}
