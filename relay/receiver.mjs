import { base64url, createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const googleIssuers = ['https://accounts.google.com', 'accounts.google.com'];
const streamPattern = /^[A-Za-z0-9_-]{43}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxBody = 1024;
const maxGuestBody = 12 * 1024;
const maxSyncBody = 1024 * 1024;
const lifetime = 8 * 24 * 60 * 60;
const encoder = new TextEncoder();
const handlePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const reservedHandles = new Set(['api', 'v1', 'health', 'assets']);
const HANDLE = '([a-z0-9][a-z0-9._-]{0,62})', SLUG = '([a-z0-9][a-z0-9-]{0,39})', TOKEN = '([0-9a-v]{24}\\.[A-Za-z0-9_-]{27})';
const pageRoute = new RegExp('^/' + HANDLE + '(?:/' + SLUG + '|/booking/' + TOKEN + ')?$');
const apiRoute = new RegExp('^/api/' + HANDLE + '/(?:(page)|(book)|slots/' + SLUG + '|booking/' + TOKEN + '(?:/(reschedule|cancel))?)$');
const pagePolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const shell = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>Book a meeting</title>' +
  '<link rel="stylesheet" href="/assets/booking.css"><main id="app"><p class="muted">Loading…</p></main>' +
  '<noscript>This booking page needs JavaScript.</noscript><script type="module" src="/assets/booking.js"></script></html>';

function reply(status, data) {
  const headers = { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' };
  if (data === undefined) return new Response(null,{status,headers});
  return Response.json(data,{status,headers});
}

// Webhook bodies carry no information needed by the Mac. Bound both declared
// and chunked bodies before handling any content.
async function boundedBody(request, limit = maxBody) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length)>limit)) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk,offset); offset += chunk.byteLength; }
  return result;
}

// Returns the parsed object, or the HTTP status that explains why there is none.
async function jsonBody(request, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return 415;
  const bytes = await boundedBody(request, limit);
  if (!bytes) return 413;
  try {
    const input = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    return input && typeof input === 'object' && !Array.isArray(input) ? input : 400;
  } catch { return 400; }
}

function signTicket(key, streamId, scope, expires, claims = {}) {
  return new SignJWT(claims).setProtectedHeader({alg:'HS256',typ:'dayline-relay+jwt'})
    .setIssuer('dayline').setAudience(scope).setSubject(streamId).setExpirationTime(expires).sign(key);
}

async function ticketExpiry(token,key,streamId,scope,now) {
  if (typeof token !== 'string' || token.length>256 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
  try {
    const {payload} = await jwtVerify(token,key,{algorithms:['HS256'],typ:'dayline-relay+jwt',issuer:'dayline',
      audience:scope,subject:streamId,requiredClaims:['exp'],currentDate:new Date(now)});
    return Number.isSafeInteger(payload.exp) ? payload.exp*1000 : null;
  } catch { return null; }
}

// A booking ticket names the one page its Mac may publish: the part of the
// verified Workspace address before "@". Nobody can publish another person's page.
async function bookingTicket(request,key,now) {
  const auth = request.headers.get('authorization') || '';
  if (auth.length>600 || !/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/i.test(auth)) return null;
  try {
    const {payload} = await jwtVerify(auth.slice(7),key,{algorithms:['HS256'],typ:'dayline-relay+jwt',issuer:'dayline',
      audience:'booking',requiredClaims:['exp','sub'],currentDate:new Date(now)});
    return streamPattern.test(payload.sub) && bookingHandle(payload.handle) ? {streamId:payload.sub,handle:payload.handle} : null;
  } catch { return null; }
}

function bookingHandle(value) {
  return typeof value === 'string' && handlePattern.test(value) && !reservedHandles.has(value) ? value : null;
}

function receiverTicket(request) {
  const header = request.headers.get('sec-websocket-protocol') || '';
  if (header.length>320) return null;
  const protocols = header.split(',').map(p=>p.trim());
  if (protocols.length!==2 || !protocols.includes('dayline.v1')) return null;
  return protocols.find(p=>p.startsWith('ticket.'))?.slice(7) || null;
}

export function calendarNotice(channelId,messageNumber,state) {
  if (typeof channelId !== 'string' || !uuid.test(channelId) || typeof messageNumber !== 'string' ||
    !/^[1-9]\d{0,29}$/.test(messageNumber) || !['sync','exists','not_exists'].includes(state)) return null;
  return {type:'calendar',channelId:channelId.toLowerCase(),messageNumber,state};
}

async function askPage(env, handle, call) {
  const object = env.PAGES.get(env.PAGES.idFromName(handle));
  const answer = await object.fetch(new Request('https://page.internal/call',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({...call,handle})}));
  if (!answer.ok) return reply(503);
  const {status,body} = await answer.json();
  return reply(status,body);
}

