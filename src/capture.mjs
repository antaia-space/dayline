import { invalid } from './service.mjs';
import { agentPlanReceipt, applyAgentPlan, createPlanContext, previewAgentPlan } from './agent-plan.mjs';

const idPattern = /^[a-f0-9]{32}$/;
const alternative = /\b(?:instead|would (?:work|fit|suit|be) better|better (?:day|time) for|work better (?:for|on|at)|rather (?:do|finish|tackle|work on)|(?:can|could) wait until|should (?:now|actually) (?:be|happen)|is better (?:on|at|for))\b/iu;
const indirect = /\b(?:(?:can|could) (?:we|you) (?:fit|bump|bring|squeeze|prioriti[sz]e)|bring .+? (?:forward|back)|(?:make|keep|leave) (?:some |more |my )?(?:room|time|morning|afternoon) (?:free|open|for)|verschiebe|verschieben|verlege|déplace|repousse|reprograma|traslada|reagenda)\b/iu;
const existingReference = /\b(?:(?:the|that|this|my|existing|current|scheduled|unfinished)\s+(?:[^.!?]{1,70}\s)?(?:task|to-?do)|(?:task|to-?do)\s+(?:named|called)|already (?:on|in) my (?:list|plan))\b/iu;
const timing = /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|minutes?|hours?|earlier|later|first|last|longer|shorter|done|complete|reopen|\d{1,2}:\d{2})\b/iu;
const explicitCapture = /^(?:(?:please|can you)\s+)?(?:add|create|capture|write down) (?:a |an )?(?:new )?(?:task|to-?do)\b/iu;

// Common requests go straight to the right workflow. Ask planner accepts any
// wording, including requests that don't share a word with these shortcuts.
function wantsPlanner(text) {
  if (explicitCapture.test(text)) return false;
  const question = /^(?:what|which|when|why|how|who|where|is there|do I have|am I|should I)\b/iu;
  const checklistEdit = /\b(?:add|create|make|build|generate|rename|delete|remove|mark|reopen|check off|append|turn|give|split)\b.{0,90}\b(?:sub[ -]?tasks?|checklist|check[ -]?boxes)\b/iu;
  const breakdown = /\b(?:break\s+.+?\s+(?:down|into)|break down|split\s+.+?\s+into|turn\s+.+?\s+into\s+(?:steps|a plan)|(?:outline|suggest|add|plan) (?:the |some |a few |next )?steps)\b/iu;
  const compound = /(?:\b(?:and(?: then| also)?|then|also|plus)\b|[,;])\s+(?:(?:please|also|then)\s+)?(?:add|move|give|reserve|leave|rename|reopen|mark|extend|shorten|reschedule|prioriti[sz]e|check|set|increase|reduce|put|split|break)\b/iu;
  const goal = /\b(?:rebalanc\w*|reorgani[sz]\w*|rearrang\w*|triag\w*|reshuffl\w*|lighten|streamline|spread out|make room|make space|help me (?:plan|decide|figure)|fit (?:it |this |these |everything )?in|plan (?:out )?my (?:day|week))\b/iu;
  const plannerSubject = /\b(?:task|subtask|checklist|plan|deck|schedule|rename|reschedule|move|reopen|minutes?|hours?|before|after|(?:to|on) (?:today|tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))\b/iu;
  return question.test(text) || checklistEdit.test(text) || breakdown.test(text) ||
    (compound.test(text) && plannerSubject.test(text)) || goal.test(text);
}

function mayNeedInterpretation(text) {
  if (explicitCapture.test(text.trim())) return false;
  return alternative.test(text) || indirect.test(text) || (existingReference.test(text) && timing.test(text));
}
const clarification = 'Which task should change, and how? For example, “Move the budget review to Wednesday.”';

function forComposer(result) {
  if (result.kind === 'task' || (result.kind === 'create' && result.id)) return {id:result.id};
  const status = {applied:'applied',preview:'preview',answer:'answer','needs-choice':'choice','no-match':'unmatched',unparsed:'clarify',clarification:'clarify'}[result.kind] || 'clarify';
  return {kind:'command',status,message:result.message || clarification,taskIds:result.taskIds || [],
    ...(result.agent && {agent:result.agent}),
    ...(status === 'preview' && {planId:result.planId,steps:result.steps}),
    ...(result.reason === 'agent' && {contextual:true}),
    ...(result.candidates?.length && {choices:result.candidates.map(({id,title,detail,day})=>({id,title,detail:detail || day || ''}))})};
}

