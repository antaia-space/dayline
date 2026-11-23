import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeetingFeed, rangeOnDay, safeMeetingLink } from '../web/meetings.js';
import { calendarEntriesForDay } from '../web/views.js';

const monday = '2026-11-23', nextWeek = '2026-11-30';
const stamp = h => monday + 'T' + h + ':00.000Z';
const period = (start,end) => ({start:stamp(start),end:stamp(end)});
const tick = () => new Promise(resolve => setImmediate(resolve));
function snapshot() {
  return {connection:{connected:true,lastSync:'first',accounts:[{sub:'work',mode:'availability',meetingDetails:true}]},
    settings:{calendarMode:'availability',timeZone:'UTC',excludedCalendarIds:[]},busy:[],tasks:[]};
}

test('only the current authorized week can publish events and revoking access clears guest details immediately',async () => {
  const state = snapshot(), calls = [];
  const feed = createMeetingFeed({read:url => new Promise(resolve => calls.push({url,resolve})),changed:() => {}});
  feed.update(state,monday);
  feed.update(state,nextWeek);
  assert.deepEqual(calls.map(item => item.url),[
    '/api/meetings?from=2026-11-23&to=2026-11-30','/api/meetings?from=2026-11-30&to=2026-12-07'
  ]);
  calls[1].resolve({events:[{id:'current'}],warnings:[]});
  await tick();
  calls[0].resolve({events:[{id:'stale'}],warnings:['Earlier warning']});
  await tick();
  assert.deepEqual(feed.current,{events:[{id:'current'}],warnings:[]});

  feed.update(state,nextWeek,true);
  state.connection.accounts[0].meetingDetails = false;
  assert.deepEqual(feed.update(state,nextWeek),{events:[],warnings:[]});
  calls[2].resolve({events:[{id:'revoked',attendees:[{name:'Hidden'}]}]});
  await tick();
  assert.deepEqual(feed.current,{events:[],warnings:[]});
  assert.equal(calls.length,3);
});

test('meeting reads are shared across frequent task updates and refreshed after sync, calendar selection or an explicit request',async () => {
  const state = snapshot(), requests = [];
  let time = 1000, fail = false;
  const feed = createMeetingFeed({now:() => time,changed:() => {},read:async url => {
    requests.push(url);
    if (fail) throw new Error('Meeting details could not be checked.');
    return {events:[{id:'current'}],warnings:['A second calendar shares busy times only.']};
  }});
  feed.update(state,monday);
  feed.update(state,monday);
  await tick();
  feed.update(state,monday);
  assert.equal(requests.length,1);
  assert.match(feed.current.warnings[0],/second calendar/);
  state.connection.lastSync = 'second';
  feed.update(state,monday); await tick();
  state.settings.excludedCalendarIds = ['other'];
  assert.deepEqual(feed.update(state,monday),{events:[],warnings:[]});
  await tick();
  assert.equal(requests.length,3);
  time += 61000; fail = true;
  feed.update(state,monday); await tick();
  assert.deepEqual(feed.current,{events:[],warnings:['Meeting details could not be checked.']});
  fail = false; feed.update(state,monday,true); await tick();
  assert.equal(requests.length,5);
  assert.equal(feed.current.events[0].id,'current');
});

test('overlapping meetings remain distinct and only unmatched portions of Google busy time are anonymous',() => {
  const state = snapshot();
  state.busy = [period('09:00','12:00')];
  state.tasks = [{...period('11:30','11:45'),syncStatus:'local'}];
  const events = [
    {id:'one',...period('09:15','10:15')},{id:'two',...period('10:00','11:00')},
    {id:'free',transparent:true,...period('11:00','13:00')}
  ];
  const day = calendarEntriesForDay(state,events,monday,'UTC');
  assert.deepEqual(day.meetings.map(item => item.meeting.id),['one','two','free']);
  const pairs = rows => rows.map(({start,end}) => [start,end]);
  assert.deepEqual(pairs(day.anonymous),[[540,555],[660,720]]);
  assert.deepEqual(pairs(day.occupied),[[540,720]]);
  state.settings.calendarMode = 'sync';
  state.tasks[0].hasCalendarEvent = true;
  assert.deepEqual(pairs(calendarEntriesForDay(state,events,monday,'UTC').anonymous),[[540,555],[660,690],[705,720]]);
  state.tasks[0].hasCalendarEvent = false;
  state.tasks[0].syncStatus = 'synced';
  assert.deepEqual(pairs(calendarEntriesForDay(state,events,monday,'UTC').anonymous),[[540,555],[660,720]]);
});

test('all-day date boundaries use the Google calendar dates and midnight timed meetings stay on the preceding day',() => {
  const allDay = {allDay:true,startDate:monday,endDate:'2026-11-25',start:stamp('00:00'),end:'2026-11-25T00:00:00Z'};
  for (const zone of ['America/Los_Angeles','Pacific/Auckland']) {
    assert.equal(rangeOnDay(allDay,'2026-11-22',zone),null);
    assert.deepEqual(rangeOnDay(allDay,monday,zone),{start:0,end:1440});
    assert.deepEqual(rangeOnDay(allDay,'2026-11-24',zone),{start:0,end:1440});
    assert.equal(rangeOnDay(allDay,'2026-11-25',zone),null);
  }
  const overnight = {start:stamp('23:15'),end:'2026-11-24T00:00:00Z'};
  assert.deepEqual(rangeOnDay(overnight,monday,'UTC'),{start:1395,end:1440});
  assert.equal(rangeOnDay(overnight,'2026-11-24','UTC'),null);
});

test('meeting links require an HTTPS destination with no embedded credentials',() => {
  assert.equal(safeMeetingLink('https://meet.google.com/test-room'),'https://meet.google.com/test-room');
  for (const value of ['javascript:alert(1)','http://example.test','/relative','https://user:password@example.test',null]) {
    assert.equal(safeMeetingLink(value),null);
  }
});

test('declined and informational invitations remain visible without blocking a verified open period',() => {
  const state = snapshot();
  state.busyStart = stamp('09:00'); state.busyEnd = stamp('17:00');
  const visible = [
    {id:'declined',...period('09:30','10:30'),attendees:[{self:true,response:'declined'}]},
    {id:'visibleOnly',...period('10:30','11:00')},
    {id:'beyondCoverage',...period('16:45','17:30')}
  ];
  const entries = calendarEntriesForDay(state,visible,monday,'UTC');
  assert.equal(entries.meetings.length,3);
  assert.deepEqual(entries.occupied.map(({start,end}) => [start,end]),[[1020,1050]]);
  state.busy = [period('10:00','10:15')];
  assert.deepEqual(calendarEntriesForDay(state,visible,monday,'UTC').anonymous.map(({start,end}) => [start,end]),[[600,615]]);
});
