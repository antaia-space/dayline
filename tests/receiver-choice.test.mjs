// Which receiver a Mac uses and which Google account it signs in to it with.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ANTAIA_RECEIVER, checkedReceiverFile, receiverAccount, receiverSettings } from '../src/receiver-choice.mjs';
import { DaylineService } from '../src/service.mjs';

const own = 'https://dayline-calendar.example.workers.dev';
const work = { sub: 'work', email: 'Ada@Example.org' }, home = { sub: 'home', email: 'ada.home@gmail.com' }, antaia = { sub: 'antaia', email: 'urs@antaia.space' };

test('Antaia’s receiver is the default and is offered Antaia accounts only', () => {
  assert.deepEqual(receiverSettings({}), { origin: ANTAIA_RECEIVER, account: '@antaia.space' });
  // Another receiver takes whichever account its own settings allow.
  assert.deepEqual(receiverSettings({ DAYLINE_PUSH_RELAY: own }), { origin: own, account: '' });
  assert.deepEqual(receiverSettings({ DAYLINE_PUSH_RELAY: own, DAYLINE_RELAY_ACCOUNT: 'ada.home@gmail.com' }), { origin: own, account: 'ada.home@gmail.com' });
  // An empty origin switches the receiver off.
  assert.equal(receiverSettings({ DAYLINE_PUSH_RELAY: '' }).origin, '');
  // A packaged app carries its settings; the environment still wins.
  assert.deepEqual(receiverSettings({}, { origin: own, account: '@example.org' }), { origin: own, account: '@example.org' });
  assert.deepEqual(receiverSettings({}, { origin: own }), { origin: own, account: '' });
  assert.deepEqual(receiverSettings({ DAYLINE_PUSH_RELAY: ANTAIA_RECEIVER }, { origin: own }), { origin: ANTAIA_RECEIVER, account: '@antaia.space' });
});

test('the account for the receiver follows the rule, and a Workspace account comes before Gmail', () => {
  assert.equal(receiverAccount([home, work], ''), work);
  assert.equal(receiverAccount([home], ''), home);
  assert.equal(receiverAccount([], ''), null);
  assert.equal(receiverAccount([home, work, antaia], '@antaia.space'), antaia);
  assert.equal(receiverAccount([home, work], '@antaia.space'), null);
  assert.equal(receiverAccount([work, home], ' Ada.Home@gmail.com '), home);
  assert.equal(receiverAccount([work], 'ada.home@gmail.com'), null);
  // A domain rule matches the whole domain, not an address that merely ends alike.
  assert.equal(receiverAccount([{ sub: 'x', email: 'ada@notexample.org' }], '@example.org'), null);
});

test('a build refuses receiver settings it could not use', () => {
  assert.deepEqual(checkedReceiverFile({ origin: own + '/', account: ' @Example.org ' }), { origin: own, account: '@example.org' });
  assert.deepEqual(checkedReceiverFile({ origin: '', account: undefined }), { origin: '', account: '' });
  assert.throws(() => checkedReceiverFile({ origin: 'http://insecure.example' }), /HTTPS/);
  assert.throws(() => checkedReceiverFile({ origin: own + '/v1' }), /without a path/);
  assert.throws(() => checkedReceiverFile({ origin: 'not a url' }), /HTTPS/);
  assert.throws(() => checkedReceiverFile({ origin: own, account: 'example.org' }), /address/);
});

test('the planner proves itself to the receiver with that account only', async () => {
  const asked = [];
  const planner = (accounts, relayAccount) => {
    const service = new DaylineService({ store: { state: { accounts, tasks: [], settings: {} }, save() {} }, vault: { open: value => value }, relayAccount });
    service.token = async sub => { asked.push(sub); service.tokens.set(sub, { identity: 'proof-of-' + sub }); };
    return service;
  };
  assert.equal(await planner([home, antaia]).relayIdentity(), 'proof-of-antaia');
  await assert.rejects(planner([home, work]).relayIdentity(), /Connect your antaia\.space Google account/);
  assert.equal(await planner([home, work], '').relayIdentity(), 'proof-of-work');
  assert.equal(await planner([work, home], 'ada.home@gmail.com').relayIdentity(), 'proof-of-home');
  await assert.rejects(planner([work], 'ada.home@gmail.com').relayIdentity(), /Connect your Google account ada\.home@gmail\.com/);
  await assert.rejects(planner([], '').relayIdentity(), /Connect a Google account/);
  // No identity was requested for an account the receiver is not meant to see.
  assert.deepEqual(asked, ['antaia', 'work', 'home']);
});
