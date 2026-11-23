import { createHash } from 'node:crypto';
import { localTaskTitle } from './task-learning.mjs';

const labelsLimit = 48;
const labelLength = 160;
const fold = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const keyFor = value => fold(value).replace(/^(?:the|a|an)\s+/u, '').replace(/[^\p{L}\p{N}]/gu, '');
const delimiter = /\s*,\s*(?:(?:and|&)\s+)?|\s+(?:and|&)\s+/iu;
const action = /^(?:add|archive|audit|back up|book|buy|call|cancel|check|clean|collect|compare|confirm|configure|contact|create|delete|deploy|draft|email|export|file|find|finish|fix|gather|get|install|make|message|order|organize|pay|pick up|prepare|print|purchase|read|reconcile|record|release|remove|rename|renew|reply|research|reset|review|run|schedule|send|set up|sign|submit|test|update|upload|verify|visit|write)\b/iu;
const explicitObjectList = /^(?:(?:remove|revoke|delete|clean out)\s+.+?\s+(?:from|across)|(?:add|grant|give)\s+.+?\s+(?:to|in)|(?:check|review|audit|update|clean up|organize|verify)\s+.+?\s+(?:in|across|for)|buy|purchase|pack|order|pick up|collect|gather|install|uninstall|archive|export|print|upload|download|inspect|review|update|clean up|organize|check off|check|verify)\s+(.+)$/iu;
const timing = /(?:\s+|,\s*)(?:(?:for|in)\s+\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?|[mh])\b|(?:at|by|before|after)\s+(?:\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\b|noon\b|midnight\b)|(?:(?:for|by)\s+)?(?:today|tomorrow)\b|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b).*$/iu;
const protectedPhrases = /\b(?:between|except|unless|excluding|instead of|without|either|whether|respectively)\b/iu;

function cleanLabel(value) {
  if (typeof value !== 'string') return '';
  const label = value.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+|\[[ x]\]\s*)/iu, '')
    .replace(/\s+/gu, ' ').replace(/[.;,]+$/u, '').trim();
  if (!label || [...label].length > labelLength || /[\p{Cc}<>]/u.test(label)) return '';
  return label;
}

function distinct(labels) {
  if (!Array.isArray(labels) || labels.length > labelsLimit) return [];
  const seen = new Set();
  const result = [];
  for (const label of labels) {
    const clean = cleanLabel(label);
    const key = keyFor(clean);
    if (key && !seen.has(key)) { seen.add(key); result.push(clean); }
  }
  return result.length >= 2 ? result : [];
}

function localItems(text) {
  const lines = text.trim().split(/\n+/u).map(line => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    const header = /:\s*$/u.test(lines[0]) || (!/^[-*•\d]/u.test(lines[0]) && /^[-*•]|^\d+[.)]\s/u.test(lines[1]));
    const items = header ? lines.slice(1) : lines;
    if (header || items.every(item => /^[-*•]|^\d+[.)]\s/u.test(item) || action.test(item))) return distinct(items);
  }
  const source = text.trim().replace(timing, '').replace(/[.!?]+$/u, '');
  if (protectedPhrases.test(source)) return [];
  const explicit = source.match(/^[^:\n]+:\s+(.+)$/u);
  if (explicit || source.includes(';')) {
    const tail = explicit ? explicit[1] : source;
    const items = tail.includes(';') ? tail.split(/\s*;\s*/u) : tail.split(delimiter);
    if (explicit || items.every(item => action.test(item))) return distinct(items);
  }
  const clauses = source.split(/,\s*(?:(?:and\s+)?then\s+|and\s+)?|\s+(?:and(?:\s+then)?|then)\s+/iu);
  if (clauses.length > 1 && clauses.every(item => action.test(item))) return distinct(clauses);
  const added = /^add\s+(.+?)\s+to\s+[^,]+$/iu.exec(source);
  const objects = added && delimiter.test(added[1]) ? added[1] : source.match(explicitObjectList)?.[1];
  if (!objects || /\b(?:whether|with|between|vs\.?|versus)\b/iu.test(objects)) return [];
  const parts = objects.split(delimiter);
  const shared = /\b(?:from|across|in|to)\s/iu.test(source.slice(0, source.lastIndexOf(objects)));
  if (parts.some(item => (!shared && action.test(item)) || /^(?:then|when|if|before|after|at|by|on)\b/iu.test(item))) return [];
  return distinct(parts.map(item => item.trim().replace(/^(?:the|a|an)\s+/iu, '')));
}

const words = value => new Set(fold(value).match(/[\p{L}\p{N}]+/gu) || []);
const filler = words('a an and and then or the from to at by with in on for me my of as this that some it do make task step all');

// Every proposed item needs its own anchor in the note. This keeps a model
// from turning a single stated action into generic preparation/review steps.
function grounded(items, text) {
  const source = words(text);
  const tokens = items.map(words);
  return items.filter((_, index) => [...tokens[index]].some(word =>
    !filler.has(word) && source.has(word) && tokens.every((other, i) => i === index || !other.has(word))));
}

export function subtaskLabels(text, proposed) {
  const original = typeof text === 'string' ? text : '';
  const normalized = localTaskTitle(original);
  if (normalized && !normalized.endsWith('…') && !original.includes('\n')) {
    const fromTitle = localItems(normalized);
    if (fromTitle.length) return fromTitle;
  }
  const inferred = localItems(original);
  if (inferred.length) return inferred;
  // Multiple guests in one meeting aren't independently completable invitations.
  if (/^(?:meet(?:ing)?|have (?:a |an )?(?:meeting|call)|(?:schedule|attend) (?:a |an )?meeting)\b/iu.test(normalized) &&
      !normalized.split(delimiter).slice(1).some(item => action.test(item))) return [];
  return distinct(grounded(distinct(proposed), original + ' ' + normalized));
}

export function updateSubtasks(task, proposed) {
  const previous = new Map((task.subtasks || []).map(item => [keyFor(item.title), item]));
  const labels = subtaskLabels(task.text, proposed);
  task.subtasks = labels.map(title => {
    const key = keyFor(title);
    const existing = previous.get(key);
    const id = existing?.id || createHash('sha256').update(task.id + '\0' + key).digest('hex').slice(0, 32);
    return { id, title, done: Boolean(task.done || existing?.done) };
  });
}

export function setChecklistCompletion(task, done) {
  for (const item of task.subtasks || []) item.done = done;
}