export function createCaptureHandler(service, agents) {
  const interpreting = new Map();

  // Only local matching and applying an edit hold the shared planner lock.
  // Another task can be captured or checked off throughout a subscription call.
  async function evaluate(body, interpretedText) {
    return service.run(async () => {
      if (!interpretedText && !body.forceCreate && !body.chosenTaskId && !body.retryMatch &&
          (body.askPlanner || wantsPlanner(body.text.trim()))) {
        const receipt = agentPlanReceipt(service,body.requestId,body.text);
        if (receipt) return receipt;
        const saved = service.data.plannerCommands?.[body.requestId]?.receipt;
        if (saved?.kind === 'needs-choice') return saved;
        return {kind:'suggestion',contextual:true};
      }
      const result = await service.runPlannerCommand(body,interpretedText ? {interpretedText} : {});
      if (result.kind !== 'create') return result;
      if (result.id) return {kind:'task',id:result.id};
      if (interpretedText) return {kind:'unparsed',message:clarification};
      if (!body.forceCreate && mayNeedInterpretation(body.text)) return {kind:'suggestion'};
      return {kind:'task',id:service.enqueueTask(body)};
    });
  }

  async function interpret(body, first) {
    const settle = (message,kind='clarification',agent) => service.run(() => service.settlePlannerClarification(body,message,
      {kind,reason:first.contextual ? 'agent' : 'syntax',agent}));
    const needsAgent = 'Choose a subscription in Settings → Task agent to ask about your plan or combine edits.';
    if (!agents?.interpretCommand) return forComposer(first.contextual ? await settle(needsAgent) : {...first,kind:'unparsed'});
    const {at,timeZone:zone} = service.captureContext(body);
    const when = new Date(at);
    const selection = service.captureSelection(body.captureAgent,at) || agents.selected;
    if (selection?.provider === 'local') return forComposer(first.contextual ? await settle(needsAgent) : {...first,kind:'unparsed'});
    const context = first.contextual ? await service.run(() => createPlanContext(service,{...body,capturedAt:at,captureTimeZone:zone})) : null;
    let proposal;
    try { proposal = await agents.interpretCommand(body.text,{now:when,timeZone:zone,selection,...(context && {planner:context.modelContext})}); }
    catch { return forComposer(await settle('The selected agent could not finish this request. Check its sign-in, then use Edit request to send it again.')); }
    if (context && proposal.intent === 'plan') {
      const result = await service.run(() => previewAgentPlan(service,body,context,proposal.actions,proposal.agent));
      return {...forComposer(result),contextual:true,agent:proposal.agent};
    }
    if (context && ['answer','clarify'].includes(proposal.intent)) {
      const result = await settle(proposal.message || clarification,proposal.intent === 'answer' ? 'answer' : 'clarification',proposal.agent);
      return {...forComposer(result),agent:proposal.agent};
    }
    if (body.askPlanner && proposal.intent === 'create') {
      return forComposer(await settle('This reads like a new to-do. Choose Add as new task to put it on your list.','clarification',proposal.agent));
    }
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
    if (body.askPlanner != null && typeof body.askPlanner !== 'boolean') throw invalid('Choose a valid entry mode.');
    if (body.applyPlanId != null) {
      if (typeof body.applyPlanId !== 'string' || !idPattern.test(body.applyPlanId) || body.chosenTaskId || body.forceCreate || body.retryMatch) throw invalid('Choose a single plan to apply.');
      return forComposer(await service.run(() => applyAgentPlan(service,{requestId:body.requestId,planId:body.applyPlanId,text:body.text})));
    }
    const first = await evaluate(body);
    if (first.kind !== 'unparsed' && first.kind !== 'suggestion') return forComposer(first);
    if (body.chosenTaskId || body.forceCreate || body.retryMatch) return forComposer(first);
    const fingerprint = JSON.stringify([body.text,body.capturedAt,body.captureTimeZone,body.day,body.viewDay,body.contextDay,body.askPlanner]);
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
