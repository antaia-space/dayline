import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { invalid } from './service.mjs';
import { durationNotes } from './task-learning.mjs';
import { createCaptureHandler } from './capture.mjs';
import { LiveCalendar } from './live-calendar.mjs';

const POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const escape = v => String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const TASK_ROUTE = /^\/api\/tasks\/([a-f0-9]{32})$/;
const ESTIMATE_ROUTE = /^\/api\/tasks\/([a-f0-9]{32})\/estimate$/;
const DURATION_ROUTE = /^\/api\/tasks\/([a-f0-9]{32})\/duration$/;
const ORDER_ROUTE = /^\/api\/tasks\/([a-f0-9]{32})\/order$/;
const MOVE_LATER_ROUTE = /^\/api\/tasks\/([a-f0-9]{32})\/move-later$/;
const SUBTASK_ROUTE = /^\/api\/tasks\/([a-f0-9]{32})\/subtasks(?:\/([a-f0-9]{32}))?$/;
const ACTION_ROUTE = /^\/action\/([a-f0-9]{32})$/;

function subtaskOperation(method, member, body) {
  let kind, allowed;
  if (!member && method === 'POST') { kind = 'add'; allowed = ['id', 'title', 'done']; }
  else if (member && method === 'DELETE') { kind = 'remove'; allowed = ['expectedTitle', 'expectedDone', 'requestId']; }
  else if (member && method === 'PATCH' && Object.hasOwn(body, 'title')) { kind = 'rename'; allowed = ['title', 'expectedTitle', 'requestId']; }
  else if (member && method === 'PATCH' && Object.hasOwn(body, 'done')) { kind = 'check'; allowed = ['done', 'expectedDone', 'requestId']; }
  else throw invalid('Choose a step to add, rename, remove or check.');
  if (Object.keys(body).some(k => !allowed.includes(k))) throw invalid('Unknown subtask change.');
  const { id, ...fields } = body;
  return { kind, subtaskId: member || id, ...fields };
}

async function jsonInput(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw invalid('Send a JSON request.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw invalid('The request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const obj = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
    return obj;
  } catch { throw invalid('Send a valid JSON object.'); }
}

function page(title, body, link = '/', label = 'Open planner') {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Dayline · ' + escape(title) +
    '</title><style>:root{color-scheme:light dark}body{margin:clamp(32px,12vw,150px) auto;max-width:32em;padding:0 24px;background:#fbfbf8;color:#282a25;font:17px/1.55 system-ui}small{font-size:15px;color:#62645d}h1{font:normal 42px/1.1 Georgia,serif;margin:.7em 0 .4em}a{color:#863827;text-underline-offset:4px}:focus-visible{outline:2px solid currentColor;outline-offset:3px}@media(prefers-color-scheme:dark){body{background:#1c1f1d;color:#ecece3}small{color:#bbc0b4}a{color:#f5ac93}::selection{background:#704739;color:#fff0e9}}</style><small>Dayline / Antaia</small><h1>' + escape(title) +
    '</h1><p>' + escape(body) + '</p><a href="' + escape(link) + '">' + escape(label) + '</a></html>';
}

