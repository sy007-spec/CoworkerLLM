import {resolveModel} from './model-routing.js';
import {ChatgptPlan,PLAN_BASE} from './chatgpt-plan.js';
import {registerPlanRoutes} from './chatgpt-plan-routes.js';
// Platform LLM gateway: the single egress for chat, embedding and rerank calls (InnoData and the SaaS services are both callers).
// Callers authenticate with their own key; the upstream provider key never leaves this process; models are pinned by the operator.
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {UsageLedger,usageObserver,emptyUsage,type CallRecord} from './llm-usage.js';
import {allowedModelHosts} from './model-providers.js';
import {registerAdmin,type ConfigStore,type RawConfig} from './llm-gateway-admin.js';
import {buildChat,buildEmbeddings,chatJson,chatStream,embeddingsJson,embeddingLength,supports,EmptyCompletion,type Provider,type Capability} from './llm-providers.js';

export type Upstream={baseUrl:string;apiKey:string;model:string;provider?:Provider};
// Each capability may use a different provider; a capability without a key is reported as not configured.
export type GatewayConfig={assignments?:RawConfig['assignments'];pools?:RawConfig['pools'];chat?:Upstream;embedding?:Upstream&{dimension?:number};rerank?:Upstream;extraHosts?:string[];disabledSpaces?:string[]};
export type GatewayOptions={
 plan?:ChatgptPlan;
 config:()=>GatewayConfig|undefined;
 callers:()=>Record<string,string>;
 hosts?:string[];
 store?:ConfigStore;
 allowInsecure?:boolean;
 fetchImpl?:typeof fetch;
 log?:(entry:Record<string,unknown>)=>void;
 maxConcurrent?:number;
 timeoutMs?:number;
 usage?:UsageLedger;
 usageBindings?:{load:()=>Record<string,string>;save:(bindings:Record<string,string>)=>void};
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const same=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};

// The upstream must be an approved HTTPS host (same list as the per-space model endpoints) so the gateway cannot be pointed at internal addresses.
export function upstreamUrl(config:{baseUrl:string},hosts:string[],allowInsecure=false){
 const u=new URL(config.baseUrl);
 const okProtocol=u.protocol==='https:'||allowInsecure&&u.protocol==='http:';
 if(!okProtocol||u.username||u.password||u.search||u.hash||!allowInsecure&&(u.port&&u.port!=='443'||!hosts.includes(u.hostname)))throw Error('UPSTREAM_NOT_APPROVED');
 return u.href.replace(/\/+$/,'');
}

