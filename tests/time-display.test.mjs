import test from 'node:test';
import assert from 'node:assert/strict';
import { displayTime, instantDateTime, instantTime, zonedDay } from '../web/ui.js';
import { estimateTask, findSlot } from '../src/planner.mjs';

test('agenda minutes and instants display leading-zero 24-hour times at midnight, noon and the end of the day', () => {
  for (const [minutes, expected] of [[0,'00:00'],[5,'00:05'],[59,'00:59'],[720,'12:00'],[785,'13:05'],[1439,'23:59']]) {
    assert.equal(displayTime(minutes),expected);
    assert.equal(instantTime('2026-11-24T'+expected+':00Z','UTC'),expected);
  }
  assert.equal(displayTime(1440),'00:00');
});

test('the same instant uses the planner time zone, including midnight, partial-hour offsets and daylight-saving changes', () => {
  const at = '2026-11-24T08:00:00Z';
  for (const [zone,day,time] of [['Pacific/Honolulu','2026-11-23','22:00'],['America/Los_Angeles','2026-11-24','00:00'],
    ['Asia/Kathmandu','2026-11-24','13:45']]) {
    assert.deepEqual([zonedDay(at,zone),instantTime(at,zone)],[day,time]);
  }
  assert.equal(instantTime('2026-03-08T09:59:00Z','America/Los_Angeles'),'01:59');
  assert.equal(instantTime('2026-03-08T10:00:00Z','America/Los_Angeles'),'03:00');
});

test('sync and agent receipts format the same local date and 24-hour clock with optional seconds', () => {
  const at='2026-11-24T02:07:08Z';
  for (const [zone,day,time] of [['America/New_York','2026-11-23','21:07'],['Asia/Kathmandu','2026-11-24','07:52']]) {
    const date=new Intl.DateTimeFormat(undefined,{timeZone:'UTC',dateStyle:'medium'}).format(new Date(day+'T12:00:00Z'));
    assert.equal(instantDateTime(at,zone),date+', '+time);
    assert.equal(instantDateTime(at,zone,{seconds:true}),date+', '+time+':08');
  }
});

test('12-hour task wording still places the task at the requested local time and displays its range in 24-hour time', () => {
  const timeZone='America/Los_Angeles', now=new Date('2026-11-23T16:00:00Z');
  const settings={timeZone,workDays:[1,2,3,4,5],startTime:'00:00',endTime:'23:59'};
  for (const [typed,expected] of [['12 am',['00:00','00:15']],['12 pm',['12:00','12:15']],['2:05 PM',['14:05','14:20']]]) {
    const text='Call the front desk tomorrow at '+typed+' for 15 minutes';
    const task=estimateTask(text,{now,timeZone});
    const slot=findSlot({task,settings,now});
    assert.ok(slot,text);
    assert.equal(task.text,text);
    assert.equal(zonedDay(slot.start,timeZone),'2026-11-24');
    assert.deepEqual([instantTime(slot.start,timeZone),instantTime(slot.end,timeZone)],expected);
  }
});