// Public booking pages and the Mac's side of them. Returns undefined for any
// other path, which then follows the calendar notification routes below.
async function bookingRelay(request, env, url, time) {
  const page = request.method==='GET' ? pageRoute.exec(url.pathname) : null;
  const api = apiRoute.exec(url.pathname);
  const sync = url.pathname==='/v1/booking/sync';
  if (!sync && !api && !(page && bookingHandle(page[1]))) return undefined;
  if (!env.PAGES) return reply(404);
  if (page && !api) {
    return new Response(shell,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'Content-Security-Policy':pagePolicy,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'}});
  }
  if (typeof env.RELAY_SECRET!=='string' || encoder.encode(env.RELAY_SECRET).length<32) return reply(503);
  if (sync) {
    if (request.method!=='POST') return reply(405);
    const ticket = await bookingTicket(request,encoder.encode(env.RELAY_SECRET),time);
    if (!ticket) return reply(401);
    const input = await jsonBody(request,maxSyncBody);
    if (typeof input === 'number') return reply(input);
    return askPage(env,ticket.handle,{op:'sync',streamId:ticket.streamId,input});
  }
  const [,handle,isPage,isBook,slug,token,action] = api;
  if (!bookingHandle(handle)) return reply(404);
  const reading = Boolean(isPage || slug || (token && !action));
  if (request.method !== (reading ? 'GET' : 'POST')) return reply(405);
  let input;
  if (!reading) {
    // A page on another site cannot post a booking through a visitor's browser.
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return reply(403,{error:'Open the booking page itself to send this request.'});
    input = await jsonBody(request,maxGuestBody);
    if (typeof input === 'number') return reply(input,{error:'Bad request.'});
  }
  const op = isPage ? 'page' : isBook ? 'book' : slug ? 'slots' : action || 'status';
  return askPage(env,handle,{op,slug,token,input,ip:request.headers.get('cf-connecting-ip') || 'unknown'});
}

export function createRelay({keys = googleKeys,now = Date.now} = {}) {
  return async function fetchRelay(request,env) {
    const url = new URL(request.url);
    if (url.search) return reply(404);
    if (request.method==='GET' && url.pathname==='/health') return reply(200,{ok:true});
    const route = /^\/v1\/(stream|google)\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
    const session = url.pathname==='/v1/session';
    if (!session && !route) {
      try { return await bookingRelay(request,env,url,now()) ?? reply(404); } catch { return reply(503); }
    }
    if (request.method !== (route?.[1]==='stream'?'GET':'POST')) return reply(405);
    if (typeof env.RELAY_SECRET!=='string' || encoder.encode(env.RELAY_SECRET).length<32) return reply(503);
    const key = encoder.encode(env.RELAY_SECRET), time = now();
    try {
      if (session) {
        if (typeof env.GOOGLE_CLIENT_ID!=='string' || !env.GOOGLE_CLIENT_ID) return reply(503);
        const auth = request.headers.get('authorization') || '';
        if (auth.length>10000 || !/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/i.test(auth)) return reply(401);
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return reply(415);
        const bytes = await boundedBody(request);
        if (!bytes) return reply(413);
        let input;
        try { input = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { return reply(400); }
        if (!input || Object.keys(input).length!==1 || typeof input.deviceId!=='string' || !streamPattern.test(input.deviceId)) return reply(400);
        let payload;
        try {
          ({payload} = await jwtVerify(auth.slice(7),keys,{algorithms:['RS256'],issuer:googleIssuers,audience:env.GOOGLE_CLIENT_ID,
            requiredClaims:['iss','aud','sub','exp','iat'],currentDate:new Date(time)}));
        } catch (error) {
          return reply(error.code==='ERR_JWKS_TIMEOUT' || error instanceof TypeError ? 503 : 401);
        }
        if (typeof payload.sub!=='string' || !payload.sub.length || payload.sub.length>255 ||
          payload.hd!=='antaia.space' || ![true,'true'].includes(payload.email_verified) ||
          ((payload.azp!==undefined || (Array.isArray(payload.aud) && payload.aud.length>1)) && payload.azp!==env.GOOGLE_CLIENT_ID)) return reply(403);
        const digest = await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(['dayline-device-v1',payload.sub,input.deviceId])));
        const streamId = base64url.encode(new Uint8Array(digest)), expires = Math.floor(time/1000)+lifetime;
        const [receiveToken,notifyToken] = await Promise.all([signTicket(key,streamId,'receive',expires),signTicket(key,streamId,'notify',expires)]);
        const granted = {streamId,receiveToken,notifyToken,expiresAt:expires*1000};
        // The Workspace address is verified above; its local part names this person's booking page.
        const address = typeof payload.email==='string' ? payload.email.toLowerCase() : '';
        const handle = env.PAGES && address.endsWith('@antaia.space') ? bookingHandle(address.slice(0,-'@antaia.space'.length)) : null;
        if (handle) Object.assign(granted,{bookingHandle:handle,bookingToken:await signTicket(key,streamId,'booking',expires,{handle})});
        return reply(200,granted);
      }
      const [,kind,streamId] = route;
      if (kind==='stream' && request.headers.get('upgrade')?.toLowerCase()!=='websocket') return reply(426);
      const token = kind==='stream' ? receiverTicket(request) : request.headers.get('x-goog-channel-token');
      const expires = await ticketExpiry(token,key,streamId,kind==='stream'?'receive':'notify',time);
      if (!expires) return reply(401);
      let internal;
      if (kind==='stream') {
        internal = new Request('https://device.internal/connect',{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'dayline.v1',
          'X-Dayline-Expires':String(expires)}});
      } else {
        const notice = calendarNotice(request.headers.get('x-goog-channel-id'),request.headers.get('x-goog-message-number'),
          request.headers.get('x-goog-resource-state'));
        if (!notice) return reply(400);
        if (!await boundedBody(request)) return reply(413);
        internal = new Request('https://device.internal/notify',{method:'POST',body:JSON.stringify(notice)});
      }
      const object = env.STREAMS.get(env.STREAMS.idFromName(streamId));
      return await object.fetch(internal);
    } catch { return reply(503); }
  };
}
