import {providerTemplates} from './provider-templates.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {timingSafeEqual} from 'node:crypto';
import {Hono} from 'hono';
import {llmGateway,type GatewayOptions,type GatewayConfig,type Upstream} from './llm-gateway.js';
import {type Capability} from './llm-providers.js';
import {usageObserver} from './llm-usage.js';
import {Governance} from './governance.js';

type Context={key:string;name:string;space:string;up:Upstream;cap:Capability};
export function coworkerGateway(o:GatewayOptions&{masterKey:string;governance:Governance;engine?:{baseURL:string;masterKey:string;fetcher?:typeof fetch}}){
 if(o.masterKey.length<32)throw Error('Master key must contain at least 32 characters');
 const app=new Hono(),context=new AsyncLocalStorage<Context>(),gov=o.governance;
 const same=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
 const isAdmin=(r:Request)=>same(r.headers.get('authorization')||'','Bearer '+o.masterKey);
 const catalog=()=>{const g=o.config();return (['chat','embedding','rerank'] as Capability[]).flatMap(cap=>{const entries=g?.pools?.[cap]?.entries??(g?.[cap]?[{...g[cap],id:g[cap]!.model}]:[]);return entries.filter(e=>e.baseUrl&&e.apiKey&&e.model).map(e=>({id:e.id||e.model!,cap,up:e as Upstream}))})};
 const native=llmGateway({...o,callers:()=>{const c=context.getStore();return {...o.callers(),admin:o.masterKey,...(c?{[c.name]:c.key}:{})}},config:()=>{const g=o.config(),c=context.getStore();if(!g||!c)return g;return {...g,assignments:undefined,pools:undefined,[c.cap]:c.up} as GatewayConfig}});
 app.onError((e,c)=>c.json({error:'gateway_error'},500));
 app.get('/providers/templates',c=>c.json({templates:providerTemplates}));
 app.get('/healthz',c=>c.json({status:'alive',service:'CoworkerLLM'}));
 app.get('/readyz',async c=>{if(!o.engine)return c.json({ready:false},503);try{const r=await (o.engine.fetcher||fetch)(o.engine.baseURL+'/v1/models',{headers:{authorization:'Bearer '+o.engine.masterKey},redirect:'error',signal:AbortSignal.timeout(10000)});const d=await r.json() as any;const ready=r.ok&&Array.isArray(d.data)&&d.data.length>0;return c.json({ready},ready?200:503)}catch{return c.json({ready:false},503)}});
 app.post('/key/generate',async c=>{if(!isAdmin(c.req.raw))return c.json({error:'unauthorized'},401);try{if(Number(c.req.header('content-length')||0)>16384)return c.json({error:'payload_too_large'},413);const input=await c.req.text();if(input.length>16384)return c.json({error:'payload_too_large'},413);const policy=JSON.parse(input);if(!o.engine)return c.json({error:'engine_not_configured'},503);const {keyInput}=await import('./governance.js');const checked=keyInput.parse(policy);const response=await (o.engine.fetcher||fetch)(o.engine.baseURL+'/key/generate',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+o.engine.masterKey,'content-type':'application/json'},body:JSON.stringify({key_alias:checked.key_alias,max_budget:checked.max_budget,models:checked.models,duration:checked.duration,rpm_limit:checked.rpm_limit,tpm_limit:checked.tpm_limit,metadata:checked.metadata})});if(!response.ok)return c.json({error:'engine_key_provisioning_failed'},503);const generated=await response.json() as any;if(typeof generated.key!=='string')return c.json({error:'engine_key_provisioning_failed'},503);return c.json(gov.create(checked,generated.key),201)}catch{return c.json({error:'invalid_key_policy'},400)}});
 app.get('/key/list',c=>isAdmin(c.req.raw)?c.json({keys:gov.list().map(k=>({...k,usage:gov.usage(k.id)}))}):c.json({error:'unauthorized'},401));
 app.post('/key/delete',async c=>{if(!isAdmin(c.req.raw))return c.json({error:'unauthorized'},401);let id;try{id=(await c.req.json()).id}catch{return c.json({error:'invalid_request'},400)}return c.json({revoked:typeof id==='string'&&gov.revoke(id)})});
 app.get('/v1/models',async c=>{const token=(c.req.header('authorization')||'').replace(/^Bearer /,''),key=gov.lookup(token);if(!key&&!isAdmin(c.req.raw))return c.json({error:'unauthorized'},401);if(!o.engine)return c.json({error:'engine_not_configured'},503);try{const r=await (o.engine.fetcher||fetch)(o.engine.baseURL+'/v1/models',{headers:{authorization:'Bearer '+(key?token:o.engine.masterKey)},signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)return c.json({error:'engine_unavailable'},503);const data=await r.json() as any;return c.json({object:'list',data:(data.data||[]).filter((m:any)=>!key||key.models.includes(m.id))})}catch{return c.json({error:'engine_unavailable'},503)}});
 app.all('/engine/*',async c=>{if(!isAdmin(c.req.raw))return c.json({error:'unauthorized'},401);if(!o.engine)return c.json({error:'engine_not_configured'},503);const path=new URL(c.req.url).pathname.slice('/engine'.length),headers=new Headers({'authorization':'Bearer '+o.engine.masterKey,'content-type':'application/json'});try{const r=await (o.engine.fetcher||fetch)(o.engine.baseURL+path+new URL(c.req.url).search,{method:c.req.method,headers,body:['GET','HEAD'].includes(c.req.method)?undefined:await c.req.text(),signal:AbortSignal.timeout(30000),redirect:'error'});return new Response(r.body,{status:r.status,headers:{'content-type':r.headers.get('content-type')||'application/json','cache-control':'no-store'}})}catch{return c.json({error:'engine_unavailable'},503)}});
 app.all('*',async c=>{
  const path=new URL(c.req.url).pathname;
  if(!['/v1/chat/completions','/v1/embeddings','/v1/rerank','/v1/responses','/v1/completions'].includes(path))return native.fetch(c.req.raw);
  if(c.req.method!=='POST')return c.json({error:'method_not_allowed'},405);
  const token=(c.req.header('authorization')||'').replace(/^Bearer /,''),key=gov.lookup(token);
  // Existing SaaS caller credentials retain the original scoped protocol for migration.
  if(!key){if(Object.values(o.callers()).some(k=>same(k,token))||isAdmin(c.req.raw))return native.fetch(c.req.raw);return c.json({error:'unauthorized'},401)}
  const cap:Capability=path.endsWith('/embeddings')?'embedding':path.endsWith('/rerank')?'rerank':'chat';
  const responses=path==='/v1/responses',completions=path==='/v1/completions';
  let body:any,bytes=0;const parts:Uint8Array[]=[];try{const reader=c.req.raw.body?.getReader();if(!reader)throw Error();for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>8*1024*1024){await reader.cancel();return c.json({error:'payload_too_large'},413)}parts.push(r.value)}body=JSON.parse(Buffer.concat(parts).toString());if(!body||typeof body!=='object'||Array.isArray(body))throw Error()}catch{return c.json({error:'invalid_request'},400)}
  if(!o.engine)return c.json({error:'engine_not_configured'},503);
  const maximum=cap==='chat'?Number(body.max_output_tokens??body.max_tokens??body.max_completion_tokens??4096):0;if(!Number.isSafeInteger(maximum)||maximum<0||maximum>64000)return c.json({error:'invalid_output_limit'},400);if(cap==='chat'){if(responses)body.max_output_tokens=maximum;else body.max_tokens=maximum;delete body.max_completion_tokens}if(body.n!==undefined&&body.n!==1)return c.json({error:'one_completion_per_budgeted_request'},400)
  // UTF-8 bytes are a conservative upper bound for supported text tokenizers.
  // Multimodal requests need provider-specific accounting and are refused on token keys.
  if(responses&&typeof body.input!=='string')return c.json({error:'text_input_required_for_budgeted_key'},400);if(completions&&typeof body.prompt!=='string')return c.json({error:'text_prompt_required_for_budgeted_key'},400);
  if(cap==='chat'&&!responses&&!completions&&(!Array.isArray(body.messages)||body.messages.some((m:any)=>typeof m.content!=='string')))return c.json({error:'text_messages_required_for_budgeted_key'},400);
  const reservation=Buffer.byteLength(JSON.stringify(body))+maximum+2048;
  let lease;try{lease=gov.reserve(key,body.model,reservation)}catch(e){return c.json({error:(e as Error).message},(e as any).status||429)}
  const observed=usageObserver('openai',body.stream===true);let settled=false;
  const finish=()=>{if(settled)return;settled=true;observed.end();const u=observed.usage;gov.settle(lease,u.input!==null&&(cap==='embedding'||u.output!==null)?u.input+(u.output??0):undefined)};
  const headers=new Headers(c.req.raw.headers);headers.set('x-space-id',key.metadata.tenant);headers.delete('content-length');
  try{
   headers.set('authorization','Bearer '+token);headers.delete('x-space-id');headers.delete('x-operation-id');
   const response=await (o.engine.fetcher||fetch)(o.engine.baseURL+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(o.timeoutMs||120000)]),redirect:'error'});
   if(!response.body){finish();return response}
   const reader=response.body.getReader();let total=0;const stream=new ReadableStream<Uint8Array>({async pull(out){try{const r=await reader.read();if(r.done){finish();out.close()}else{total+=r.value.length;if(total>16*1024*1024){await reader.cancel();throw Error('response_too_large')}observed.push(r.value);out.enqueue(r.value)}}catch(e){finish();out.error(e)}},async cancel(reason){try{await reader.cancel(reason)}finally{finish()}}});
   return new Response(stream,{status:response.status,headers:response.headers});
  }catch{finish();return c.json({error:'upstream_unavailable'},502)}
 });
 return app;
}
