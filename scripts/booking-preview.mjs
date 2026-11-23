// Local preview of the public booking page, without Cloudflare or Google.
//
//   node scripts/booking-preview.mjs          then open http://127.0.0.1:43129/demo
//
// It serves relay/public and runs the receiver's own booking code against a
// page object in memory. A pretend Mac confirms requests after a moment; open
// /__mac/asleep or /__mac/awake to see what a guest gets in each case.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../relay/receiver.mjs';
import { BookingBoard } from '../relay/booking.mjs';

const port = Number(process.env.PORT || 43129), origin = 'http://127.0.0.1:' + port;
const assets = fileURLToPath(new URL('../relay/public/', import.meta.url));
const types = { '.js': 'text/javascript', '.css': 'text/css' };
const secret = 'Preview-only secret; nothing here leaves this computer';
const stored = new Map();
const storage = { get: async key => structuredClone(stored.get(key)), put: async (key, value) => void stored.set(key, structuredClone(value)), delete: async key => void stored.delete(key) };
const board = new BookingBoard({ storage, secret: new TextEncoder().encode(secret) });
const env = { RELAY_SECRET: secret, STREAMS: {}, PAGES: { idFromName: name => name, get: () => ({ fetch: async request => Response.json(await board.handle(await request.json())) }) } };
const relay = createRelay();
let awake = true;

function demoPage() {
  const slots = [], now = Date.now();
  // Weekdays 09:00–17:00 UTC for six weeks, with a lunch break.
  for (let day = 1; day <= 42; day++) {
    const date = new Date(now + day * 86_400_000);
    if ([0, 6].includes(date.getUTCDay())) continue;
    for (let minute = 9 * 60; minute < 17 * 60; minute += 30) {
      if (minute >= 12 * 60 && minute < 13 * 60) continue;
      slots.push(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, minute));
    }
  }
  const type = (slug, title, description, durationMin, hidden = false) => ({ slug, title, description, durationMin, bufferMin: 15, minNoticeMin: 720, maxDaysAhead: 45, hidden });
  return { owner: { name: 'Demo Owner', headline: 'Antaia' }, paused: null,
    types: [type('intro', 'Intro call', 'A short first conversation.', 15), type('meeting', 'Meeting', 'A regular working call.', 30),
      type('deep-dive', 'Deep dive', 'A longer session for technical or commercial detail.', 60), type('private', 'Private call', 'A confidential conversation.', 30, true)],
    slots: { intro: slots, meeting: slots, 'deep-dive': slots.filter(ms => ms % 3_600_000 === 0), private: slots } };
}

const mac = input => board.handle({ op: 'sync', handle: 'demo', streamId: 'preview', input });
await mac({ page: demoPage(), bookings: [] });
setInterval(async () => {
  if (!awake) return;
  const { requests } = (await mac({})).body;
  if (requests.length) await mac({ outcomes: requests.map(r => ({ id: r.id, kind: r.kind, ok: !r.expired, reason: 'expired', start: r.start, end: r.end })) });
}, 1500).unref();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1:' + port));
    if (url.pathname.startsWith('/__mac/')) {
      awake = url.pathname === '/__mac/awake';
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('The pretend Mac is ' + (awake ? 'awake' : 'asleep') + '.\n');
    }
    if (/^\/assets\/[a-z.-]+$/.test(url.pathname) && types[url.pathname.slice(url.pathname.lastIndexOf('.'))]) {
      res.writeHead(200, { 'Content-Type': types[url.pathname.slice(url.pathname.lastIndexOf('.'))] + '; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(await readFile(assets + url.pathname.slice(1)));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const answer = await relay(new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(port, '127.0.0.1', () => console.log('Booking page preview: ' + origin + '/demo'));
