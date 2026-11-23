import { DurableObject } from 'cloudflare:workers';
import { calendarNotice, createRelay } from './receiver.mjs';
import { BookingBoard } from './booking.mjs';

export default {fetch:createRelay()};

// An active socket needs only its expiry to survive hibernation. A notification
// with no connected Mac is intentionally discarded; reconnect triggers a pull.
export class DeviceStream extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}','{"type":"pong"}'));
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path==='/connect' && request.method==='GET') {
      const expires = Number(request.headers.get('x-dayline-expires'));
      if (!Number.isSafeInteger(expires) || expires<=Date.now()) return new Response(null,{status:401});
      const [client,server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({expires});
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm===null || expires<alarm) await this.ctx.storage.setAlarm(expires);
      server.send('{"type":"ready"}');
      return new Response(null,{status:101,headers:{'Sec-WebSocket-Protocol':'dayline.v1'},webSocket:client});
    }
    if (path==='/notify' && request.method==='POST') {
      const data = await request.json().catch(() => null);
      const notice = calendarNotice(data?.channelId,data?.messageNumber,data?.state);
      if (!notice) return new Response(null,{status:400});
      const packet = JSON.stringify(notice);
      for (const ws of this.ctx.getWebSockets()) {
        if (!this.active(ws)) continue;
        try { ws.send(packet); } catch { this.end(ws,1011); }
      }
      return new Response(null,{status:204});
    }
    // A guest sent a booking request. The signal carries nothing; the Mac
    // collects the request itself over HTTPS.
    if (path==='/signal' && request.method==='POST') {
      for (const ws of this.ctx.getWebSockets()) {
        if (!this.active(ws)) continue;
        try { ws.send('{"type":"booking"}'); } catch { this.end(ws,1011); }
      }
      return new Response(null,{status:204});
    }
    return new Response(null,{status:404});
  }

  end(ws,code) {
    try { ws.close(code); } catch {}
  }

  active(ws) {
    if (ws.readyState!==1) return false;
    const expires = ws.deserializeAttachment()?.expires;
    if (Number.isSafeInteger(expires) && expires>Date.now()) return expires;
    this.end(ws,1008);
    return false;
  }

  async alarm() {
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const expires = this.active(ws);
      if (expires) next = Math.min(next,expires);
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }

  webSocketMessage(ws) { this.end(ws,1008); }
  webSocketClose(ws,code) {
    const valid = code >= 1000 && code < 5000 && ![1004,1005,1006,1015].includes(code);
    this.end(ws,valid ? code : undefined);
  }
  webSocketError(ws) { this.end(ws,1011); }
}

// One person's booking page. Durable Objects run one request at a time, so two
// guests can never be given the same time. An alarm deletes what is due.
export class BookingPage extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.board = new BookingBoard({storage:ctx.storage,secret:new TextEncoder().encode(env.RELAY_SECRET),
      signal:streamId => env.STREAMS.get(env.STREAMS.idFromName(streamId)).fetch(new Request('https://device.internal/signal',{method:'POST'}))});
  }

  async schedule(due) {
    if (due===null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(due);
  }

  async fetch(request) {
    if (request.method!=='POST' || new URL(request.url).pathname!=='/call') return new Response(null,{status:404});
    const answer = await this.board.handle(await request.json());
    await this.schedule(this.board.nextSweep());
    return Response.json(answer);
  }

  async alarm() { await this.schedule(await this.board.expire()); }
}
