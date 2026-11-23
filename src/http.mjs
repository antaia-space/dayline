import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { invalid } from './service.mjs';

const POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const escape = v => String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const TASK_ROUTE = /^\/api\/tasks\/([a-f0-9]{32})$/;
const ESTIMATE_ROUTE = /^\/api\/tasks\/([a-f0-9]{32})\/estimate$/;
const ACTION_ROUTE = /^\/action\/([a-f0-9]{32})$/;

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

export async function startServer({ service, agents, webRoot, port = 43127, intervalMs = 60000 }) {
  const sessionSecret = randomBytes(32).toString('base64url');
  const invitations = new Map();
  const retrying = new Map();
  let cookieName;
  let origin;
  let closed = false;
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
      if (!request || request.expires < Date.now()) return send(res, 403, 'text/html', page('Open Dayline on this Mac', 'Choose File → Open in Browser to start a browser session.', 'dayline://open', 'Open Dayline'));
      res.writeHead(303, { ...headers, Location: request.destination, 'Set-Cookie': sessionCookie() }); res.end(); return;
    }
    if (req.method === 'GET' && pathname === '/oauth/callback') {
      try {
        await service.run(() => service.finishConnection(Object.fromEntries(url.searchParams)));
        background();
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
      if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, 'application/json', JSON.stringify(service.snapshot()));
      if (req.method === 'GET' && pathname === '/api/agent' && agents) {
        const details = await agents.status(url.searchParams.get('provider') ?? undefined);
        return send(res, 200, 'application/json', JSON.stringify(details));
      }
      if (req.headers.origin !== origin) throw invalid('Open this action in your local planner.', 403);
      const body = await jsonInput(req);
      let result = { ok: true };
      const match = TASK_ROUTE.exec(pathname);
      const retry = ESTIMATE_ROUTE.exec(pathname);
      let syncAfter = true;
      if (req.method === 'POST' && pathname === '/api/tasks') result.id = await service.run(() => service.createTask(body));
      else if (req.method === 'POST' && retry) {
        const taskId = retry[1];
        if (!retrying.has(taskId)) {
          const pending = service.run(() => service.retryEstimate(taskId)).finally(() => retrying.delete(taskId));
          retrying.set(taskId, pending);
        }
        await retrying.get(taskId);
      } else if (req.method === 'POST' && pathname === '/api/agent' && agents) {
        result = await service.run(() => agents.select(body));
        syncAfter = false;
      } else if (req.method === 'POST' && pathname === '/api/agent/login' && agents) {
        result = await agents.login(body);
        syncAfter = false;
      } else if (req.method === 'PATCH' && match) await service.run(() => service.editTask(match[1], body));
      else if (req.method === 'DELETE' && match) await service.run(() => service.deleteTask(match[1]));
      else if (req.method === 'PATCH' && pathname === '/api/settings') await service.run(() => service.updateSettings(body));
      else if (req.method === 'POST' && pathname === '/api/connection/config') await service.run(() => service.configure(body));
      else if (req.method === 'POST' && pathname === '/api/connection/start') {
        result = await service.run(() => service.beginConnection(body));
        syncAfter = false;
      } else if (req.method === 'POST' && pathname === '/api/connection/disconnect') {
        await service.run(() => service.disconnect(body.sub));
      } else if (req.method === 'POST' && pathname === '/api/sync') {
        await service.queueSync();
        syncAfter = false;
      } else throw invalid('Unknown Dayline action.', 404);
      if (syncAfter) background();
      return send(res, 200, 'application/json', JSON.stringify(result));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') throw invalid('Unknown request.', 405);
    const action = ACTION_ROUTE.exec(pathname);
    if (!hasSession && (pathname === '/' || action)) {
      const deepLink = action ? 'dayline://action/' + action[1] + (url.searchParams.get('done') === '0' ? '?done=0' : '?done=1') : 'dayline://open';
      return send(res, 200, 'text/html', page('Open Dayline on this Mac', action ? 'Open the linked task in Dayline to confirm the change.' : 'For a paired browser tab, choose File → Open in Browser in the Mac app.', deepLink, action ? 'Open task in Dayline' : 'Open Dayline'));
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
  const timer = intervalMs ? setInterval(background, intervalMs) : null;
  timer?.unref();
  background();
  return {
    origin,
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
      await new Promise(resolve => server.close(resolve));
      await service.tail;
    }
  };
}