export function requestTimeout(caller:string,requested:string|undefined){
 const n=Number(requested);return caller==='saas'&&requested&&Number.isInteger(n)&&n>0?Math.min(240000,Math.max(120000,n)):120000;
}
export function llmGateway(o:GatewayOptions){
 const app=new Hono<{Variables:{caller:string}}>(),f=o.fetchImpl??fetch,hosts=o.hosts??allowedModelHosts(),log=o.log??(()=>{}),limit=o.maxConcurrent??16;
 const active=new Map<string,number>(),cursors=new Map<string,number>();
 const operations=new Map<string,AbortController>(),cancelled=new Map<string,number>();
 app.get('/healthz',c=>c.json({status:'alive',service:'llm-gateway'}));
 app.use('/v1/*',bodyLimit({maxSize:8*1024*1024,onError:c=>c.json({error:'payload_too_large'},413)}));
 app.use('/v1/*',async(c,next)=>{
  const token=(c.req.header('authorization')??'').replace(/^Bearer /,'');
  const callers=o.callers();
  const name=token?Object.keys(callers).find(k=>same(callers[k]!,token)):undefined;
  if(!name)return c.json({error:'unauthorized'},401);
  c.set('caller',name);await next();
 });
 app.get('/v1/status',c=>{
  const g=o.config(),space=(c.req.header('x-space-id')??'').toLowerCase();if(space&&!uuid.test(space))return c.json({error:'invalid_space'},400);
  const pick=(cap:'chat'|'embedding'|'rerank')=>{if(!g)return undefined;const choice=resolveModel(g,space,cap);return choice.pool?choice.pool.entries[0]:choice.up;};
  const chat=pick('chat'),embedding=pick('embedding'),rerank=pick('rerank'),enabled=!g?.disabledSpaces?.includes(space);
  return c.json({configured:enabled&&!!(chat?.baseUrl&&chat.model&&chat.apiKey)&&(chat?.provider!=='chatgpt'||!!o.plan?.connected(chat.apiKey!.slice(5))),chatModel:chat?.model??null,embeddingConfigured:enabled&&!!(embedding?.baseUrl&&embedding.model&&embedding.apiKey),embeddingProvider:embedding?.provider??'openai',embeddingModel:embedding?.model??null,embeddingDimension:embedding?.dimension??null,rerank:enabled&&!!(rerank?.baseUrl&&rerank.model&&rerank.apiKey),source:g?resolveModel(g,space,'chat').kind:'global'});
 });
 app.get('/v1/admin/usage',c=>{
  if(c.get('caller')!=='admin')return c.json({error:'forbidden'},403);
  if(!o.usage)return c.json({error:'usage_not_available'},503);
  try{return c.json(o.usage.query(c.req.query()));}catch{return c.json({error:'INVALID_USAGE_QUERY'},400);}
 });
 app.get('/v1/admin/usage/bindings',c=>c.get('caller')==='admin'?c.json({bindings:o.usageBindings?.load()??{}}):c.json({error:'forbidden'},403));
 app.put('/v1/admin/usage/bindings',async c=>{
  if(c.get('caller')!=='admin')return c.json({error:'forbidden'},403);
  if(!o.usageBindings)return c.json({error:'usage_not_available'},503);
  const b=await c.req.json().catch(()=>null),bindings=b?.bindings;
  if(!bindings||typeof bindings!=='object'||Array.isArray(bindings)||Object.keys(bindings).length>50000||Object.entries(bindings).some(([k,v])=>!uuid.test(k)||typeof v!=='string'||!uuid.test(v)))return c.json({error:'invalid_request'},400);
  o.usageBindings.save(bindings);return c.json({ok:true});
 });
 app.post('/v1/calls/:id/cancel',c=>{
  const id=c.req.param('id'),space=(c.req.header('x-space-id')??'').toLowerCase();
  if(!uuid.test(id)||!uuid.test(space))return c.json({error:'invalid_request'},400);
  const key=c.get('caller')+':'+space+':'+id;
  for(const [k,until] of cancelled)if(until<Date.now())cancelled.delete(k);
  if(cancelled.size>=10000&&!cancelled.has(key))return c.json({error:'too_many_requests'},429);
  cancelled.set(key,Date.now()+240000);operations.get(key)?.abort(new DOMException('Cancelled','AbortError'));
  return c.json({ok:true});
 });
 const forward=(path:string,pick:(g:GatewayConfig)=>Upstream|undefined,notConfigured:string)=>app.post('/v1/'+path,async c=>{
  const started=Date.now(),caller=c.get('caller'),space=(c.req.header('x-space-id')??'').toLowerCase();
  let routing:Record<string,string>={};
  const done=(status:number,extra:Record<string,unknown>={})=>log({event:'llm_call',caller,space:uuid.test(space)?space:null,route:path,status,ms:Date.now()-started,...routing,...extra});
  const g=o.config();
  if(!g){done(503);return c.json({error:'llm_not_configured'},503);}
  const capability=path==='embeddings'?'embedding':path==='rerank'?'rerank':'chat';
  if(space&&!uuid.test(space)){done(400);return c.json({error:'invalid_space'},400);}
  if(!space&&g.assignments&&(Object.keys(g.assignments.spaces).length||Object.keys(g.assignments.merchants).length)&&caller!=='admin'){done(400);return c.json({error:'space_context_required'},400);}
  if(space&&g.disabledSpaces?.includes(space)){done(403);return c.json({error:'ai_disabled_for_space'},403);}
  const choice=resolveModel(g,space,capability),pool=choice.pool,index=pool?.roundRobin?(cursors.get(choice.key)??0):0;
  const up=pool?pool.entries[index%Math.max(1,pool.entries.length)]:choice.up;routing={modelScope:choice.kind,modelScopeId:choice.id};
  if(!up?.baseUrl||!up.apiKey||!up.model){done(501);return c.json({error:notConfigured},501);}
  if(space&&!uuid.test(space)){done(400);return c.json({error:'invalid_space'},400);}
  if(space&&g.disabledSpaces?.includes(space.toLowerCase())){done(403);return c.json({error:'ai_disabled_for_space'},403);}
  let body:Record<string,unknown>;
  try{body=await c.req.json();if(!body||typeof body!=='object'||Array.isArray(body))throw Error();}catch{done(400);return c.json({error:'invalid_request'},400);}
  let base:string;try{base=upstreamUrl({baseUrl:up.baseUrl},[...hosts,...(g.extraHosts??[])],o.allowInsecure);}catch{done(503);return c.json({error:'upstream_not_approved'},503);}
  if((active.get(caller)??0)>=limit){done(429);return c.json({error:'too_many_requests'},429);}
  if(pool?.roundRobin)cursors.set(choice.key,index+1);
  const operation=c.req.header('x-operation-id')??'',key=caller+':'+space+':'+operation;
  if(operation&&!uuid.test(operation))return c.json({error:'invalid_operation'},400);
  if(operation&&operations.has(key))return c.json({error:'operation_already_running'},409);
  if(operation&&(cancelled.get(key)??0)>Date.now())return Response.json({error:'call_cancelled'},{status:499});
  const controller=new AbortController(),signal=AbortSignal.any([c.req.raw.signal,controller.signal,AbortSignal.timeout(o.timeoutMs??requestTimeout(caller,c.req.header('x-request-timeout-ms')))]);
  if(operation)operations.set(key,controller);
  const provider:Provider=up.provider??'openai';
  // Qwen's hybrid model defaults to long thinking. This explicit internal purpose
  // selects direct generation without changing the model or other callers.
  const purpose=c.req.header('x-generation-purpose');
  const directGeneration=caller==='saas'&&purpose==='elevate'||caller==='innodata'&&purpose==='knowledge-extract';
  if(capability==='chat'&&directGeneration&&provider==='openai'&&/^qwen3\.8-flash(?:-|$)/.test(up.model)&&/^(dashscope|dashscope-intl)\.aliyuncs\.com$/.test(new URL(base).hostname))body={...body,enable_thinking:false};
  const observed=usageObserver(provider,body.stream===true);
  const record:CallRecord={id:randomUUID(),operation:operation||null,caller,space:space||null,merchant:o.usageBindings?o.usageBindings.load()[space]??null:g.assignments?.bindings?.[space]??null,capability,provider,model:up.model,started:new Date(started).toISOString(),finished:'',status:'running',httpStatus:0,ms:0,usage:emptyUsage(),usageState:'unavailable'};
  try{o.usage?.start(record);}catch{if(operation)operations.delete(key);return c.json({error:'usage_ledger_unavailable'},503);}
  active.set(caller,(active.get(caller)??0)+1);
  let settled=false,streaming=false,cancelBody:(()=>void)|undefined;
  const finish=(status:number,code?:string)=>{
   if(settled)return;settled=true;signal.removeEventListener('abort',abort);
   if(operation)operations.delete(key);active.set(caller,Math.max(0,(active.get(caller)??1)-1));
   observed.end();const usage=observed.usage;
   const state=signal.aborted?(signal.reason?.name==='TimeoutError'?'timed_out':'cancelled'):observed.failed?'failed':body.stream===true&&status===200&&!observed.terminal?'interrupted':status>=200&&status<300?'succeeded':'failed';
   try{o.usage?.finish({...record,finished:new Date().toISOString(),status:state,httpStatus:status,ms:Date.now()-started,usage,usageState:usage.input===null&&usage.output===null?'unavailable':state==='succeeded'&&usage.input!==null&&(capability==='embedding'||usage.output!==null)?'reported':'partial'});}catch{log({event:'llm_usage_write_failed',id:record.id});}
   done(status,{code:code??state});
  };
  const abort=()=>{cancelBody?.();finish(signal.reason?.name==='TimeoutError'?504:499);};
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted){abort();return Response.json({error:'call_cancelled'},{status:499});}
  // Observe the native wire before conversion, but keep the lease until the caller finishes/cancels the output stream.
  const observe=(source:ReadableStream<Uint8Array>)=>source.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,out){observed.push(chunk);out.enqueue(chunk);}}));
  const lease=(source:ReadableStream<Uint8Array>)=>{
   streaming=true;const reader=source.getReader();cancelBody=()=>{void reader.cancel().catch(()=>{});};
   return new ReadableStream<Uint8Array>({async pull(out){try{const r=await reader.read();if(r.done){finish(200);out.close();}else out.enqueue(r.value);}catch(e){finish(502);out.error(e);}},async cancel(){controller.abort(new DOMException('Consumer cancelled','AbortError'));await reader.cancel().catch(()=>{});}});
  };
  try{
   const cap:Capability=path==='embeddings'?'embedding':path==='rerank'?'rerank':'chat';
   if(!supports(provider,cap)){finish(501);return c.json({error:'capability_not_supported_by_provider'},501);}
   const target={apiKey:up.apiKey,model:up.model,dimension:(up as Upstream&{dimension?:number}).dimension};
   if(provider==='chatgpt'&&(base!==PLAN_BASE||!up.apiKey.startsWith('plan:')||!o.plan))throw Error('CHATGPT_LOGIN_REQUIRED');
   const out=provider==='chatgpt'?null:cap==='chat'?buildChat(provider,base,target,body):cap==='embedding'?buildEmbeddings(provider,base,target,body):{url:base+'/rerank',headers:{authorization:'Bearer '+up.apiKey},body:{...body,model:up.model}};
   if(provider==='openai'&&cap==='chat'&&body.stream===true)(out!.body as any).stream_options={...((out!.body as any).stream_options??{}),include_usage:true};
   const r=provider==='chatgpt'?await o.plan!.infer(up.apiKey.slice(5),up.model,body,signal):await f(out!.url,{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json',...out!.headers},body:JSON.stringify(out!.body)});
   if(signal.aborted){await r.body?.cancel();signal.throwIfAborted();}
   if(!r.ok){
    finish(r.status);await r.body?.cancel();
    // Never relay provider error bodies; map provider auth failures to a gateway error so callers do not treat them as their own 401.
    return c.json({error:r.status===401||r.status===403?'upstream_auth_failed':r.status===429?'upstream_rate_limited':'upstream_error',upstreamStatus:r.status},r.status===429?429:502);
   }
   if(cap==='embedding'){
    const bytes=new Uint8Array(await r.arrayBuffer());observed.push(bytes);const j:any=JSON.parse(new TextDecoder().decode(bytes)),first=embeddingLength(provider,j);
    if(typeof first==='number'&&(up as Upstream&{dimension?:number}).dimension&&first!==(up as Upstream&{dimension?:number}).dimension){finish(502,'dimension_mismatch');return c.json({error:'embedding_dimension_mismatch'},502);}
    finish(200);return c.json(provider==='openai'?j:embeddingsJson(j,up.model));
   }
   if(cap==='chat'&&provider!=='openai'&&provider!=='chatgpt'){
    if(body.stream===true&&r.body)return new Response(lease(chatStream(provider,observe(r.body),up.model)),{status:200,headers:{'content-type':'text/event-stream','cache-control':'no-store'}});
    try{const bytes=new Uint8Array(await r.arrayBuffer());observed.push(bytes);const j=chatJson(provider,JSON.parse(new TextDecoder().decode(bytes)),up.model);finish(200);return c.json(j);}
    catch(e){finish(502,e instanceof EmptyCompletion?'empty_completion':'bad_response');return c.json({error:e instanceof EmptyCompletion?'empty_completion':'upstream_error'},502);}
   }
   if(body.stream===true&&r.body)return new Response(lease(observe(r.body)),{status:200,headers:{'content-type':r.headers.get('content-type')??'text/event-stream','cache-control':'no-store'}});
   const bytes=new Uint8Array(await r.arrayBuffer());observed.push(bytes);finish(200);
   return new Response(bytes,{status:200,headers:{'content-type':r.headers.get('content-type')??'application/json','cache-control':'no-store'}});
  }catch{finish(signal.aborted?signal.reason?.name==='TimeoutError'?504:499:502,'unreachable');return Response.json({error:signal.aborted?'call_interrupted':'upstream_unreachable'},{status:signal.aborted?signal.reason?.name==='TimeoutError'?504:499:502});}
  finally{if(!streaming&&!settled)finish(502);}
 });
 if(o.store){registerPlanRoutes(app,o.plan,o.store);registerAdmin(app,{plan:o.plan,store:o.store,baseHosts:hosts,allowInsecure:o.allowInsecure,fetchImpl:f,timeoutMs:o.timeoutMs,usage:o.usage,merchantForSpace:space=>o.usageBindings?o.usageBindings.load()[space]??null:o.config()?.assignments?.bindings?.[space]??null,acquire:()=>{if((active.get('admin')??0)>=limit)return undefined;active.set('admin',(active.get('admin')??0)+1);return ()=>active.set('admin',Math.max(0,(active.get('admin')??1)-1));}});}
 forward('chat/completions',g=>g.chat,'chat_not_configured');
 forward('embeddings',g=>g.embedding,'embedding_not_configured');
 forward('rerank',g=>g.rerank,'rerank_not_configured');
 return app;
}

