import {it,expect} from 'vitest';
import {serve} from '@hono/node-server';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {llmGateway} from '../src/llm-gateway.js';
import {UsageLedger} from '../src/llm-usage.js';
const space=randomUUID(),merchant=randomUUID(),callers={saas:'saas',other:'other',admin:'admin'};
const config=(baseUrl:string)=>({chat:{baseUrl,model:'test',apiKey:'never-log'},assignments:{spaces:{},merchants:{},bindings:{[space]:merchant}}});
const headers={'content-type':'application/json',authorization:'Bearer saas','x-space-id':space};
it('attributes by business ownership independently of the selected model routing merchant',async()=>{
 const ledger=new UsageLedger(':memory:'),routedTo=randomUUID();let bindings:Record<string,string>={[space]:merchant};
 const app=llmGateway({config:()=>({...config('http://fixture/v1'),assignments:{spaces:{},merchants:{},bindings:{[space]:routedTo}}}),callers:()=>callers,allowInsecure:true,usage:ledger,usageBindings:{load:()=>bindings,save:v=>{bindings=v;}},fetchImpl:(async()=>Response.json({usage:{prompt_tokens:12,completion_tokens:3},choices:[]})) as typeof fetch});
 try{
  expect((await app.request('/v1/chat/completions',{method:'POST',headers,body:'{"messages":[]}'})).status).toBe(200);
  expect(ledger.query({merchant}).summary.calls).toBe(1);expect(ledger.query({merchant:routedTo}).summary.calls).toBe(0);
  expect((await app.request('/v1/admin/usage/bindings',{method:'PUT',headers,body:JSON.stringify({bindings:{[space]:routedTo}})})).status).toBe(403);
  expect(ledger.query({}).items[0].usage).toMatchObject({input:12,output:3});
 }finally{ledger.close();}
});
it('classifies a deadline as timed out and releases the slot without retrying generation',async()=>{
 const ledger=new UsageLedger(':memory:');let attempts=0;
 const app=llmGateway({config:()=>config('http://fixture/v1'),callers:()=>callers,allowInsecure:true,usage:ledger,timeoutMs:15,maxConcurrent:1,fetchImpl:(async(_url,init)=>{attempts++;const signal=init!.signal!;await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));throw Error();}) as typeof fetch});
 try{const r=await app.request('/v1/chat/completions',{method:'POST',headers,body:'{"messages":[]}'});expect(r.status).toBe(504);expect(attempts).toBe(1);expect(ledger.query({}).items[0]).toMatchObject({status:'timed_out',usageState:'unavailable'});}finally{ledger.close();}
});
it('holds a streaming slot until consumption ends and aborts the provider when the consumer cancels',async()=>{
 let upstreamSignal:AbortSignal|undefined,bodyCancelled=false;
 const ledger=new UsageLedger(':memory:');const app=llmGateway({config:()=>config('http://fixture/v1'),callers:()=>callers,allowInsecure:true,usage:ledger,maxConcurrent:1,fetchImpl:(async(_url,init)=>{upstreamSignal=init?.signal as AbortSignal;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));},cancel(){bodyCancelled=true;}}),{headers:{'content-type':'text/event-stream'}});}) as typeof fetch});
 const post=()=>app.request('/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({stream:true,messages:[]})});
 try{const first=await post();expect((await post()).status).toBe(429);await first.body!.cancel();expect(upstreamSignal?.aborted).toBe(true);expect(bodyCancelled).toBe(true);expect(ledger.query({}).items[0].status).toBe('cancelled');const next=await post();expect(next.status).toBe(200);await next.body!.cancel();}finally{ledger.close();}
});
it('scopes explicit cancellation to caller and space and handles stop-before-start races',async()=>{
 const op=randomUUID();let signal:AbortSignal|undefined;
 const ledger=new UsageLedger(':memory:'),app=llmGateway({config:()=>config('http://fixture/v1'),callers:()=>callers,allowInsecure:true,usage:ledger,fetchImpl:(async(_url,init)=>{signal=init!.signal as AbortSignal;await new Promise((_,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}));throw Error();}) as typeof fetch});
 const request=app.request('/v1/chat/completions',{method:'POST',headers:{...headers,'x-operation-id':op},body:'{"messages":[]}'});
 await new Promise(r=>setTimeout(r,10));
 await app.request('/v1/calls/'+op+'/cancel',{method:'POST',headers:{...headers,authorization:'Bearer other'}});expect(signal?.aborted).toBe(false);
 await app.request('/v1/calls/'+op+'/cancel',{method:'POST',headers});expect((await request).status).toBe(499);expect(ledger.query({}).items).toHaveLength(1);
 expect((await app.request('/v1/chat/completions',{method:'POST',headers:{...headers,'x-operation-id':op},body:'{"messages":[]}'})).status).toBe(499);ledger.close();
});
it('propagates a real HTTP disconnect all the way to the upstream socket',async()=>{
 let produced=0;let upstreamClosed!:()=>void;const closed=new Promise<void>(r=>{upstreamClosed=r;});
 const upstream=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});const timer=setInterval(()=>{produced++;res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');},10);res.on('close',()=>{clearInterval(timer);upstreamClosed();});});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const port=(upstream.address() as any).port,ledger=new UsageLedger(':memory:'),app=llmGateway({config:()=>config('http://127.0.0.1:'+port+'/v1'),callers:()=>callers,allowInsecure:true,usage:ledger});
 const gateway=serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'});await once(gateway,'listening');
 try{const controller=new AbortController(),r=await fetch('http://127.0.0.1:'+(gateway.address() as any).port+'/v1/chat/completions',{method:'POST',headers,body:'{"messages":[],"stream":true}',signal:controller.signal});await r.body!.getReader().read();controller.abort();await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('upstream kept generating')),2000))]);const n=produced;await new Promise(r=>setTimeout(r,40));expect(produced).toBe(n);expect(ledger.query({}).items[0]).toMatchObject({status:'cancelled',merchant,usageState:'unavailable'});}
 finally{(gateway as any).closeAllConnections?.();await new Promise<void>(r=>gateway.close(()=>r()));upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));ledger.close();}
});
