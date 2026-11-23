import { DateTime } from 'luxon';
import { durationInText, estimateTask, explicitStartFor } from './planner.mjs';
import { localTaskTitle } from './task-learning.mjs';

const create = () => ({ kind: 'create' });
const clarify = (reason, message, candidates = []) => ({ kind: 'clarify', reason, message, candidates });
const titleOf = task => task.title || localTaskTitle(task.text) || task.summary || 'Untitled task';
const candidate = task => ({ id: task.id, title: titleOf(task) });
const protectedCalendar = record => record && (record.calendarAppointment || record.manualTime || record.allDay || record.owned === false);
const protectedMeeting = task => Boolean(task.calendarAppointment || protectedCalendar(task.remote) || protectedCalendar(task.pausedSync?.remote) ||
  task.kind === 'meeting' || task.type === 'meeting');
const plannerNoun = /\b(?:tasks?|to[ -]?dos?|to[ -]?do items?|planner|calendar entry)\b/i;
const bulkSubject = /^(?:(?:all|every)\s+(?:(?:of\s+)?(?:my|our|the)\s+)?|(?:my|our)\s+all\s+)(?:(?:unfinished|open|incomplete|remaining|pending)\s+)?(?:tasks?|to[ -]?dos?|items?)$/i;
const ignored = new Set('the a an my our this that task tasks todo todos item items called named titled to of for on with in and please'.split(' '));
const unquote = value => value.trim().replace(/^["“‘'](.*)["”’']$/u, '$1').trim();

function tokens(value) {
  const text = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/['’]s\b/gu, '').replace(/\b(?:[a-z]\.){2,}/g, initials => initials.replaceAll('.', ''))
    .replace(/\b(clean|follow|back|wrap|check|set)[\s-]+up\b/g, '$1up');
  const meaningful = (text.match(/[\p{L}\p{N}]+/gu) || []).filter(word => !ignored.has(word));
  // Single-letter names such as “Task A” are meaningful even when the same
  // lowercase spelling usually serves as an article.
  return meaningful.length ? meaningful : (value.match(/\b[A-Z]\b/g) || []).map(letter => letter.toLowerCase());
}

const aliases = new Map([
  ['presentation', 'slides', 'slide', 'deck', 'decks', 'slideshow', 'powerpoint', 'ppt', 'pptx'],
  ['prepare', 'prep', 'preparation', 'preparing', 'prepared'],
  ['compare', 'comparison', 'comparisons', 'comparing'], ['document', 'doc', 'docs', 'documents'],
  ['meeting', 'meetings', 'mtg'], ['appointment', 'appt'], ['operations', 'ops'],
  ['review', 'reviewing', 'reviewed'], ['update', 'updating', 'updated'], ['reconcile', 'reconciliation', 'reconciling'],
].flatMap(group => group.map(word => [word, group[0]])));
const descriptors = new Set(['prepare', 'work']);
const keyFor = words => [...new Set(words)].sort().join(' ');
const twoWordInitialisms = new Set(['investment committee', 'individual contributor', 'integrated circuit', 'quality assurance',
  'pull request', 'public relations', 'product management', 'project management', 'product manager', 'project manager',
  'user interface', 'user experience', 'artificial intelligence', 'machine learning', 'business development', 'human resources']);

function wordForm(word) {
  if (aliases.has(word)) return aliases.get(word);
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  return word.length > 4 && /[^siu]s$/.test(word) ? word.slice(0, -1) : word;
}

// Allow one insertion, omission, substitution or adjacent transposition in a
// longer word. Short names, acronyms and numbers need exact evidence.
function nearWord(a, b) {
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1 || !/^\p{L}+$/u.test(a) || !/^\p{L}+$/u.test(b)) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length < b.length) return a.slice(i) === b.slice(i + 1);
  if (a.length > b.length) return a.slice(i + 1) === b.slice(i);
  return a.slice(i + 1) === b.slice(i + 1) ||
    (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
}

function identify(task) {
  const parents = [titleOf(task), task.text, task.estimateJob?.text].filter(Boolean);
  const children = (task.subtasks || []).map(child => child.title || child.text).filter(Boolean);
  const texts = [...new Set([...parents, ...children])];
  const phrases = texts.map(text => tokens(text).map(wordForm));
  const initials = new Set(texts.flatMap(text => text.match(/\b[A-Z]{2,5}\b/g) || []).map(word => word.toLowerCase()));
  return { exact:new Set(parents.map(text => keyFor(tokens(text)))), title:new Set(phrases[0]),
    words:new Set(phrases.flat()), phrases, initials };
}

function initialsIn(short, words) {
  return words.some((_, index) => {
    const group = words.slice(index, index + short.length);
    return group.map(term => term[0]).join('') === short && (short.length > 2 || twoWordInitialisms.has(group.join(' ')));
  });
}

function evidence(asked, source) {
  const words = [...source.words];
  const hits = asked.map(word => source.words.has(word) || words.some(other => nearWord(word, other)));
  if (hits.every(Boolean)) return 'grounded';
  // Resolve an initialism in either direction only when another subject word
  // independently matches. Initials by themselves cannot identify a phrase.
  const independent = (from, end) => hits.some((hit, i) => hit && !descriptors.has(asked[i]) && (i < from || i >= end));
  for (let i = 0; i < asked.length; i++) {
    if (hits[i]) continue;
    const word = asked[i];
    if (/^[a-z]{2,5}$/.test(word) && independent(i, i + 1) && source.phrases.some(phrase => initialsIn(word, phrase))) {
      hits[i] = true;
      continue;
    }
    for (let end = Math.min(i + 5, asked.length); end >= i + 2; end--) {
      const group = asked.slice(i, end);
      if (!group.every(term => term.length >= 3 && !descriptors.has(term)) || !independent(i, end) ||
          (group.length === 2 && !twoWordInitialisms.has(group.join(' ')))) continue;
      if (source.initials.has(group.map(term => term[0]).join(''))) { hits.fill(true, i, end); break; }
    }
  }
  if (hits.every(Boolean)) return 'grounded';
  if (asked.some((word, i) => !hits[i] && !descriptors.has(word))) return null;
  const anchors = [...new Set(asked.filter(word => !descriptors.has(word)))];
  if (anchors.length >= 2) return 'grounded';
  return anchors.length === 1 && anchors[0].length >= 5 && source.title.has(anchors[0]) ? 'contextual' : null;
}

function matchTasks(query, context, from) {
  const literal = tokens(unquote(query));
  if (!literal.length) return [];
  const key = keyFor(literal), asked = literal.map(wordForm);
  const exact = [], grounded = [], contextual = [];
  const zone = context.timeZone, visible = from || context.contextDay;
  for (const task of context.tasks) {
    if (task.deleting || (from && taskDay(task, zone) !== from)) continue;
    if (!context.index.has(task)) context.index.set(task, identify(task));
    const source = context.index.get(task);
    if (source.exact.has(key)) { exact.push(task); continue; }
    const match = evidence(asked, source);
    if (match === 'grounded') grounded.push(task);
    if (match === 'contextual') contextual.push(task);
  }
  const onDay = task => Boolean(visible && taskDay(task, zone) === visible);
  // The visible day may support one well-grounded subject plus a generic
  // action. Other plausible matches stay in the chooser, including other days.
  const contextualMatches = contextual.some(onDay) ? contextual : [];
  const found = exact.length ? exact : [...grounded, ...contextualMatches];
  return visible ? found.sort((a,b) => Number(onDay(b)) - Number(onDay(a))) : found;
}

const weekday = '(?:(?:next|this)\\s+)?(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\\.?';
const month = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const datePhrase = '(?:today|tomorrow|day after tomorrow|' + weekday + '|\\d{4}-\\d{2}-\\d{2}|' + month +
  '\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|in\\s+(?:\\d+|one|two|three|four|five|six|seven)\\s+(?:days?|weeks?))';
const clock = '(?:midnight|noon|\\d{1,2}(?:[:.]\\d{2})?(?:\\s*[ap]\\.?m\\.?)?)';
const dateFirst = new RegExp('^(?:on\\s+)?(' + datePhrase + ')(?:\\s*,?\\s+(?:at\\s+)?(' + clock + '))?$', 'i');
const timeFirst = new RegExp('^(?:at\\s+)?(' + clock + ')(?:\\s+(?:on\\s+)?(' + datePhrase + '))?$', 'i');
const timeHint = /\b(?:today|tomorrow|yesterday|(?:next|this) (?:week|month)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|later|earlier|noon|midnight|morning|afternoon|evening)\b|\d{4}-\d|\d[:.]\d|\d\s*[ap]m\b/i;

function destination(value, context) {
  const clean = value.trim().replace(/^(?:for|until)\s+/i, '');
  const byDay = dateFirst.exec(clean), byTime = !byDay && timeFirst.exec(clean);
  if (!byDay && !byTime) return null;
  const date = byDay ? byDay[1] : byTime[2];
  const rawTime = byDay ? byDay[2] : byTime[1];
  const changes = {};
  try {
    if (date) {
      const resolved = estimateTask('Schedule on ' + date.replace(/\.$/, ''), { now: context.now, timeZone: context.timeZone });
      if (!resolved.earliestDay || resolved.earliestDay !== resolved.latestDay) return null;
      changes.day = resolved.earliestDay;
    }
    if (rawTime) {
      const result = explicitStartFor({ text: 'Start at ' + rawTime, createdAt: context.instant }, context.timeZone);
      if (!result) return null;
      changes.time = result;
    }
    return changes;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return null;
  }
}

function taskDay(task, timeZone) {
  if (task.start) return DateTime.fromISO(task.start, { zone: timeZone }).toISODate();
  return task.completedDay || task.estimateOverrides?.day || task.estimateOverrides?.viewDay ||
    (task.earliestDay === task.latestDay && task.earliestDay) || null;
}

function command(action, tasks, changes) {
  return { kind: 'command', action, taskIds: tasks.map(t => t.id), changes };
}

function order(sourceName, relation, targetName, context) {
  const names = { source: unquote(sourceName), target: unquote(targetName) };
  const matches = { source: matchTasks(names.source, context), target: matchTasks(names.target, context) };
  const roles = ['source', 'target'];
  const selection = context.chosenTaskId ?? context.selectedTaskId;
  const stale = () => clarify('stale-selection', 'One of these tasks changed. Enter both current task names again.');
  if (selection != null) {
    const matchingRoles = roles.filter(role => matches[role].some(task => task.id === selection));
    const ambiguousRoles = matchingRoles.filter(role => matches[role].length > 1);
    const role = context.choiceRole || (ambiguousRoles.length === 1 ? ambiguousRoles[0] : matchingRoles.length === 1 && matchingRoles[0]);
    if (!matchingRoles.includes(role)) return stale();
    const other = role === 'source' ? 'target' : 'source';
    if (matches[other].length !== 1 || (context.counterpartId && matches[other][0].id !== context.counterpartId)) return stale();
    matches[role] = matches[role].filter(task => task.id === selection);
  }
  for (const role of roles) {
    if (!tokens(names[role]).length) return clarify('missing-target', 'Name both tasks for an order change.');
    if (!matches[role].length) return clarify('unmatched', 'No task matches “' + names[role] + '”. Use the title of each task you want to order.');
  }
  const ambiguous = roles.filter(role => matches[role].length > 1);
  if (ambiguous.length === 2) return clarify('ambiguous', 'Both names match multiple tasks. Use a more specific title for each one.');
  if (ambiguous.length === 1) {
    const role = ambiguous[0], other = role === 'source' ? 'target' : 'source';
    return { ...clarify('ambiguous', 'Which task did you mean by “' + names[role] + '”?', matches[role].map(candidate)),
      choiceRole: role, counterpartId: matches[other][0].id };
  }
  const [source] = matches.source, [target] = matches.target;
  if (source.id === target.id) return clarify('invalid-order', 'Choose two different tasks to change their order.');
  for (const task of [source, target]) {
    if (protectedMeeting(task) || task.canReorder === false || task.done || task.held || task.pendingEstimate || task.estimateJob ||
        task.intent || task.pausedSync?.intent || explicitStartFor(task, context.timeZone) ||
        (task.end && Date.parse(task.end) <= context.now.getTime()) || (task.remote && (!task.start || Date.parse(task.start) <= context.now.getTime()))) {
      return clarify('protected', '“' + titleOf(task) + '” cannot be reordered. Choose two unfinished, flexible tasks.');
    }
  }
  // The Unscheduled list is one reorderable group, even when individual tasks
  // have different requested dates. Scheduled tasks belong to their local day.
  const group = task => task.start ? DateTime.fromISO(task.start, { zone: context.timeZone }).toISODate() : 'unscheduled';
  if (group(source) !== group(target)) return clarify('invalid-order', 'Move both tasks to the same day, or choose two tasks in Unscheduled.');
  const placement = /^(?:before|ahead of)$/i.test(relation) ? 'before' : 'after';
  return command('order', [source], { targetId: target.id, placement });
}

function resolveTarget(query, action, changes, context, from) {
  const label = unquote(query);
  if (!tokens(label).length) return clarify('missing-target', 'Include the name of the task you want to change.');
  let matches = matchTasks(label, context, from);
  const selection = context.chosenTaskId ?? context.selectedTaskId;
  if (selection != null) {
    if (!matches.some(task => task.id === selection)) {
      return clarify('stale-selection', 'That choice no longer matches this instruction. Choose a current task.', matches.map(candidate));
    }
    matches = matches.filter(task => task.id === selection);
  }
  if (!matches.length) return clarify('unmatched', 'No task matches “' + label + '”. Try its title or another distinctive word.');
  if (matches.length > 1) return clarify('ambiguous', 'More than one task matches “' + label + '”. Choose the task you mean.', matches.map(candidate));
  const [task] = matches;
  if (protectedMeeting(task)) return clarify('protected', '“' + titleOf(task) + '” has a protected calendar reservation. Change it in Google Calendar.');
  if (task.held || task.intent || task.pausedSync?.intent) return clarify('protected', '“' + titleOf(task) + '” is waiting for its calendar reservation. Refresh the planner and try again.');
  if (action === 'move' && task.done) return clarify('protected', 'Reopen “' + titleOf(task) + '” before moving it.');
  if (changes.deltaMinutes && Number.isSafeInteger(task.minutes) &&
      (!Number.isSafeInteger(task.minutes + changes.deltaMinutes) || task.minutes + changes.deltaMinutes < 1)) {
    return clarify('invalid-duration', 'The resulting duration must be at least one whole minute.');
  }
  if (action === 'move' && !changes.day) changes = { ...changes, day: taskDay(task, context.timeZone) || context.today };
  return command(action, matches, changes);
}

const invalidDate = () => clarify('invalid-date', 'Choose one calendar date or start time, such as Wednesday or Friday at 2 pm.');
function move(verb, body, context) {
  // Use the first suffix that parses in full. A title may contain “to”, and a
  // destination such as “2pm on Wednesday” includes its own separator.
  const separators = [...body.matchAll(/\s+(?:to|until|for|on|at)\s+/gi)];
  let subject, changes;
  for (const separator of separators) {
    const right = body.slice(separator.index + separator[0].length);
    const next = destination(right, context);
    if (!next) continue;
    subject = body.slice(0, separator.index);
    changes = next;
    break;
  }
  if (!changes) {
    const implicit = body.match(new RegExp('^(.+?)\\s+(' + datePhrase + '(?:\\s+at\\s+' + clock + ')?)$', 'i'));
    if (implicit) { subject = implicit[1]; changes = destination(implicit[2], context); }
  }
  if (!changes) {
    const left = body.split(/\s+(?:to|until|for|on|at)\s+/i)[0];
    const isDirective = /^(?:reschedule|postpone|defer|bump)$/.test(verb) || plannerNoun.test(body) ||
      timeHint.test(body) || /^(?:push|shift)\b/i.test(verb) && /\bback\b/i.test(body) || matchTasks(left, context).length;
    if (!isDirective) return context.chosenTaskId != null || context.selectedTaskId != null
      ? clarify('stale-selection', 'That choice no longer matches a planner instruction.') : create();
    return separators.length || timeHint.test(body) ? invalidDate() :
      clarify('syntax', 'Include a task and destination, for example “Move the design review to Wednesday”.');
  }
  subject = subject.replace(/\s+(?:back|out|forward|over)$/i, '').trim();
  if (verb === 'push') subject = subject.replace(/^back\s+/i, '');
  // “Move boxes to storage on Friday” describes new work with a destination.
  // A known task title containing “to” still resolves as a planner command.
  if (verb === 'move' && /\s+to\s+/i.test(subject) && !plannerNoun.test(subject) &&
      context.chosenTaskId == null && context.selectedTaskId == null && !matchTasks(subject, context).length) {
    return timeHint.test(subject.split(/\s+to\s+/i).at(-1)) ? invalidDate() : create();
  }
  let from;
  const source = subject.match(/^(.+?)\s+from\s+(.+)$/i);
  if (source) {
    const date = destination(source[2], context);
    if (date?.day && !date.time) { from = date.day; subject = source[1].trim(); }
    else if (bulkSubject.test(source[1])) return invalidDate();
  }
  if (bulkSubject.test(subject)) {
    if (context.chosenTaskId != null || context.selectedTaskId != null) return clarify('stale-selection', 'Submit the group instruction again to move the matching tasks.');
    if (!changes.day || changes.time) return clarify('invalid-date', 'Give the group a destination day, or set a start time for one task.');
    const matches = context.tasks.filter(task => !task.done && !task.deleting && !task.held && !task.intent && !task.pausedSync?.intent && !protectedMeeting(task) &&
      (!from || taskDay(task, context.timeZone) === from));
    return matches.length ? command('move', matches, changes) : clarify('unmatched', 'No unfinished tasks match that group and day.');
  }
  return resolveTarget(subject, 'move', changes, context, from);
}

const countWords = '(?:\\d+(?:[.,]\\d+)?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?))';
const units = '(?:minutes?|mins?|m|hours?|hrs?|h)';
const giveMore = new RegExp('^give\\s+(.+?)\\s+(' + countWords + ')\\s+(more|extra|additional|less|fewer)\\s+(' + units + ')$', 'i');
const amountWords = /^(?:[\d.,½\s-]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|and|an?|half|quarters?|of|hours?|hrs?|h|minutes?|mins?|m)+$/i;
function duration(query, amount, relative, context) {
  const value = amountWords.test(amount) && durationInText(amount.replace(/(\d),(\d)/g, '$1.$2'));
  if (!Number.isSafeInteger(value) || value < 1) return clarify('invalid-duration', 'Give a positive duration, such as 45 minutes.');
  return resolveTarget(query, 'duration', relative ? { deltaMinutes: relative * value } : { minutes: value }, context);
}

export function parsePlannerCommand(text, { tasks = [], now, timeZone = 'UTC', contextDay, chosenTaskId, selectedTaskId, choiceRole, counterpartId } = {}) {
  const timestamp = now instanceof Date ? now : new Date(now);
  const local = DateTime.fromJSDate(timestamp, { zone: timeZone });
  if (!local.isValid) throw new RangeError('A valid command capture time and planner time zone are required.');
  const context = { tasks, now: timestamp, timeZone, contextDay, index:new Map(), today: local.toISODate(), instant: timestamp.toISOString(),
    chosenTaskId, selectedTaskId, choiceRole, counterpartId };
  const input = String(text || '').trim().replace(/\s+/g, ' ')
    .replace(/^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+(?:we|you)\s+(?:please\s+)?|(?:let['’]s|let us|I want to|I(?: would|['’]d) like to)\s+)+/i, '')
    .replace(/[?!.]+$/, '').replace(/(?:,?\s+please)$/i, '').trim();
  let match;
  if (/^(?:move|reschedule|postpone|defer|shift|bump|push back|rename|reopen|uncheck|mark done)$/i.test(input)) {
    return clarify('missing-target', 'Include the task name and the change you want to make.');
  }
  if ((match = /^(move|put|place|reorder|prioriti[sz]e)\s+(["“‘'].+?["”’']|.+?)\s+(?:(?:right|just|immediately)\s+)?(before|after|ahead of|behind)\s+(.+)$/i.exec(input))) {
    const [, verb, source, relation, target] = match;
    // A name can contain “after” and “day after tomorrow” is a date. An
    // explicit destination such as “to Wednesday” still takes precedence.
    if (/^move$/i.test(verb) && [...input.matchAll(/\s+to\s+/gi)].some(m => destination(input.slice(m.index + m[0].length), context))) {
      return move('move', input.slice(5), context);
    }
    const matches = matchTasks(target, context);
    if (!matches.length && destination(target, context)) {
      if (plannerNoun.test(source) || matchTasks(source, context).length) {
        return clarify('syntax', 'For a time change, name a requested start. For list order, name a task before or after another task.');
      }
    } else if (chosenTaskId != null || selectedTaskId != null || /^(?:prioriti[sz]e|reorder)$/i.test(verb) ||
        plannerNoun.test(input) || matches.length || matchTasks(source, context).length) {
      return order(source, relation, target, context);
    }
  }
  if ((match = /^(move|reschedule|postpone|push|shift|bump|defer)\s+(.+)$/i.exec(input))) return move(match[1].toLowerCase(), match[2], context);
  if ((match = /^(?:mark|set)\s+(.+?)\s+(?:as\s+)?(done|complete|completed|unfinished|open|incomplete)$/i.exec(input))) {
    const done = /^(?:done|complete|completed)$/i.test(match[2]);
    return resolveTarget(match[1], done ? 'complete' : 'reopen', { done }, context);
  }
  if ((match = /^(reopen|uncheck|check off|cross off)\s+(.+)$/i.exec(input))) {
    const done = !/^(?:reopen|uncheck)$/i.test(match[1]);
    return resolveTarget(match[2], done ? 'complete' : 'reopen', { done }, context);
  }
  if ((match = /^complete\s+(.+)$/i.exec(input)) && (plannerNoun.test(match[1]) || matchTasks(match[1], context).length)) {
    return resolveTarget(match[1], 'complete', { done: true }, context);
  }
  if ((match = /^rename\s+(["“‘'].+?["”’'])\s+to\s+(.+)$/i.exec(input)) || (match = /^rename\s+(.+?)\s+to\s+(.+)$/i.exec(input))) {
    const title = unquote(match[2]);
    if (!title || title.length > 120) return clarify('invalid-title', 'Use a new title between 1 and 120 characters.');
    return resolveTarget(match[1], 'rename', { title }, context);
  }
  if ((match = giveMore.exec(input))) return duration(match[1], match[2] + ' ' + match[4], /less|fewer/i.test(match[3]) ? -1 : 1, context);
  if ((match = /^give\s+(.+?)\s+(?:another|an extra|an additional)\s+(.+)$/i.exec(input))) return duration(match[1], match[2], 1, context);
  if ((match = /^(?:add|give)\s+(.+?)\s+to\s+(.+)$/i.exec(input)) && /\b(?:minutes?|mins?|hours?|hrs?)\b/i.test(match[1])) return duration(match[2], match[1], 1, context);
  if ((match = /^(shorten|reduce|extend|lengthen|increase)\s+(.+?)\s+by\s+(.+)$/i.exec(input))) return duration(match[2], match[3], /shorten|reduce/i.test(match[1]) ? -1 : 1, context);
  if ((match = /^(?:set|change|adjust|shorten|extend)\s+(.+?)\s+to\s+(.+)$/i.exec(input)) &&
      (/\b(?:minutes?|mins?|hours?|hrs?|duration)\b/i.test(input) || /\d\s*[hm]\b/i.test(match[2]))) {
    return duration(match[1].replace(/^(?:the\s+)?duration\s+(?:of|for)\s+|['’]s\s+duration$/gi, ''), match[2], 0, context);
  }
  if (/^(?:reorder|prioriti[sz]e|deprioriti[sz]e)\b/i.test(input) ||
      (/^(?:reschedule|postpone|reopen|uncheck|rename|mark|set|adjust|change|put|shift|swap)\b/i.test(input) && plannerNoun.test(input))) {
    return clarify('syntax', 'Include the task name and the change, for example “Mark the design review done”.');
  }
  if (chosenTaskId != null || selectedTaskId != null) return clarify('stale-selection', 'That choice no longer matches a planner instruction.');
  return create();
}
