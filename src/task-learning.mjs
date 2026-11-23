import { createHash } from 'node:crypto';

const brands = [
  [/\bgoogle\s+workspace\b/gi, 'Google Workspace'], [/\bgoogle\s+calendar\b/gi, 'Google Calendar'],
  [/\bgithub\b/gi, 'GitHub'], [/\bgitlab\b/gi, 'GitLab'], [/\bpitchdeck\b/gi, 'pitch deck'],
];
const maxTitle = 120;
const folded = text => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const prefix = /^(?:(?:hey[,!]?[ \t]+)?(?:please(?:[, ]+)|(?:i (?:need|have|want|would like|am going|am supposed) to|i (?:should|must)|i['’]d like to|remind me to|(?:can|could|would) you(?: please)?|make sure to|my task is to|add a task to)\s+)|(?:tengo que|hay que|necesito(?! que\b)|recuérdame(?: que)?|por favor[, ]*|je dois|il faut|merci de|devo|ricordami di|ich muss|ich möchte|bitte|preciso de|tenho de|tenho que)\s+|j['’]ai besoin (?:de\s+|d['’]))/iu;

function uniqueList(text) {
  const joiner = /\s+(and|und|et|y|e)\s+/giu;
  const parts = text.split(/,\s*(?:(?:and|und|et|y|e)\s+)?|\s+(?:and|und|et|y|e)\s+/iu);
  if (parts.length < 2 || parts.some(part => !part.trim())) return text;
  const conjunction = [...text.matchAll(joiner)].at(-1)?.[1];
  const key = part => folded(part.trim()).replace(/^(?:the|le|la|les|el|los|las|il|der|die|das)\s+/u, '');
  const first = key(parts[0]);
  const seen = new Set();
  const kept = parts.filter((part, index) => {
    const value = key(part);
    if (seen.has(value) || (index && first.endsWith(' ' + value))) return false;
    seen.add(value);
    return true;
  }).map(part => part.trim());
  if (kept.length === parts.length) return text;
  if (!conjunction || kept.length <= 1) return kept.join(', ');
  const last = kept.pop();
  const comma = kept.length > 1 && conjunction.toLowerCase() === 'and' ? ',' : '';
  return kept.join(', ') + comma + ' ' + conjunction + ' ' + last;
}

// Use the writer's own words when a task predates titles or the model is
// unavailable. The full original text stays on the task, including its timing.
export function localTaskTitle(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const original = text.trim().replace(/\s+/gu, ' ');
  let title = original;
  while (prefix.test(title)) title = title.replace(prefix, '').trim();
  if (title !== original) title = title.replace(/\?$/u, '');
  title = title.replace(/(?:,?\s+(?:please|thanks|thank you)|[,;–—]\s*(?:this (?:should|will) take|allow)\s+\d+\s+(?:minutes?|hours?))\s*[.!]?$/iu, '')
    .replace(/[.!]+$/u, '').trim() || original;
  for (const [pattern, spelling] of brands) title = title.replace(pattern, spelling);
  if (/\b(?:Google Workspace|GitHub|GitLab|accounts?|permissions?|workspace|systems?)\b/iu.test(title)) {
    title = title.replace(/^clean out (.+?) from\s+/iu, 'Remove $1 from ');
  }
  title = uniqueList(title);
  // Preserve identifiers such as iOS or eBay at the start of a sentence.
  if (!/^(?:\p{Ll}\p{Lu}|https?:\/\/|[a-z0-9_-]+\.[a-z0-9]|(?:npm|pnpm|git|ssh|kubectl)\b)/u.test(title)) {
    title = title.replace(/^\p{Ll}/u, ch => ch.toUpperCase());
  }
  const chars = [...title];
  if (chars.length <= maxTitle) return title;
  const head = chars.slice(0, maxTitle - 1).join('');
  const boundary = head.lastIndexOf(' ');
  return (boundary > maxTitle * 0.72 ? head.slice(0, boundary) : head).replace(/[,;:–—\s]+$/u, '') + '…';
}

// Unknown names, brands or numbers introduced by a model can change who or
// what the task concerns. Preserve the local rendering when that happens.
export function verifiedTaskTitle(title, text) {
  const fallback = localTaskTitle(text);
  if (!fallback || !validTaskTitle(title)) return fallback;
  const words = value => new Set(folded(value).match(/[\p{L}\p{N}]+/gu));
  const source = words(text + ' ' + fallback);
  const proposed = words(title);
  const names = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{M}\p{N}]+|\p{N}+/gu;
  const meaningful = ({ 0: value, index }) => index !== 0 || /\d|\p{Lu}.*\p{Lu}/u.test(value);
  if ([...title.matchAll(names)].some(match => meaningful(match) && !source.has(folded(match[0])))) return fallback;
  const dateWords = /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|january|february|march|april|may|june|july|august|september|october|november|december)$/i;
  if ([...fallback.matchAll(names)].some(match => meaningful(match) && /^\p{Lu}/u.test(match[0]) &&
      !dateWords.test(match[0]) && !proposed.has(folded(match[0])))) return fallback;
  const qualifications = [
    /\b(?:only|solely|exclusively|uniquement|seulement|nur|somente|solo|sólo|solamente|soltanto)\b/iu,
    /\b(?:except|excluding|sauf|hors|außer|excepto|exceto|tranne)\b/iu,
    /\b(?:without|sans|ohne|sin|sem|senza)\b/iu,
    /\b(?:unless|salvo|es sei denn)\b|à moins que/iu,
    /\b(?:not|never|no|don['’]t|nicht|nie|jamais|nunca|mai)\b/iu,
    /\bstaging\b/iu, /\bproduction\b/iu,
  ];
  if (qualifications.some(rule => rule.test(fallback) !== rule.test(title))) return fallback;
  const quantities = /(?<![\p{L}\p{N}])(\d+)(?:\s+|[-–])(?!(?:hours?|hrs?|minutes?|mins?|days?|weeks?|am|pm)\b)\p{L}+/giu;
  if ([...fallback.matchAll(quantities)].some(match => !proposed.has(match[1]))) return fallback;
  // Catch clear language switches while allowing faithful paraphrases. Names
  // and product spellings may legitimately use another script within a title.
  for (const script of ['Cyrillic', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Arabic', 'Hebrew', 'Devanagari', 'Greek', 'Thai']) {
    const letters = new RegExp(`\\p{Script=${script}}`, 'gu');
    if ((text.match(letters)?.length || 0) >= 3 && !letters.test(title)) return fallback;
  }
  if (/^(?:tengo que|necesito |hay que|por favor|je dois|il faut|j['’]ai besoin|ich (?:muss|mochte)|bitte |devo |preciso |tenho )/u.test(folded(text)) &&
      /^(?:add|remove|call|write|draft|review|send|meet|buy|read|prepare|finish|check|complete|schedule)\b/i.test(title)) return fallback;
  return title;
}

export const validTaskTitle = value => typeof value === 'string' && value.trim().length > 0 &&
  [...value].length <= maxTitle && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);

// Keep past text and names out of the note. Choose a specific activity where
// possible. An unrecognized action can still match its local fingerprint.
const activities = [
  ['account access', /\b(?:offboard|onboard|deprovision|revoke|permissions?|access (?:to|for)|zugang|zugriffsrechte|acceso|acces|acesso|permisos?|(?:remove|clean out|add) .{1,70} (?:from|to) .{0,85}(?:workspace|github|gitlab|account|systems?))\b/],
  ['correspondence', /\b(?:(?:draft|write|send|check|answer|compose)\s+(?:(?:a|an|the|my|some|short|quick)\s+)*(?:e-?mails?|repl(?:y|ies)|messages?)|e-?mails?|inbox|reply|replies|respond|message|correos?|courriel|nachricht|rispondere|responder)\b/],
  ['conversations', /\b(?:call|meet(?:ing)?|interview|stand[ -]?up|discuss|1[: -]1|llamar|reunion|appeler|anrufen|telefonat|ligar)\b/],
  ['expense and invoice work', /\b(?:(?:review|submit|file|pay|check|reconcile)\s+(?:(?:a|an|the|my|these|monthly|travel|outstanding)\s+)*(?:invoices?|expenses?|receipts?)|invoic(?:e|es|ing)|receipts?|expenses?|bookkeeping|payroll|reimburse\w*|facturas?|rechnungen?|fattura)\b/],
  ['writing', /\b(?:draft|write|edit|proofread|author|redactar|escribir|rediger|ecrire|schreiben|scrivere|escrever)\b/],
  ['reviews', /\b(?:review|read|check|evaluate|revisar|revoir|verifier|prufen|revisione|rever)\b/],
  ['research', /\b(?:research|investigate|compare|analy[sz]e|recherche|investigar|recherchieren)\b/],
  ['implementation', /\b(?:implement|build|debug|refactor|code|prototype|fix|develop|desarrollar|entwickeln|programmer)\b/],
  ['appointments and bookings', /\b(?:book|schedule|appointment|dentist|reservar|rendez-vous|buchen|prenotare)\b/],
  ['shopping and errands', /\b(?:buy|groceries|grocery|shop|errands?|pick up|comprar|acheter|einkaufen|comprare)\b/],
];
const categories = new Set(['focus', 'writing', 'people', 'admin', 'personal']);
const minutesValid = n => Number.isSafeInteger(n) && n >= 1;

function activityFor(text, category) {
  const label = categories.has(category) ? category : 'focus';
  const lower = folded(localTaskTitle(text));
  let first, position = Infinity;
  for (const [activity, pattern] of activities) {
    const match = pattern.exec(lower);
    if (match && match.index < position) { first = activity; position = match.index; }
  }
  if (first) return { activity: first, key: first };
  const words = lower.match(/[\p{L}\p{N}]+/gu) || [];
  const action = words.find(word => !/^(?:a|an|the|to|my|our|el|la|le|les|der|die|das)$/u.test(word)) || lower;
  const fingerprint = createHash('sha256').update(action).digest('hex').slice(0, 20);
  return { activity: 'other ' + label + ' work', key: label + '/' + fingerprint };
}

const examplesIn = state => Array.isArray(state?.durationLearning?.examples)
  ? state.durationLearning.examples.filter(example => example && typeof example.activity === 'string' &&
    typeof example.key === 'string' && minutesValid(example.baseMinutes) && minutesValid(example.correctedMinutes)) : [];

function adjustment(examples) {
  const deltas = examples.map(sample => sample.correctedMinutes - sample.baseMinutes).sort((a, b) => a - b);
  const middle = Math.floor(deltas.length / 2);
  const median = deltas.length % 2 ? deltas[middle] : (deltas[middle - 1] + deltas[middle]) / 2;
  return Math.sign(median) * Math.round(Math.abs(median) / 5) * 5;
}

function summarize(examples) {
  const groups = new Map();
  for (const sample of examples) {
    if (!groups.has(sample.activity)) groups.set(sample.activity, []);
    groups.get(sample.activity).push(sample);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([activity, samples]) => {
    const delta = adjustment(samples);
    const change = delta > 0 ? `${delta} minutes longer` : delta < 0 ? `${-delta} minutes shorter` : 'about the original estimate';
    return `Your edits to ${activity} suggest ${change} (${samples.length} ${samples.length === 1 ? 'task' : 'tasks'}).`;
  });
}

export const durationNotes = state => summarize(examplesIn(state));

// Call during the same profile write as a user-edited duration. The baseline
// is the unpersonalized estimate. Undoing to the originally shown suggestion
// removes the example, even when that suggestion was already personalized.
export function recordDurationFeedback(state, before, after) {
  if (!before || !after || before.id !== after.id || typeof after.id !== 'string' || !after.id ||
      after.pendingEstimate || !minutesValid(before.minutes) || !minutesValid(after.minutes) || before.minutes === after.minutes) return false;
  const samples = examplesIn(state);
  const previous = samples.find(sample => sample.taskId === after.id);
  const base = [after.baseMinutes, before.baseMinutes, previous?.baseMinutes, before.minutes].find(minutesValid);
  const shown = [after.estimatedMinutes, before.estimatedMinutes, previous?.estimatedMinutes, before.minutes].find(minutesValid);
  after.baseMinutes = base;
  after.estimatedMinutes = shown;
  const examples = samples.filter(sample => sample.taskId !== after.id);
  if (after.minutes !== shown) examples.push({ taskId: after.id, ...activityFor(after.text || before.text || '', after.category || before.category),
    baseMinutes: base, estimatedMinutes: shown, correctedMinutes: after.minutes });
  state.durationLearning = { examples, notes: summarize(examples) };
  return true;
}

export function durationCalibration(state, text, category, taskId) {
  const { activity, key } = activityFor(text, category);
  const matches = examplesIn(state).filter(sample => sample.taskId !== taskId && sample.key === key);
  return matches.length ? { activity, sampleCount: matches.length, changeMinutes: adjustment(matches) } : null;
}
