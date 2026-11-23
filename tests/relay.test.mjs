import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {createRemoteJWKSet,decodeJwt,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {createRelay} from '../relay/receiver.mjs';

const client = 'test-app.apps.googleusercontent.com', base = 'https://relay.example.invalid';
const start = Date.parse('2026-11-23T10:00:00Z'), day = 86400000;
const device = 'a'.repeat(43), other = 'b'.repeat(43);
const channel = 'cd5abe70-119a-4093-a22b-eacda686ca94';
const secret = 'Synthetic receiver secret reserved for this test only';

test('Google identity, separate stream tickets and sanitized callbacks pass through the signed receiver',async t => {
  const pair = await generateKeyPair('RS256'), otherPair = await generateKeyPair('RS256');
  const jwk = {...await exportJWK(pair.publicKey),kid:'first',alg:'RS256',use:'sig'};
  let keyReads = 0;
  const certs = createServer((_req,res) => {
    keyReads++;
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({keys:[jwk]}));
  });
  await new Promise(resolve=>certs.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{ certs.close(resolve);certs.closeAllConnections(); }));
  let time = start;
  const keys = createRemoteJWKSet(new URL('http://127.0.0.1:'+certs.address().port+'/certs'));
  const relay = createRelay({keys,now:()=>time}), allocations=[], deliveries=[];
  const env = {GOOGLE_CLIENT_ID:client,RELAY_SECRET:secret,STREAMS:{
    idFromName(id) { allocations.push(id);return id; },
    get(id) { return {async fetch(req) {
      deliveries.push({id,path:new URL(req.url).pathname,headers:Object.fromEntries(req.headers),body:await req.text()});
      return new Response(null,{status:204});
    }}; }
  }};
  const request = (path,options) => relay(new Request(base+path,options),env);
  const seconds = Math.floor(start/1000);
  function identity(claims={},key=pair.privateKey) {
    return new SignJWT({sub:'subject-one',iss:'https://accounts.google.com',aud:client,iat:seconds,exp:seconds+3600,
      email_verified:true,hd:'antaia.space',...claims}).setProtectedHeader({alg:'RS256',kid:'first'}).sign(key);
  }
  async function session(id=device,claims={},key) {
    return request('/v1/session',{method:'POST',headers:{Authorization:'Bearer '+await identity(claims,key),'Content-Type':'application/json'},
      body:JSON.stringify({deviceId:id})});
  }
  function notify(stream,token,headers={},body) {
    return request('/v1/google/'+stream,{method:'POST',headers:{'X-Goog-Channel-Token':token,
      'X-Goog-Channel-ID':channel,'X-Goog-Message-Number':'18446744073709551612','X-Goog-Resource-State':'exists',...headers},body});
  }
  function listen(stream,token,headers={}) {
    return request('/v1/stream/'+stream,{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'dayline.v1, ticket.'+token,...headers}});
  }
  assert.deepEqual(await (await request('/health')).json(),{ok:true});
  assert.equal((await request('/v1/session',{method:'POST'})).status,401);
  assert.equal((await session(other,{hd:'outside.example'})).status,403);
  assert.equal((await session(other,{hd:undefined,email:'someone@antaia.space'})).status,403);
  assert.equal((await session(other,{email_verified:false})).status,403);
  assert.equal((await session(other,{sub:''})).status,403);
  assert.equal((await session(other,{aud:'unrelated-app'})).status,401);
  assert.equal((await session(other,{iss:'https://other.example'})).status,401);
  assert.equal((await session(other,{exp:seconds})).status,401);
  assert.equal((await session(other,{aud:[client,'other'],azp:'other'})).status,403);
  assert.equal((await session(other,{},otherPair.privateKey)).status,401);
  assert.equal((await session('bad device id')).status,400);
  assert.equal((await session('a'.repeat(1500))).status,413);

  const first=await (await session()).json(), second=await (await session(other)).json();
  const otherUser=await (await session(device,{sub:'subject-two'})).json();
  assert.deepEqual(Object.keys(first).sort(),['expiresAt','notifyToken','receiveToken','streamId']);
  assert.match(first.streamId,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.streamId,(await (await session()).json()).streamId);
  assert.notEqual(first.streamId,second.streamId);assert.notEqual(first.streamId,otherUser.streamId);
  assert.notEqual(first.receiveToken,first.notifyToken);assert.ok(first.notifyToken.length<256);
  assert.equal(first.expiresAt,start+8*day);assert.equal(keyReads,1);
  assert.deepEqual(Object.keys(decodeJwt(first.notifyToken)).sort(),['aud','exp','iss','sub']);
  assert.equal(decodeJwt(first.notifyToken).sub,first.streamId);
  assert.deepEqual(allocations,[]);
  assert.equal((await notify(first.streamId,first.receiveToken)).status,401);
  assert.equal((await listen(first.streamId,first.notifyToken)).status,401);
  assert.equal((await notify(second.streamId,first.notifyToken)).status,401);
  assert.equal((await listen(otherUser.streamId,first.receiveToken)).status,401);
  assert.equal((await listen(first.streamId,first.receiveToken,{'Sec-WebSocket-Protocol':'ticket.'+first.receiveToken})).status,401);
  assert.equal((await notify(first.streamId,first.notifyToken,{'X-Goog-Channel-ID':'not-a-channel'})).status,400);
  assert.equal((await notify(first.streamId,first.notifyToken,{'X-Goog-Resource-State':'private title'})).status,400);
  assert.equal((await notify(first.streamId,first.notifyToken,{'X-Goog-Message-Number':'1.2'})).status,400);
  assert.equal((await notify(first.streamId,first.notifyToken,{},'x'.repeat(1100))).status,413);
  assert.deepEqual(allocations,[]);

  assert.equal((await listen(first.streamId,first.receiveToken,{Cookie:'discard-me',Authorization:'discard-me',Origin:base})).status,204);
  assert.deepEqual(deliveries[0],{id:first.streamId,path:'/connect',body:'',headers:{
    'sec-websocket-protocol':'dayline.v1',upgrade:'websocket','x-dayline-expires':String(first.expiresAt)}});
  const callback=await notify(first.streamId,first.notifyToken,{'X-Goog-Resource-URI':'https://example.invalid/calendar/private',
    'X-Goog-Resource-ID':'private-resource',Cookie:'discard-me'},'Discard this synthetic payload.');
  assert.equal(callback.status,204);
  assert.deepEqual(JSON.parse(deliveries[1].body),{type:'calendar',channelId:channel,messageNumber:'18446744073709551612',state:'exists'});
  assert.deepEqual(Object.keys(deliveries[1].headers),['content-type']);
  assert.equal(deliveries[1].path,'/notify');
  time=first.expiresAt;
  assert.equal((await listen(first.streamId,first.receiveToken)).status,401);
  assert.equal((await notify(first.streamId,first.notifyToken)).status,401);
  assert.equal(allocations.length,2);
});
