import { readFileSync } from 'node:fs';

export const planningInstructions = readFileSync(new URL('./planning-instructions.md', import.meta.url), 'utf8');

const string = { type:'string' };
const nullableString = { type:['string','null'] };
const nullableInteger = { type:['integer','null'] };
function closed(properties) {
  return { type:'object', properties, required:Object.keys(properties), additionalProperties:false };
}
function operation(names, fields = {}) {
  return closed({ op:{type:'string',enum:names}, task:string, ...fields });
}
const operations = [
  operation(['update'], { day:nullableString, time:nullableString, minutes:nullableInteger, deltaMinutes:nullableInteger, title:nullableString }),
  operation(['complete','reopen','first']),
  operation(['order'], { other:string, placement:{type:'string',enum:['before','after']} }),
  operation(['subtask.add'], { title:string }),
  operation(['subtask.rename'], { subtask:string, title:string }),
  operation(['subtask.remove'], { subtask:string }),
  operation(['subtask.check'], { subtask:string, done:{type:'boolean'} })
];
export const planningSchema = closed({
  intent:{type:'string',enum:['plan','answer','clarify','create']},
  message:string,
  actions:{type:'array',items:{anyOf:operations}}
});

export function readPlanningOutput(output, agent) {
  const message = typeof output?.message === 'string' ? output.message.trim().slice(0,1500) : '';
  if (output?.intent === 'plan' && Array.isArray(output.actions) && output.actions.length > 0 && output.actions.length <= 24) {
    const actions = output.actions.map(action => action && typeof action === 'object' && !Array.isArray(action)
      ? Object.fromEntries(Object.entries(action).filter(([,value]) => value !== null)) : null);
    return { intent:'plan', actions, agent };
  }
  if (Array.isArray(output?.actions) && !output.actions.length) {
    if (output.intent === 'create') return { intent:'create', agent };
    if (['answer','clarify'].includes(output.intent) && message) return { intent:output.intent, message, agent };
  }
  return { intent:'clarify', message:'I couldn’t turn that into a complete plan. Which task or outcome should I start with?', agent };
}