export async function startServer({ service, agents, webRoot, port = 43127, intervalMs = 60000,
  calendarMonitorOptions, calendarPushOptions }) {
  const sessionSecret = randomBytes(32).toString('base64url');
  const invitations = new Map();
  const capture = createCaptureHandler(service,agents);
  let durationSyncTimer;
  let cookieName;
  let origin;
  let closed = false;
  const live = new LiveCalendar(service, {
    monitor: calendarMonitorOptions, push: calendarPushOptions,
    enabled: Boolean(intervalMs || calendarMonitorOptions || calendarPushOptions)
  });
  const headers = {
    'Cache-Control': 'no-store', 'Content-Security-Policy': POLICY, 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin'
  };
  const sessionCookie = () => cookieName + '=' + sessionSecret + '; Path=/; HttpOnly; SameSite=Lax';
  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, { ...headers, 'Content-Type': type + '; charset=utf-8', ...extra });
    res.end(body);
  };
  function background() {
    if (!closed && service.data.accounts.length) service.queueSync().catch(() => {});
  }

  async function handle(req, res) {
    if (!origin || req.headers.host !== new URL(origin).host) throw invalid('Use the Dayline address on this Mac.', 403);
    const url = new URL(req.url, origin);
    if (url.origin !== origin) throw invalid('Use the local Dayline address.', 403);
    const pathname = url.pathname;
    const hasSession = (req.headers.cookie || '').split(';').some(c => c.trim() === cookieName + '=' + sessionSecret);
    if (req.method === 'GET' && pathname === '/open') {
      const request = invitations.get(url.searchParams.get('ticket'));
      invitations.delete(url.searchParams.get('ticket'));
      if (!request || request.expires < Date.now()) return send(res, 403, 'text/html', page('This browser link has expired', 'Open a fresh browser tab paired with Dayline on this Mac.', 'dayline://browser', 'Reopen planner in browser'));
      res.writeHead(303, { ...headers, Location: request.destination, 'Set-Cookie': sessionCookie() }); res.end(); return;
    }
    if (req.method === 'GET' && pathname === '/oauth/callback') {
      try {
        await service.run(() => service.finishConnection(Object.fromEntries(url.searchParams)));
        void live.refresh().catch(() => {});
        res.writeHead(303, { ...headers, Location: '/connected', 'Set-Cookie': sessionCookie() }); res.end();
      } catch (error) {
        send(res, 400, 'text/html', page('Google connection incomplete', error.message, 'dayline://open', 'Return to Dayline'));
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/connected') {
      return send(res, 200, 'text/html', page('Google Calendar is connected', 'Your Mac is checking the calendars you can access. You can return to the Dayline window or open your planner here.'));
    }

    if (pathname.startsWith('/api/')) {
      if (!hasSession) throw invalid('Open Dayline on this Mac and choose File → Open in Browser.', 401);
      if (req.method === 'GET' && pathname === '/api/updates') {
        if (req.headers.origin && req.headers.origin !== origin) throw invalid('Open the planner on this Mac.', 403);
        res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
        live.attach(res);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/state') {
        const selectedAgent = agents?.selected ?? { provider: 'local', model: '' };
        return send(res, 200, 'application/json', JSON.stringify({ ...service.snapshot(), selectedAgent, calendarPush: live.status(),
          lastAgentRun: service.data.agent?.lastRun || null }));
      }
      if (req.method === 'GET' && pathname === '/api/meetings') {
        const week = await service.meetings({ from: url.searchParams.get('from'), to: url.searchParams.get('to') });
        return send(res, 200, 'application/json', JSON.stringify(week));
      }
      if (req.method === 'GET' && pathname === '/api/agent' && agents) {
        const details = await agents.status(url.searchParams.get('provider') ?? undefined);
        return send(res, 200, 'application/json', JSON.stringify({ ...details, durationNotes: durationNotes(service.data) }));
      }
      if (req.headers.origin !== origin) throw invalid('Open this action in your local planner.', 403);
      const body = await jsonInput(req);
      let result = { ok: true };
      const match = TASK_ROUTE.exec(pathname);
      const retry = ESTIMATE_ROUTE.exec(pathname);
      const duration = DURATION_ROUTE.exec(pathname);
      const order = ORDER_ROUTE.exec(pathname);
      const moveLater = MOVE_LATER_ROUTE.exec(pathname);
      const subtask = SUBTASK_ROUTE.exec(pathname);
      let status = 200;
      let syncAfter = true;
      if (req.method === 'POST' && pathname === '/api/calendar/check') {
        live.check();
        status = 202;
        syncAfter = false;
      } else if (req.method === 'POST' && pathname === '/api/capture') {
        result = await capture(body);
        status = result.kind === 'command' ? 200 : 202;
        syncAfter = result.status === 'applied';
      } else if (req.method === 'POST' && pathname === '/api/tasks') {
        result.id = await service.run(() => service.enqueueTask(body));
        status = 202;
        syncAfter = false;
      } else if (req.method === 'POST' && retry) {
        result.id = await service.run(() => service.enqueueRetry(retry[1], body));
        status = 202;
        syncAfter = false;
      } else if (subtask) {
        const operation = subtaskOperation(req.method, subtask[2], body);
        result = await service.run(() => service.changeSubtask(subtask[1], operation));
        syncAfter = result.completionChanged;
      } else if (req.method === 'POST' && moveLater) {
        result = await service.run(() => service.moveTaskLater(moveLater[1],body));
      } else if (req.method === 'POST' && order) {
        result = await service.run(() => service.reorderTask(order[1], body));
        if (service.data.accounts.length) await service.queueSync();
        if (service.error) result.notice = 'Order saved. ' + service.error;
        syncAfter = false;
      } else if (req.method === 'POST' && duration) {
        result = await service.run(() => service.adjustDuration(duration[1], body));
        syncAfter = false;
        if (service.data.accounts.length) {
          clearTimeout(durationSyncTimer);
          durationSyncTimer = setTimeout(background, 300);
          durationSyncTimer.unref();
        }
      } else if (req.method === 'POST' && pathname === '/api/agent' && agents) {
        result = await service.run(() => agents.select(body));
        syncAfter = false;
      } else if (req.method === 'POST' && pathname === '/api/agent/login' && agents) {
        result = await agents.login(body);
        syncAfter = false;
      } else if (req.method === 'PATCH' && match) {
        result.id = await service.run(() => {
          if (typeof body.text === 'string' && body.text.trim() !== service.findTask(match[1]).text) {
            status = 202;
            syncAfter = false;
          }
          return service.enqueueEdit(match[1], body);
        });
      } else if (req.method === 'DELETE' && match) await service.run(() => service.deleteTask(match[1]));
      else if (req.method === 'PATCH' && pathname === '/api/settings') {
        await service.run(() => service.updateSettings(body));
        if (service.data.accounts.length) void live.refresh().catch(() => {});
        syncAfter = false;
      }
      else if (req.method === 'POST' && pathname === '/api/connection/config') await service.run(() => service.configure(body));
      else if (req.method === 'POST' && pathname === '/api/connection/start') {
        result = await service.run(() => service.beginConnection(body));
        syncAfter = false;
      } else if (req.method === 'POST' && pathname === '/api/connection/disconnect') {
        await service.run(() => service.disconnect(body.sub));
        void live.refresh().catch(() => {});
        syncAfter = false;
      } else if (req.method === 'POST' && pathname === '/api/sync') {
        await live.refresh();
        syncAfter = false;
      } else throw invalid('Unknown Dayline action.', 404);
      if (syncAfter) background();
      return send(res, status, 'application/json', JSON.stringify(result));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') throw invalid('Unknown request.', 405);
    const action = ACTION_ROUTE.exec(pathname);
    if (!hasSession && (pathname === '/' || action)) {
      if (action) {
        const deepLink = 'dayline://action/' + action[1] + (url.searchParams.get('done') === '0' ? '?done=0' : '?done=1');
        return send(res, 200, 'text/html', page('Open the task in Dayline', 'Review the task in the Mac app to confirm the change.', deepLink, 'Open task in Dayline'));
      }
      return send(res, 200, 'text/html', page('Open your browser planner', 'Dayline will open a paired tab in your default browser. You can also choose File → Open in Browser in the Mac app.', 'dayline://browser', 'Open planner in browser'));
    }
    const asset = (pathname === '/' || action) ? 'index.html' : pathname.slice(1);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(asset) || asset.split('/').some(part => !part || part.startsWith('.')) || !MIME[path.extname(asset)]) throw invalid('Page not found.', 404);
    let content;
    try { content = await readFile(path.join(webRoot, asset)); } catch { throw invalid('Page not found.', 404); }
    return send(res, 200, MIME[path.extname(asset)], req.method === 'HEAD' ? '' : content);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      const status = error instanceof RangeError ? 400 : (Number.isInteger(error.status) ? error.status : 500);
      send(res, status >= 400 && status <= 599 ? status : 500, 'application/json',
        JSON.stringify({ error: error instanceof RangeError || error.status ? error.message : 'Dayline could not finish this request. Please try again.' }));
    });
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  cookieName = 'dayline_session_' + server.address().port;
  service.origin = origin;
  service.startEstimateWorker();
  // Local planners also need the clock to advance active work at its scheduled end.
  const timer = intervalMs ? setInterval(() => {
    if (closed || service.retrySyncAt > Date.now()) return;
    if (service.data.accounts.length) void live.refresh().catch(() => {});
    else service.queueSync().catch(() => {});
  }, intervalMs) : null;
  timer?.unref();
  const keepAlive = setInterval(() => live.heartbeat(), 25000);
  keepAlive.unref();
  if (service.data.accounts.length) void live.refresh().catch(() => {});
  return {
    origin,
    checkCalendars: () => live.check(),
    resumeCalendars: () => live.resume(),
    launchUrl(destination = '/') {
      if (destination !== '/' && !/^\/action\/[a-f0-9]{32}(?:\?done=[01])?$/.test(destination)) destination = '/';
      for (const [key, ticket] of invitations) if (ticket.expires < Date.now()) invitations.delete(key);
      const ticket = randomBytes(24).toString('base64url');
      invitations.set(ticket, { destination, expires: Date.now() + 120000 });
      return origin + '/open?ticket=' + ticket;
    },
    async close() {
      closed = true;
      clearInterval(timer);
      clearInterval(keepAlive);
      clearTimeout(durationSyncTimer);
      service.stopEstimateWorker();
      await live.close();
      await new Promise(resolve => server.close(resolve));
      await service.tail;
    }
  };
}
