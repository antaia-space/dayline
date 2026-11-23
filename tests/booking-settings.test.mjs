// The Bookings tab through the local planner server, as the Mac app and the paired browser use it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { developmentVault, openStore } from '../src/store.mjs';
import { DaylineService } from '../src/service.mjs';
import { startServer } from '../src/http.mjs';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));

test('booking settings load, validate and save for a paired planner only', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dayline-booking-'));
  const service = new DaylineService({ store: openStore(dir), vault: developmentVault(dir), clock: () => new Date('2026-11-23T08:00:00Z') });
  const app = await startServer({ service, webRoot, port: 0, intervalMs: 0 });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true }); });
  const cookie = (await fetch(app.launchUrl(), { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const read = async () => (await fetch(app.origin + '/api/booking', { headers: { cookie } })).json();
  const write = (pathname, method, data, headers = { cookie, Origin: app.origin }) => fetch(app.origin + pathname, {
    method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  assert.equal((await fetch(app.origin + '/api/booking')).status, 401);
  assert.equal((await write('/api/booking', 'PATCH', { enabled: false }, { cookie, Origin: 'https://elsewhere.example' })).status, 403);
  const first = await read();
  assert.deepEqual([first.enabled, first.status.state, first.calendars, first.notices, first.upcoming], [false, 'off', [], [], []]);
  assert.deepEqual(first.types.map(type => type.slug), ['intro', 'meeting', 'deep-dive', 'private']);
  assert.deepEqual((await (await fetch(app.origin + '/api/state', { headers: { cookie } })).json()).booking, { enabled: false, notices: 0 });

  // Switching on needs a name and a calendar; nothing is saved by a refused change.
  const refused = await write('/api/booking', 'PATCH', { enabled: true, owner: { name: 'Urs Wilcke', headline: 'Antaia' } });
  assert.deepEqual([refused.status, (await refused.json()).error], [400, 'Choose the calendar that receives booked meetings.']);
  assert.equal((await read()).owner.name, '');

  const types = [{ ...first.types[1], title: 'Working session', durationMin: 45, notesToWiki: false }];
  const saved = await write('/api/booking', 'PATCH', { owner: { name: 'Urs Wilcke', headline: 'Antaia' }, types });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.deepEqual([body.owner.name, body.types.length, body.types[0].title, body.types[0].durationMin, body.types[0].notesToWiki],
    ['Urs Wilcke', 1, 'Working session', 45, false]);
  assert.equal(openStore(dir).state.booking.types[0].slug, 'meeting');

  // A request Dayline could not book is listed until the owner dismisses it.
  service.data.booking.notices.push({ id: 'a'.repeat(24), at: '2026-11-23T08:00:00.000Z', kind: 'declined', reason: 'taken', name: 'Ada Guest',
    email: 'ada@example.test', type: 'Working session', start: '2026-11-24T17:00:00.000Z' });
  assert.equal((await (await fetch(app.origin + '/api/state', { headers: { cookie } })).json()).booking.notices, 1);
  assert.deepEqual((await (await write('/api/booking/notices', 'POST', { id: 'a'.repeat(24) })).json()).notices, []);

  // Bookings is a third tab beside Week and Day agenda, not a Settings section.
  const html = await (await fetch(app.origin + '/', { headers: { cookie } })).text();
  assert.match(html, /id="view-bookings"[^>]*>.*Bookings<\/button>/);
  assert.doesNotMatch(html, /id="tab-booking"/);
  assert.match(html, /id="booking-settings"/);
  assert.equal((await fetch(app.origin + '/booking-settings.js', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(app.origin + '/booking-settings.css', { headers: { cookie } })).status, 200);
});
