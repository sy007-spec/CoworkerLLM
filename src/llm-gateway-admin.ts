import {UsageLedger,emptyUsage,readUsage,type CallRecord} from './llm-usage.js';
import {ChatgptPlan,PLAN_BASE} from './chatgpt-plan.js';
import {randomUUID} from 'node:crypto';
import {globalEntries,validAssignments,resolveModel} from './model-routing.js';
// Administration of the LLM gateway: masked read, partial update (keys are write-only) and a real connectivity test per capability.
// Only the 'admin' caller key reaches these routes; the platform admin page in the directory service proxies to them.
import type {Hono} from 'hono';
import {z} from 'zod';
import {upstreamUrl} from './llm-gateway.js';
import {PROVIDERS,DEFAULT_BASE,normalizeBase,supports,buildChat,buildEmbeddings,embeddingLength,type Provider} from './llm-providers.js';

export type RawUpstream={id?:string;provider?:Provider;baseUrl?:string;apiKey?:string;model?:string;dimension?:number};
export type ScopeConfig={use?:Partial<Record<Capability,string>>;pools?:Partial<Record<Capability,{roundRobin:boolean;entries:RawUpstream[]}>>;chat?:RawUpstream;embedding?:RawUpstream;rerank?:RawUpstream;};
export type RawConfig=ScopeConfig&{extraHosts?:string[];disabledSpaces?:string[];drafts?:Record<string,ScopeConfig>;previous?:Record<string,ScopeConfig>;assignments?:{spaces:Record<string,ScopeConfig>;merchants:Record<string,ScopeConfig>;bindings:Record<string,string>}};
export type ConfigStore={load:()=>RawConfig;save:(c:RawConfig)=>void};
export const CAPABILITIES=['chat','embedding','rerank'] as const;
type Capability=typeof CAPABILITIES[number];

// A provider host must be a real DNS name: no IP literals, no single-label internal names.
export const validHost=(h:string)=>/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(h);
const upstream=z.object({id:z.string().min(1).max(80).optional(),provider:z.enum(PROVIDERS as [Provider,...Provider[]]).optional(),baseUrl:z.string().trim().max(300),model:z.string().trim().max(120),apiKey:z.string().trim().max(600).optional(),dimension:z.number().int().min(1).max(8192).optional()}).strict();
const pool=z.object({roundRobin:z.boolean(),entries:z.array(upstream).max(20)}).strict();
const update=z.object({use:z.object({chat:z.string().max(80).optional(),embedding:z.string().max(80).optional(),rerank:z.string().max(80).optional()}).strict().optional(),pools:z.object({chat:pool.optional(),embedding:pool.optional(),rerank:pool.optional()}).strict().optional(),chat:upstream.optional(),embedding:upstream.optional(),rerank:upstream.optional(),clear:z.array(z.enum(CAPABILITIES)).max(3).optional(),extraHosts:z.array(z.string().trim().toLowerCase().max(253)).max(20).optional(),disabledSpaces:z.array(z.guid()).max(500).optional()}).strict();

export function masked(raw:RawConfig,baseHosts:string[],includeAssignments=true):Record<string,any>{
 const one=(u?:RawUpstream)=>({provider:u?.provider??'openai',baseUrl:u?.baseUrl??'',model:u?.model??'',hasKey:!!u?.apiKey,dimension:u?.dimension??null});
 return {overrides:CAPABILITIES.filter(cap=>raw.use?.[cap]||raw.pools?.[cap]||raw[cap]),use:raw.use??{},...(includeAssignments?{assignments:{spaces:Object.fromEntries(Object.entries(raw.assignments?.spaces??{}).map(([id,c])=>[id,masked(c,baseHosts,false)])),merchants:Object.fromEntries(Object.entries(raw.assignments?.merchants??{}).map(([id,c])=>[id,masked(c,baseHosts,false)])),bindings:raw.assignments?.bindings??{}}}:{}),pools:Object.fromEntries(CAPABILITIES.map(cap=>[cap,{roundRobin:raw.pools?.[cap]?.roundRobin??false,entries:(raw.pools?.[cap]?.entries??(raw[cap]?[{...raw[cap],id:'legacy'}]:[])).map(u=>({...one(u),id:u.id??'legacy'}))}])),chat:one(raw.chat),embedding:one(raw.embedding),rerank:one(raw.rerank),extraHosts:raw.extraHosts??[],allowedHosts:baseHosts,providers:PROVIDERS,defaultBase:DEFAULT_BASE,disabledSpaces:raw.disabledSpaces??[],
  ...(includeAssignments?{drafts:Object.fromEntries(Object.entries(raw.drafts??{}).map(([key,c])=>[key,masked(c,baseHosts,false)])),hasPrevious:Object.fromEntries(Object.keys(raw.previous??{}).map(key=>[key,true]))}:{})};
}

