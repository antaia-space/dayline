import { IANAZone } from 'luxon';
import { invalid } from './service.mjs';

const idPattern = /^[a-f0-9]{32}$/;
const alternative = /\b(?:instead|would (?:work|fit|suit|be) better|better (?:day|time) for|work better (?:for|on|at)|rather (?:do|finish|tackle|work on)|(?:can|could) wait until|should (?:now|actually) (?:be|happen)|is better (?:on|at|for))\b/iu;
const indirect = /\b(?:(?:can|could) (?:we|you) (?:fit|bump|bring|squeeze|prioriti[sz]e)|bring .+? (?:forward|back)|(?:make|keep|leave) (?:some |more |my )?(?:room|time|morning|afternoon) (?:free|open|for)|verschiebe|verschieben|verlege|déplace|repousse|reprograma|traslada|reagenda)\b/iu;
const existingReference = /\b(?:(?:the|that|this|my|existing|current|scheduled|unfinished)\s+(?:[^.!?]{1,70}\s)?(?:task|to-?do)|(?:task|to-?do)\s+(?:named|called)|already (?:on|in) my (?:list|plan))\b/iu;
const timing = /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|minutes?|hours?|earlier|later|first|last|longer|shorter|done|complete|reopen|\d{1,2}:\d{2})\b/iu;

function mayNeedInterpretation(text) {
  if (/^(?:(?:please|can you)\s+)?(?:add|create|capture|write down) (?:a |an )?(?:new )?(?:task|to-?do)\b/iu.test(text.trim())) return false;
  return alternative.test(text) || indirect.test(text) || (existingReference.test(text) && timing.test(text));
}
const clarification = 'Which task should change, and how? For example, “Move the budget review to Wednesday.”';

function forComposer(result) {
  if (result.kind === 'task' || (result.kind === 'create' && result.id)) return {id:result.id};
  const status = {applied:'applied','needs-choice':'choice','no-match':'unmatched',unparsed:'clarify',clarification:'clarify'}[result.kind] || 'clarify';
  return {kind:'command',status,message:result.message || clarification,taskIds:result.taskIds || [],
    ...(result.candidates?.length && {choices:result.candidates.map(({id,title,detail,day})=>({id,title,detail:detail || day || ''}))})};
}

export function createCaptureHandler(service, agents) {
  const interpreting = new Map();

  // Only local matching and applying an edit hold the shared planner lock.
  // Another task can be captured or checked off throughout a subscription call.
  async function evaluate(body, interpretedText) {
    return service.run(async () => {
      const result = await service.runPlannerCommand(body,interpretedText ? {interpretedText} : {});
      if (result.kind !== 'create') return result;
      if (result.id) return {kind:'task',id:result.id};
      if (interpretedText) return {kind:'unparsed',message:clarification};
      if (!body.forceCreate && mayNeedInterpretation(body.text)) return {kind:'suggestion'};
      return {kind:'task',id:service.enqueueTask(body)};
    });
  }

  async function interpret(body, first) {
    if (!agents?.interpretCommand) return forComposer({...first,kind:'unparsed'});
    const now = service.clock();
    const captured = new Date(body.capturedAt ?? now);
    if (!Number.isFinite(captured.getTime())) throw invalid('Choose a valid capture time.');
    const when = captured > now ? now : captured;
    const zone = body.captureTimeZone || service.data.settings.timeZone;
    if (zone !== 'UTC' && !IANAZone.isValidZone(zone)) throw invalid('Choose a valid capture time zone.');
    const selection = service.captureSelection(body.captureAgent,when.toISOString()) || agents.selected;
    if (selection?.provider === 'local') return forComposer({...first,kind:'unparsed'});
    let proposal;
    try { proposal = await agents.interpretCommand(body.text,{now:when,timeZone:zone,selection}); }
    catch { return {kind:'command',status:'clarify',message:'The selected agent could not interpret that change. '+clarification}; }
    if (proposal.intent === 'create' && first.kind === 'suggestion') {
      return forComposer(await evaluate({...body,forceCreate:true}));
    }
    const resolved = proposal.intent === 'change' ? await evaluate(body,proposal.instruction) : first;
    const result = ['unparsed','suggestion'].includes(resolved.kind)
      ? await service.run(() => service.settlePlannerClarification(body,resolved.message || clarification)) : resolved;
    const outcome = forComposer(result);
    if (proposal.agent) outcome.agent = proposal.agent;
    return outcome;
  }

  return async body => {
    if (typeof body.requestId !== 'string' || !idPattern.test(body.requestId) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1000) {
      throw invalid('Enter a task or planner instruction between 1 and 1,000 characters.');
    }
    if ((body.chosenTaskId != null && !idPattern.test(body.chosenTaskId)) ||
        (body.forceCreate != null && typeof body.forceCreate !== 'boolean') || (body.chosenTaskId && body.forceCreate)) throw invalid('Choose a single planner action.');
    const first = await evaluate(body);
    if (first.kind !== 'unparsed' && first.kind !== 'suggestion') return forComposer(first);
    if (body.chosenTaskId || body.forceCreate || body.retryMatch) return forComposer(first);
    const fingerprint = JSON.stringify([body.text,body.capturedAt,body.captureTimeZone,body.day,body.viewDay,body.contextDay]);
    const prior = interpreting.get(body.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw invalid('This capture already has different wording.',409);
      return prior.promise;
    }
    const promise = interpret(body,first);
    interpreting.set(body.requestId,{fingerprint,promise});
    try { return await promise; }
    finally { interpreting.delete(body.requestId); }
  };
}
