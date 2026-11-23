import { base64url, createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const googleIssuers = ['https://accounts.google.com', 'accounts.google.com'];
const streamPattern = /^[A-Za-z0-9_-]{43}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxBody = 1024;
const lifetime = 8 * 24 * 60 * 60;
const encoder = new TextEncoder();

function reply(status, data) {
  const headers = { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' };
  if (data === undefined) return new Response(null,{status,headers});
  return Response.json(data,{status,headers});
}

// Webhook bodies carry no information needed by the Mac. Bound both declared
// and chunked bodies before handling any content.
async function boundedBody(request) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length)>maxBody)) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBody) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk,offset); offset += chunk.byteLength; }
  return result;
}

function signTicket(key, streamId, scope, expires) {
  return new SignJWT({}).setProtectedHeader({alg:'HS256',typ:'dayline-relay+jwt'})
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

export function createRelay({keys = googleKeys,now = Date.now} = {}) {
  return async function fetchRelay(request,env) {
    const url = new URL(request.url);
    if (url.search) return reply(404);
    if (request.method==='GET' && url.pathname==='/health') return reply(200,{ok:true});
    const route = /^\/v1\/(stream|google)\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
    const session = url.pathname==='/v1/session';
    if (!session && !route) return reply(404);
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
        return reply(200,{streamId,receiveToken,notifyToken,expiresAt:expires*1000});
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