export function registerAdmin(app:Hono<any>,o:{plan?:ChatgptPlan;store:ConfigStore;baseHosts:string[];allowInsecure?:boolean;fetchImpl:typeof fetch;timeoutMs?:number;usage?:UsageLedger;merchantForSpace?:(space:string)=>string|null;acquire?:()=>undefined|(()=>void)}){
 const guard=async(c:any,next:()=>Promise<void>)=>c.get('caller')==='admin'?next():c.json({error:'forbidden'},403);
 const hostsOf=(raw:RawConfig)=>[...o.baseHosts,...(raw.extraHosts??[])];
 app.get('/v1/admin/config',guard,c=>c.json(masked(o.store.load(),o.baseHosts)));
 const pickScope=(s:ScopeConfig):ScopeConfig=>JSON.parse(JSON.stringify({use:s.use,pools:s.pools,chat:s.chat,embedding:s.embedding,rerank:s.rerank}));
 const entriesOf=(s:ScopeConfig,cap:Capability):RawUpstream[]=>s.pools?.[cap]?.entries??(s[cap]?[{...s[cap]!,id:'legacy'}]:[]);
 const scopeInput=z.object({scope:z.object({kind:z.enum(['spaces','merchants']),id:z.uuid()}).strict().optional()}).strict();
 const scopeKey=(s?:{kind:string;id:string})=>s?s.kind+':'+s.id.toLowerCase():'global';
 const putConfig=async(c:any)=>{
  let body:z.infer<typeof update>;try{body=update.parse(await c.req.json());}catch{return c.json({error:'invalid_request'},400);}
  const root=structuredClone(o.store.load()),kind=c.req.param('kind'),id=String(c.req.param('id')??'').toLowerCase();
  for(const cap of CAPABILITIES)for(const u of [body[cap],...(body.pools?.[cap]?.entries??[])])if(u?.provider==='chatgpt'&&(cap!=='chat'||u.apiKey||normalizeBase(u.baseUrl)!==PLAN_BASE))return c.json({error:'CHATGPT_USE_AUTHORIZATION'},400);
  const scoped=!!kind;if(scoped&&(!['spaces','merchants'].includes(kind)||!z.uuid().safeParse(id).success))return c.json({error:'invalid_request'},400);
  if(scoped&&(body.extraHosts||body.disabledSpaces)||!scoped&&body.use)return c.json({error:'invalid_request'},400);
  // A draft never touches the active connection: it starts from the saved draft (or a copy of the active configuration) and is stored apart.
  const draftMode=c.req.query('draft')==='1',key=scoped?kind+':'+id:'global';
  if(draftMode&&(body.extraHosts||body.disabledSpaces))return c.json({error:'invalid_request'},400);
  const active:ScopeConfig=scoped?root.assignments?.[kind as 'spaces'|'merchants']?.[id]??{}:root;
  const next:RawConfig=draftMode?structuredClone(root.drafts?.[key]??pickScope(active)):scoped?structuredClone(active):root;
  const hostRoot=scoped||draftMode?root:next;
  if(body.extraHosts){
   if(!body.extraHosts.every(validHost))return c.json({error:'invalid_host'},400);
   next.extraHosts=[...new Set(body.extraHosts)];
  }
  if(body.disabledSpaces)next.disabledSpaces=[...new Set(body.disabledSpaces.map(x=>x.toLowerCase()))];
  for(const cap of body.clear??[]){if(next.use)delete next.use[cap];delete next[cap];if(next.pools)delete next.pools[cap];}
  // Keys are write-only: an empty or missing key keeps the stored one. A stored key only stays with its own provider (and, in a scope, its own
  // address); when an edit would leave it behind, the save is refused instead of silently storing an empty key.
  const keyFor=(u:RawUpstream,old:RawUpstream|undefined,provider:Provider,baseUrl:string)=>u.apiKey||((old?.provider??'openai')===provider&&(!scoped||old?.baseUrl===baseUrl)?old?.apiKey:undefined)||(old?.apiKey?null:'');
  for(const cap of CAPABILITIES){
   const u=body[cap];if(!u)continue;
   const prev=next[cap]??{};if(next.use)delete next.use[cap];
   if(next.pools)delete next.pools[cap];
   const provider=u.provider??prev.provider??'openai';
   if(provider==='chatgpt'&&(u.apiKey||normalizeBase(u.baseUrl)!==PLAN_BASE))return c.json({error:'CHATGPT_USE_AUTHORIZATION'},400);
   if(!supports(provider,cap))return c.json({error:'capability_not_supported_by_provider',capability:cap},400);
   const baseUrl=normalizeBase(u.baseUrl,provider)||DEFAULT_BASE[provider],apiKey=keyFor(u,prev,provider,baseUrl);
   if(apiKey===null)return c.json({error:'api_key_required',capability:cap},400);
   next[cap]={provider,baseUrl,model:u.model,apiKey,...(cap==='embedding'?{dimension:u.dimension??prev.dimension}:{})};
  }
  for(const cap of CAPABILITIES){
   const incoming=body.pools?.[cap];if(!incoming)continue;if(next.use)delete next.use[cap];
   const previous=next.pools?.[cap]?.entries??(next[cap]?[{...next[cap],id:'legacy'}]:[]);
   const ids=incoming.entries.map(u=>u.id);
   if(ids.some(id=>!id)||new Set(ids).size!==ids.length)return c.json({error:'invalid_request'},400);
   const entries:RawUpstream[]=[];
   for(const u of incoming.entries){
    const old=previous.find(x=>x.id===u.id),provider=u.provider??old?.provider??'openai';
    if(provider==='chatgpt'&&(u.apiKey||normalizeBase(u.baseUrl)!==PLAN_BASE))return c.json({error:'CHATGPT_USE_AUTHORIZATION'},400);
    if(!supports(provider,cap))return c.json({error:'capability_not_supported_by_provider',capability:cap},400);
    const baseUrl=normalizeBase(u.baseUrl,provider)||DEFAULT_BASE[provider],apiKey=keyFor(u,old,provider,baseUrl);
    if(apiKey===null)return c.json({error:'api_key_required',capability:cap},400);
    const entry={...u,provider,baseUrl,apiKey};
    try{upstreamUrl(entry,hostsOf(hostRoot),o.allowInsecure);}catch{return c.json({error:'upstream_not_approved',capability:cap},400);}
    entries.push(entry);
   }
   if(cap==='embedding'&&incoming.roundRobin&&entries.length>1&&(!entries[0]?.dimension||entries.some(u=>u.model!==entries[0]?.model||u.provider!==entries[0]?.provider||u.dimension!==entries[0]?.dimension)))return c.json({error:'embedding_pool_incompatible'},400);
   next.pools??={};next.pools[cap]={roundRobin:incoming.roundRobin,entries};
   if(entries[0])next[cap]=entries[0];else delete next[cap];
  }
  for(const cap of CAPABILITIES){
   const u=next[cap];if(!u?.baseUrl)continue;
   try{upstreamUrl({baseUrl:u.baseUrl},hostsOf(hostRoot),o.allowInsecure);}catch{return c.json({error:'upstream_not_approved',capability:cap},400);}
  }
  if(scoped){
   for(const cap of CAPABILITIES){const ref=body.use?.[cap];if(!ref)continue;if(!globalEntries(root,cap).some(u=>u.id===ref))return c.json({error:'invalid_model_reference'},400);next.use??={};next.use[cap]=ref;delete next[cap];if(next.pools)delete next.pools[cap];}
   if(!draftMode){root.assignments??={spaces:{},merchants:{},bindings:{}};root.assignments[kind as 'spaces'|'merchants'][id]=next;}
  }
  if(draftMode){root.drafts??={};root.drafts[key]=next;o.store.save(root);return c.json(masked(next,o.baseHosts,false));}
  const value=scoped?root:next,error=validAssignments(value);if(error)return c.json({error},400);
  for(const profile of [value,...Object.values(value.assignments?.spaces??{}),...Object.values(value.assignments?.merchants??{})])for(const cap of CAPABILITIES)for(const entry of profile.pools?.[cap]?.entries??(profile[cap]?[profile[cap]!]:[])){if(!entry.baseUrl)continue;try{upstreamUrl({baseUrl:entry.baseUrl},hostsOf(value),o.allowInsecure);}catch{return c.json({error:'upstream_not_approved',capability:cap},400);}}
  o.store.save(value);return c.json(masked(next,o.baseHosts));
 };
 app.put('/v1/admin/config',guard,putConfig);
 app.put('/v1/admin/scopes/:kind/:id',guard,putConfig);
 app.delete('/v1/admin/scopes/:kind/:id',guard,c=>{const kind=c.req.param('kind'),id=c.req.param('id').toLowerCase();if(!['spaces','merchants'].includes(kind)||!z.uuid().safeParse(id).success)return c.json({error:'invalid_request'},400);const raw=structuredClone(o.store.load());if(raw.assignments)delete raw.assignments[kind as 'spaces'|'merchants'][id];o.store.save(raw);return c.json({ok:true});});
 app.put('/v1/admin/bindings/:id',guard,async c=>{const id=c.req.param('id').toLowerCase(),b=z.object({merchantId:z.uuid().nullable()}).strict().safeParse(await c.req.json());if(!z.uuid().safeParse(id).success||!b.success)return c.json({error:'invalid_request'},400);const raw=structuredClone(o.store.load());raw.assignments??={spaces:{},merchants:{},bindings:{}};if(b.data.merchantId)raw.assignments.bindings[id]=b.data.merchantId.toLowerCase();else delete raw.assignments.bindings[id];const error=validAssignments(raw);if(error)return c.json({error},400);o.store.save(raw);return c.json({ok:true});});
 // Minimal real call per capability; the response never contains provider output or keys.
 type Probe={status:number;body:any};
 const reply=(body:any,status=200):Probe=>({status,body});
 async function probe(u:RawUpstream|undefined,cap:Capability,scope:{kind:'spaces'|'merchants';id:string}|undefined,root:RawConfig,external?:AbortSignal):Promise<Probe>{
  if(!u?.baseUrl||!u.model||!u.apiKey)return reply({ok:false,category:'not_configured'});
  let base:string;try{base=upstreamUrl({baseUrl:u.baseUrl},hostsOf(root),o.allowInsecure);}catch{return reply({ok:false,category:'host_not_allowed'});}
  const provider:Provider=u.provider??'openai';
  if(provider==='chatgpt'&&(u.baseUrl!==PLAN_BASE||!u.apiKey.startsWith('plan:')||!o.plan))return reply({ok:false,category:'auth'});
  if(!supports(provider,cap))return reply({ok:false,category:'not_supported'});
  const payload:any=cap==='chat'?{messages:[{role:'user',content:'ping'}],max_tokens:8}:cap==='embedding'?{input:'测试'}:{query:'测试',documents:['测试','示例'],top_n:1};
  const release=o.acquire?.();if(o.acquire&&!release)return reply({ok:false,category:'rate_limited'},429);
  const started=Date.now(),signal=AbortSignal.any([...(external?[external]:[]),AbortSignal.timeout(o.timeoutMs??30000)]);
  let outcome='failed',httpStatus=502,usage=emptyUsage();
  const record:CallRecord={id:randomUUID(),operation:null,caller:'admin',space:scope?.id??null,merchant:scope?o.merchantForSpace?.(scope.id)??null:null,capability:cap,provider,model:u.model,started:new Date(started).toISOString(),finished:'',status:'running',httpStatus:0,ms:0,usage,usageState:'unavailable'};
  try{o.usage?.start(record);}catch{release?.();return reply({ok:false,category:'usage_ledger_unavailable'});}
  try{
   const target={apiKey:u.apiKey,model:u.model,dimension:u.dimension};
   const out=provider==='chatgpt'?null:cap==='chat'?buildChat(provider,base,target,payload):cap==='embedding'?buildEmbeddings(provider,base,target,payload):{url:base+'/rerank',headers:{authorization:'Bearer '+u.apiKey},body:{...payload,model:u.model}};
   const r=provider==='chatgpt'?await o.plan!.infer(u.apiKey.slice(5),u.model,payload,signal):await o.fetchImpl(out!.url,{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json',...out!.headers},body:JSON.stringify(out!.body)});
   httpStatus=r.status;
   const answer:any=await r.json().catch(()=>null);usage=readUsage(provider,answer);
   const latencyMs=Date.now()-started;
   if(r.status===401||r.status===403||provider==='gemini'&&r.status===400)return reply({ok:false,category:'auth',latencyMs});
   if(r.status===404)return reply({ok:false,category:'model_not_found',latencyMs});
   if(r.status===429)return reply({ok:false,category:'rate_limited',latencyMs});
   if(!r.ok)return reply({ok:false,category:'unknown',latencyMs});
   if(cap==='embedding'){
    const got=embeddingLength(provider,answer);
    if(!got)return reply({ok:false,category:'unknown',latencyMs});
    if(u.dimension&&got!==u.dimension)return reply({ok:false,category:'dimension_mismatch',latencyMs,dimension:got});
    outcome='succeeded';return reply({ok:true,latencyMs,dimension:got});
   }
   outcome='succeeded';return reply({ok:true,latencyMs});
  }catch{return reply({ok:false,category:'network',latencyMs:Date.now()-started});}
  finally{release?.();o.usage?.finish({...record,finished:new Date().toISOString(),status:signal.aborted?(signal.reason?.name==='TimeoutError'?'timed_out':'cancelled'):outcome,httpStatus,ms:Date.now()-started,usage,usageState:usage.input===null&&usage.output===null?'unavailable':outcome==='succeeded'&&usage.input!==null&&(cap==='embedding'||usage.output!==null)?'reported':'partial'});}
 }
 app.post('/v1/admin/test',guard,async c=>{
  // The form's current (unsaved) values are tested; a blank key falls back to the stored one only for the same vendor protocol. With `fromDraft` the stored one is the draft's.
  let cap:Capability,draft:z.infer<typeof upstream>|undefined,scope:{kind:'spaces'|'merchants';id:string}|undefined,fromDraft=false;
  try{const b=z.object({capability:z.enum(CAPABILITIES),config:upstream.optional(),fromDraft:z.boolean().optional(),scope:z.object({kind:z.enum(['spaces','merchants']),id:z.uuid()}).strict().optional()}).strict().parse(await c.req.json());cap=b.capability;draft=b.config;scope=b.scope;fromDraft=!!b.fromDraft;}catch{return c.json({error:'invalid_request'},400);}
  const root=o.store.load(),raw:RawConfig=(fromDraft?root.drafts?.[scopeKey(scope)]:undefined)??(scope?root.assignments?.[scope.kind]?.[scope.id]??{}:root);
  const resolved=resolveModel(scope?.kind==='merchants'?{...root,assignments:{spaces:{},merchants:root.assignments?.merchants??{},bindings:{}}}:root,scope?.id??'',cap);
  const stored=draft?.id?raw.pools?.[cap]?.entries.find(u=>u.id===draft.id)??(draft.id==='legacy'&&!raw.pools?.[cap]?raw[cap]:undefined):draft&&scope?raw[cap]:resolved.pool?resolved.pool.entries[0]:resolved.up;
  const u:RawUpstream|undefined=draft?(()=>{
   const provider=draft.provider??stored?.provider??'openai';
   const keep=(stored?.provider??'openai')===provider&&(!scope||stored?.baseUrl===(normalizeBase(draft.baseUrl,provider)||DEFAULT_BASE[provider]))?stored?.apiKey:undefined;
   return {provider,baseUrl:normalizeBase(draft.baseUrl,provider)||DEFAULT_BASE[provider],model:draft.model,apiKey:draft.apiKey||keep||'',dimension:draft.dimension??stored?.dimension};
  })():stored;
  const r=await probe(u,cap,scope,root,c.req.raw.signal);return c.json(r.body,r.status as 200);
 });

 // Activation: the server itself tests every connection that differs from the active one; only when all pass is the draft swapped in.
 // The replaced configuration is kept as `previous` so a rollback is one call, and rolling back can itself be rolled back.
 const applyScope=(root:RawConfig,scope:{kind:'spaces'|'merchants';id:string}|undefined,value:ScopeConfig)=>{
  if(scope){root.assignments??={spaces:{},merchants:{},bindings:{}};root.assignments[scope.kind][scope.id]=value;return;}
  for(const k of ['use','pools','chat','embedding','rerank'] as const)delete root[k];
  Object.assign(root,value);
 };
 const hostsOk=(root:RawConfig,value:ScopeConfig)=>CAPABILITIES.every(cap=>entriesOf(value,cap).every(e=>{if(!e.baseUrl)return true;try{upstreamUrl({baseUrl:e.baseUrl},hostsOf(root),o.allowInsecure);return true;}catch{return false;}}));
 const parseScope=async(c:any)=>{try{const b=scopeInput.parse(await c.req.json().catch(()=>({})));return b.scope?{kind:b.scope.kind,id:b.scope.id.toLowerCase()}:undefined;}catch{return null;}};
 app.post('/v1/admin/activate',guard,async c=>{
  const scope=await parseScope(c);if(scope===null)return c.json({error:'invalid_request'},400);
  const root=structuredClone(o.store.load()),key=scopeKey(scope),draft=root.drafts?.[key];
  if(!draft)return c.json({error:'no_draft'},404);
  const active:ScopeConfig=scope?root.assignments?.[scope.kind]?.[scope.id]??{}:root;
  for(const cap of CAPABILITIES)for(const entry of entriesOf(draft,cap)){
   if(!entry.baseUrl||!entry.model||!entry.apiKey)return c.json({error:'draft_incomplete',capability:cap,entryId:entry.id},400);
   const old=entriesOf(active,cap).find(x=>x.id===entry.id);
   if(old&&(['provider','baseUrl','model','apiKey','dimension'] as const).every(k=>(old as any)[k]===(entry as any)[k]))continue;
   const r=await probe(entry,cap,scope,root,c.req.raw.signal);
   if(!r.body.ok)return c.json({error:'draft_test_failed',capability:cap,entryId:entry.id,category:r.body.category},400);
  }
  const applied=pickScope(draft);
  if(!hostsOk(root,applied))return c.json({error:'upstream_not_approved'},400);
  root.previous??={};root.previous[key]=pickScope(active);
  applyScope(root,scope,applied);
  const error=validAssignments(root);if(error)return c.json({error},400);
  delete root.drafts![key];o.store.save(root);
  return c.json({ok:true,config:masked(root,o.baseHosts)});
 });
 app.post('/v1/admin/discard',guard,async c=>{
  const scope=await parseScope(c);if(scope===null)return c.json({error:'invalid_request'},400);
  const root=structuredClone(o.store.load()),key=scopeKey(scope);
  if(!root.drafts?.[key])return c.json({error:'no_draft'},404);
  delete root.drafts[key];o.store.save(root);return c.json({ok:true});
 });
 app.post('/v1/admin/rollback',guard,async c=>{
  const scope=await parseScope(c);if(scope===null)return c.json({error:'invalid_request'},400);
  const root=structuredClone(o.store.load()),key=scopeKey(scope),prev=root.previous?.[key];
  if(!prev)return c.json({error:'no_previous'},404);
  const active:ScopeConfig=scope?root.assignments?.[scope.kind]?.[scope.id]??{}:root;
  if(!hostsOk(root,prev))return c.json({error:'upstream_not_approved'},400);
  root.previous![key]=pickScope(active);applyScope(root,scope,pickScope(prev));
  const error=validAssignments(root);if(error)return c.json({error},400);
  o.store.save(root);return c.json({ok:true,config:masked(root,o.baseHosts)});
 });
}
