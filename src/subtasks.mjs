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
  const before = Array.isArray(task.subtasks) ? task.subtasks : [];
  const edits = task.subtaskEdits || {};
  const previous = new Map(before.map(item => [item.id, item]));
  const generated = new Map(before.filter(item => !edits[item.id]).map(item => [keyFor(item.title || item.text || ''), item.id]));
  const aliases = new Map(), removed = new Set();
  for (const [id, edit] of Object.entries(edits)) {
    for (const name of [edit.sourceTitle, edit.title]) {
      if (!name) continue;
      if (edit.removed) removed.add(labelKey(name));
      else aliases.set(labelKey(name), id);
    }
  }
  const next = new Map(), usedNames = new Set();
  function include(id, title) {
    const name = labelKey(title);
    if (next.has(id) || usedNames.has(name)) return;
    usedNames.add(name);
    next.set(id, { id, title, done: Boolean(task.done || previous.get(id)?.done) });
  }
  for (const title of subtaskLabels(task.text, proposed)) {
    const key = keyFor(title);
    const inferredId = generated.get(key) || createHash('sha256').update(task.id + '\0' + key).digest('hex').slice(0, 32);
    const id = edits[inferredId] ? inferredId : aliases.get(labelKey(title)) || inferredId;
    const edit = edits[id];
    if (edit?.removed || edit?.added || (!edit && removed.has(labelKey(title)))) continue;
    include(id, edit?.title || title);
  }
  // Keep deliberate additions and renames, even when the agent's next list
  // omits them. Existing manual steps retain their relative order.
  for (const { id } of before) if (edits[id] && !edits[id].removed) include(id, edits[id].title);
  task.subtasks = [...next.values()];
}

const labelKey = value => value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
const checklistError = (message, status = 400) => Object.assign(new Error(message), { status });

function manualTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || [...title].length > labelLength || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)) {
    throw checklistError('Enter a one-line step between 1 and 160 characters.');
  }
  return title;
}

// Apply one user operation to a proposed task. The caller commits this clone
// atomically with a parent completion transition or with other planner edits.
export function editChecklist(task, { kind, subtaskId, title, done, expectedTitle, expectedDone }) {
  if (!['add', 'rename', 'remove', 'check'].includes(kind)) throw checklistError('Unknown subtask change.');
  if (typeof subtaskId !== 'string' || !/^[a-f0-9]{32}$/.test(subtaskId)) throw checklistError('Choose a valid step.');
  if (task.deleting) throw checklistError('This task is waiting for its calendar entry to be removed.', 409);
  const changed = { changed: true, completion: null, subtaskId };
  const unchanged = { ...changed, changed: false };
  const list = Array.isArray(task.subtasks) ? task.subtasks : [];
  const item = list.find(step => step.id === subtaskId);
  const edit = task.subtaskEdits?.[subtaskId];
  if (kind === 'add' || kind === 'rename') title = manualTitle(title);
  if (kind === 'check' && typeof done !== 'boolean') throw checklistError('Choose complete or open for this subtask.');
  if (kind === 'add' && done !== undefined && typeof done !== 'boolean') throw checklistError('Choose complete or open for this subtask.');
  if (expectedTitle !== undefined && typeof expectedTitle !== 'string') throw checklistError('Choose a valid previous step title.');
  if (expectedDone !== undefined && typeof expectedDone !== 'boolean') throw checklistError('Choose a valid previous step state.');
  if (kind === 'add') {
    // Keep the initial title with its stable client ID. A delayed POST must
    // neither undo a rename nor resurrect a deleted step.
    if (edit?.added && edit.sourceTitle === title) return unchanged;
    if (item || edit) throw checklistError('This step identifier is already in use. Refresh the task.', 409);
  } else if (!item) {
    if (kind === 'remove' && edit?.removed) return unchanged;
    throw checklistError('This subtask is no longer on the task.', 404);
  }
  if ((kind === 'rename' && item.title === title) || (kind === 'check' && item.done === done)) return unchanged;
  if ((expectedTitle !== undefined && expectedTitle !== item?.title) || (expectedDone !== undefined && expectedDone !== item?.done)) {
    throw checklistError('Another window changed this step. Refresh the task and try again.', 409);
  }
  if ((kind === 'add' || kind === 'rename') && list.some(step => step.id !== subtaskId && labelKey(step.title || step.text || '') === labelKey(title))) {
    throw checklistError('A step with that name already exists on this task.', 409);
  }
  if (kind === 'check') item.done = done;
  else {
    const edits = task.subtaskEdits ||= {};
    if (kind === 'add') {
      edits[subtaskId] = { added: true, sourceTitle: title, title };
      task.subtasks = [...list, { id: subtaskId, title, done: done === true }];
    } else {
      const prior = item.title || item.text || '';
      const override = edits[subtaskId] ||= { sourceTitle: prior, title: prior };
      if (kind === 'rename') { override.title = title; item.title = title; }
      else { override.removed = true; task.subtasks = list.filter(step => step.id !== subtaskId); }
    }
  }
  if (kind !== 'rename' && task.subtasks?.length) {
    const complete = task.subtasks.every(step => step.done);
    if (task.done !== complete) changed.completion = complete;
  }
  return changed;
}

export function setChecklistCompletion(task, done) {
  for (const item of task.subtasks || []) item.done = done;
}
