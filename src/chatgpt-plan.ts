import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {createRemoteJWKSet,jwtVerify,type JWTPayload,type JWTVerifyGetKey} from 'jose';
import {z} from 'zod';

export const PLAN_BASE='https://api.openai.com/v1';
const ISSUER='https://auth.openai.com';
const SCOPES='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export type PlanScope={kind:'global'|'spaces'|'merchants';id:string};
export const scopeKey=(s:PlanScope)=>s.kind+':'+s.id;
export type PlanCredential={id:string;scope:string;clientId:string;subject:string;email:string;access:string;refresh:string;expires:number;scopes:string[]};
export type PlanStore={load:()=>Record<string,PlanCredential>;save:(v:Record<string,PlanCredential>)=>void};
export type PlanSettings={clientId:string;redirectUri:string;clientSecret?:string;authMethod?:'none'|'client_secret_post'|'client_secret_basic'};
export const planSettingsSchema=z.object({clientId:z.string().regex(/^oaiapp_[\w-]+$/).max(200),redirectUri:z.string().max(2048).refine(v=>{try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/auth/chatgpt/callback';}catch{return false;}}),authMethod:z.enum(['none','client_secret_post','client_secret_basic']),clientSecret:z.string().max(4096).optional()}).strict();
export function savePlanSettings(file:string,s:PlanSettings){const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(s)+'\n',{mode:0o600});chmodSync(tmp,0o600);renameSync(tmp,file);}
export class PlanError extends Error{constructor(public code:string,public status=400){super(code);}}
export async function verifyPlanIdentity(token:string,audience:string,nonce:string,key:JWTVerifyGetKey){
 const {payload}=await jwtVerify(token,key,{issuer:ISSUER,audience,algorithms:['RS256'],requiredClaims:['sub','exp','iat','nonce']});
 if(!payload.sub||payload.nonce!==nonce)throw new PlanError('CHATGPT_INVALID_IDENTITY');return payload;
}
export function planFileStore(file:string):PlanStore{
 return {load(){try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {};throw e;}},save(value){const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600});chmodSync(tmp,0o600);renameSync(tmp,file);}};
}
export function planSettings(file:string):PlanSettings|undefined{
 try{const s=JSON.parse(readFileSync(file,'utf8'));const u=new URL(s.redirectUri);if(!/^oaiapp_[\w-]+$/.test(s.clientId)||u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/auth/chatgpt/callback')return;
 const method=s.authMethod??'none';if(!['none','client_secret_post','client_secret_basic'].includes(method)||method!=='none'&&!s.clientSecret)return;return {...s,authMethod:method};}catch{return;}
}
type Pending={actor:string;scope:string;verifier:string;nonce:string;expires:number;settings:PlanSettings;epoch:number};
export class ChatgptPlan{
 private pending=new Map<string,Pending>();
 private refreshing=new Map<string,Promise<PlanCredential>>();
 private blocked=new Set<string>();
 private epochs=new Map<string,number>();
 private active=new Map<string,Set<AbortController>>();
 private discovery?:Promise<any>;
 private f:typeof fetch;
 constructor(private o:{store:PlanStore;settings:()=>PlanSettings|undefined;saveSettings?:(s:PlanSettings)=>void;fetchImpl?:typeof fetch;verify?:(token:string,audience:string,nonce:string)=>Promise<JWTPayload>}){this.f=o.fetchImpl??fetch;}
 configuration(){const s=this.o.settings();return {clientId:s?.clientId??'',redirectUri:s?.redirectUri??'',authMethod:s?.authMethod??'none',hasSecret:!!s?.clientSecret};}
 configure(input:unknown){
  const parsed=planSettingsSchema.safeParse(input);if(!parsed.success)throw new PlanError('CHATGPT_INVALID_CONFIG');
  const s=parsed.data,old=this.o.settings();
  if(s.authMethod==='none')delete s.clientSecret;
  else {s.clientSecret=s.clientSecret||(old?.clientId===s.clientId&&old.authMethod===s.authMethod?old.clientSecret:undefined);if(!s.clientSecret)throw new PlanError('CHATGPT_SECRET_REQUIRED');}
  if(!this.o.saveSettings)throw new PlanError('CHATGPT_APP_NOT_CONFIGURED',503);
  this.o.saveSettings(s);this.pending.clear();for(const key of this.epochs.keys())this.epochs.set(key,this.epochs.get(key)!+1);
  return this.configuration();
 }
 private async metadata(){
  this.discovery??=(async()=>{const r=await this.f(ISSUER+'/.well-known/openid-configuration',{redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw new PlanError('CHATGPT_UNAVAILABLE',503);const d=await r.json() as any;
   if(d.issuer!==ISSUER)throw new PlanError('CHATGPT_UNAVAILABLE',503);
   for(const k of ['authorization_endpoint','token_endpoint','jwks_uri','revocation_endpoint']){const u=new URL(d[k]);if(u.origin!==ISSUER||u.username||u.password)throw new PlanError('CHATGPT_UNAVAILABLE',503);}return d;
  })().catch(e=>{this.discovery=undefined;throw e;});return this.discovery;
 }
 status(scope:PlanScope){const s=this.o.settings(),record=Object.values(this.o.store.load()).find(x=>x.scope===scopeKey(scope));return {available:!!s,hasAccount:!!record,connected:!!record&&this.connected(record.id),email:record?.email??null,expiresAt:record?new Date(record.expires).toISOString():null};}
 connected(id:string){const r=this.o.store.load()[id],settings=this.o.settings();return !!r&&!!settings&&r.clientId===settings.clientId&&!this.blocked.has(id);}
 async start(actor:string,scope:PlanScope){
  const settings=this.o.settings();if(!settings)throw new PlanError('CHATGPT_APP_NOT_CONFIGURED',503);
  const metadata=await this.metadata();for(const [k,v] of this.pending)if(v.expires<Date.now()||v.actor===actor&&v.scope===scopeKey(scope))this.pending.delete(k);
  if(this.pending.size>=100)throw new PlanError('CHATGPT_BUSY',429);
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),nonce=randomBytes(32).toString('base64url');
  const epoch=(this.epochs.get(scopeKey(scope))??0)+1;this.epochs.set(scopeKey(scope),epoch);
  this.pending.set(state,{actor,scope:scopeKey(scope),verifier,nonce,expires:Date.now()+600000,settings:{...settings},epoch});
  const url=new URL(metadata.authorization_endpoint);url.search=new URLSearchParams({client_id:settings.clientId,redirect_uri:settings.redirectUri,response_type:'code',scope:SCOPES,resource:PLAN_BASE,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}).toString();
  return {url:url.href,state,expiresIn:600};
 }
 private async form(url:string,fields:Record<string,string>,settings:PlanSettings){
  const body=new URLSearchParams({...fields,client_id:settings.clientId}),headers:Record<string,string>={'content-type':'application/x-www-form-urlencoded'};
  if(settings.authMethod==='client_secret_post')body.set('client_secret',settings.clientSecret!);
  if(settings.authMethod==='client_secret_basic')headers.authorization='Basic '+Buffer.from(encodeURIComponent(settings.clientId)+':'+encodeURIComponent(settings.clientSecret!)).toString('base64');
  return this.f(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers,body:body.toString()});
 }
 private tokens(t:any,priorScopes?:string[]){
  const scopes=typeof t.scope==='string'?t.scope.split(/\s+/):priorScopes??[];
  if(!scopes.includes('chatgpt.tokens.use.direct')||!scopes.includes('resource.invoke'))throw new PlanError('CHATGPT_PLAN_PERMISSION_REQUIRED',403);
  if(typeof t.access_token!=='string'||!t.access_token||typeof t.refresh_token!=='string'||!t.refresh_token||String(t.token_type).toLowerCase()!=='bearer'||!Number.isFinite(t.expires_in)||t.expires_in<=0)throw new PlanError('CHATGPT_INVALID_TOKEN',502);
  return {access:t.access_token,refresh:t.refresh_token,expires:Date.now()+t.expires_in*1000,scopes};
 }
 async complete(actor:string,scope:PlanScope,b:{state:string;code?:string;error?:string;clientId?:string}){
  const p=this.pending.get(b.state);if(!p||p.actor!==actor||p.scope!==scopeKey(scope)||p.expires<Date.now())throw new PlanError('CHATGPT_AUTH_EXPIRED');
  this.pending.delete(b.state);
  if(b.error)throw new PlanError('CHATGPT_AUTH_DECLINED');
  if(!b.code||b.clientId&&b.clientId!==p.settings.clientId)throw new PlanError('CHATGPT_INVALID_CALLBACK');
  const m=await this.metadata(),r=await this.form(m.token_endpoint,{grant_type:'authorization_code',code:b.code,code_verifier:p.verifier,redirect_uri:p.settings.redirectUri,resource:PLAN_BASE},p.settings);
  if(!r.ok)throw new PlanError('CHATGPT_AUTH_FAILED',400);
  const t=await r.json() as any;
  let payload:JWTPayload;
  try{payload=this.o.verify?await this.o.verify(t.id_token,p.settings.clientId,p.nonce):await verifyPlanIdentity(t.id_token,p.settings.clientId,p.nonce,createRemoteJWKSet(new URL(m.jwks_uri)));
   if(!payload.sub||payload.nonce!==p.nonce)throw Error();
  }catch{throw new PlanError('CHATGPT_INVALID_IDENTITY');}
  if(this.epochs.get(p.scope)!==p.epoch)throw new PlanError('CHATGPT_AUTH_EXPIRED');
  const tokens=this.tokens(t),records=this.o.store.load();
  // Reconnection does not silently switch the account backing existing routes.
  const old=Object.values(records).find(x=>x.scope===p.scope);
  if(old&&(old.subject!==payload.sub||old.clientId!==p.settings.clientId))throw new PlanError('CHATGPT_DISCONNECT_FIRST',409);
  const id=old?.id??randomUUID();records[id]={id,scope:p.scope,clientId:p.settings.clientId,subject:payload.sub,email:typeof payload.email==='string'?payload.email:'',...tokens};this.o.store.save(records);this.blocked.delete(id);return this.status(scope);
 }
 credentialId(scope:PlanScope){const r=Object.values(this.o.store.load()).find(x=>x.scope===scopeKey(scope));if(!r||this.blocked.has(r.id))throw new PlanError('CHATGPT_LOGIN_REQUIRED',401);return r.id;}
 async token(id:string):Promise<PlanCredential>{
  if(this.blocked.has(id))throw new PlanError('CHATGPT_LOGIN_REQUIRED',401);
  const r=this.o.store.load()[id],settings=this.o.settings();if(!r||!settings||settings.clientId!==r.clientId)throw new PlanError('CHATGPT_LOGIN_REQUIRED',401);
  if(r.expires>Date.now()+60000)return r;
  const existing=this.refreshing.get(id);if(existing)return existing;
  const promise=(async()=>{
   const m=await this.metadata(),res=await this.form(m.token_endpoint,{grant_type:'refresh_token',refresh_token:r.refresh,resource:PLAN_BASE},settings);
   if(!res.ok){if((res.status===400||res.status===401)&&this.o.store.load()[id]?.refresh===r.refresh)this.blocked.add(id);throw new PlanError('CHATGPT_LOGIN_REQUIRED',401);}
   const t=await res.json(),next={...r,...this.tokens(t,r.scopes)},records=this.o.store.load();
   if(this.blocked.has(id))return next;
   if(records[id]?.refresh!==r.refresh)throw new PlanError('CHATGPT_LOGIN_REQUIRED',401);
   records[id]=next;this.o.store.save(records);return next;
  })().finally(()=>this.refreshing.delete(id));this.refreshing.set(id,promise);return promise;
 }
 async models(scope:PlanScope){const r=await this.token(this.credentialId(scope));if(!this.connected(r.id))throw new PlanError('CHATGPT_LOGIN_REQUIRED',401);const res=await this.f(PLAN_BASE+'/models',{redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+r.access}});
  if(!res.ok)throw new PlanError(res.status===401||res.status===403?'CHATGPT_LOGIN_REQUIRED':'CHATGPT_MODELS_FAILED',res.status===429?429:502);
  const j=await res.json() as any;if(!Array.isArray(j.models))throw new PlanError('CHATGPT_MODELS_FAILED',502);
  return j.models.filter((x:any)=>x.visibility==='list'&&typeof x.slug==='string'&&x.slug.length<=120).map((x:any)=>({id:x.slug,name:typeof x.display_name==='string'?x.display_name:x.slug}));
 }
 async disconnect(scope:PlanScope){
  const id=Object.values(this.o.store.load()).find(x=>x.scope===scopeKey(scope))?.id;
  this.epochs.set(scopeKey(scope),(this.epochs.get(scopeKey(scope))??0)+1);
  for(const [k,p] of this.pending)if(p.scope===scopeKey(scope))this.pending.delete(k);
  if(!id)return {connected:false,revoked:true};this.blocked.add(id);for(const controller of this.active.get(id)??[])controller.abort();
  const rotated=await this.refreshing.get(id)?.catch(()=>undefined);
  const records=this.o.store.load(),r=rotated??records[id];delete records[id];this.o.store.save(records);
  let revoked=false;try{const s=this.o.settings();if(r&&s&&s.clientId===r.clientId){const m=await this.metadata(),res=await this.form(m.revocation_endpoint,{token:r.refresh,token_type_hint:'refresh_token'},s);revoked=res.status===200;}}catch{}
  return {connected:false,revoked};
 }
 async infer(id:string,model:string,body:any,signal:AbortSignal){const credential=await this.token(id);signal.throwIfAborted();if(this.blocked.has(id)||!this.o.store.load()[id])throw new PlanError('CHATGPT_LOGIN_REQUIRED',401);
  const controller=new AbortController(),active=this.active.get(id)??new Set<AbortController>();active.add(controller);this.active.set(id,active);signal=AbortSignal.any([signal,controller.signal]);
  const release=()=>{active.delete(controller);if(!active.size)this.active.delete(id);};let streaming=false;
  try{
  const res=await this.f(PLAN_BASE+'/responses',{method:'POST',redirect:'error',signal,headers:{authorization:'Bearer '+credential.access,'content-type':'application/json'},body:JSON.stringify(planRequest(model,body))});
  if(!res.ok)return res;if(!res.body)throw new PlanError('CHATGPT_INCOMPLETE',502);
  const stream=planStream(res.body,model);
  if(body.stream===true){streaming=true;const reader=stream.getReader();return new Response(new ReadableStream<Uint8Array>({async pull(out){try{const n=await reader.read();if(n.done){release();out.close();}else out.enqueue(n.value);}catch(e){release();out.error(e);}},async cancel(){controller.abort();release();await reader.cancel().catch(()=>{});}}),{headers:{'content-type':'text/event-stream'}});}
  const reader=stream.getReader(),decoder=new TextDecoder();let raw='';
  try{for(;;){const n=await reader.read();if(n.done)break;raw+=decoder.decode(n.value,{stream:true});if(raw.length>8*1024*1024)throw new PlanError('CHATGPT_RESPONSE_TOO_LARGE',502);}}catch(e){await reader.cancel().catch(()=>{});throw e;}
  let content='',usage:any;for(const line of raw.split('\n'))if(line.startsWith('data: {')){const j=JSON.parse(line.slice(6));content+=j.choices?.[0]?.delta?.content??'';if(j.usage)usage=j.usage;}
  return Response.json({id:'chatcmpl-'+randomUUID(),object:'chat.completion',model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],...(usage?{usage}:{})});
  }finally{if(!streaming)release();}
 }
}

export function planRequest(model:string,body:any){
 if(!Array.isArray(body.messages)||body.tools?.length||body.functions?.length)throw new PlanError('CHATGPT_INPUT_UNSUPPORTED');
 const input=body.messages.map((m:any)=>{
  if(!['system','developer','user','assistant'].includes(m.role)||m.tool_calls)throw new PlanError('CHATGPT_INPUT_UNSUPPORTED');
  const role=m.role==='system'?'developer':m.role;
  const content=typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.map((p:any)=>{
   if(p.type==='text')return {type:role==='assistant'?'output_text':'input_text',text:String(p.text??'')};
   if(p.type==='image_url'&&role==='user'&&typeof p.image_url?.url==='string')return {type:'input_image',image_url:p.image_url.url};
   throw new PlanError('CHATGPT_INPUT_UNSUPPORTED');
  }):(()=>{throw new PlanError('CHATGPT_INPUT_UNSUPPORTED');})();return {role,content};
 });
 const format=body.response_format?.type==='json_schema'?{type:'json_schema',...body.response_format.json_schema}:body.response_format?.type==='json_object'?{type:'json_object'}:undefined;
 return {model,input,store:false,stream:true,...(format?{text:{format}}:{})};
}
export function planStream(source:ReadableStream<Uint8Array>,model:string){
 const reader=source.getReader(),decoder=new TextDecoder(),encoder=new TextEncoder();let buffer='',completed=false,content=false;
 const id='chatcmpl-'+randomUUID();
 const chunk=(delta:any,reason:string|null=null,usage?:any)=>encoder.encode('data: '+JSON.stringify({id,object:'chat.completion.chunk',model,choices:[{index:0,delta,finish_reason:reason}],...(usage?{usage}:{})})+'\n\n');
 return new ReadableStream<Uint8Array>({async pull(out){try{
  for(;;){const n=await reader.read();buffer+=n.done?decoder.decode():decoder.decode(n.value,{stream:true});
   if(buffer.length>8*1024*1024)throw new PlanError('CHATGPT_RESPONSE_TOO_LARGE',502);
   const lines=buffer.split('\n');buffer=n.done?'':lines.pop()??'';let sent=false;
   for(const line of lines){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(!data||data==='[DONE]')continue;const e=JSON.parse(data);
    if(['error','response.failed','response.incomplete'].includes(e.type))throw new PlanError('CHATGPT_INCOMPLETE',502);
    if(e.type==='response.output_text.delta'&&typeof e.delta==='string'&&e.delta.length){content=true;out.enqueue(chunk({content:e.delta}));sent=true;}
    if(e.type==='response.completed'){
     if(e.response?.status!=='completed'||!content)throw new PlanError('CHATGPT_INCOMPLETE',502);
     const u=e.response.usage;completed=true;out.enqueue(chunk({},'stop',u?{prompt_tokens:u.input_tokens,completion_tokens:u.output_tokens,total_tokens:u.total_tokens,prompt_tokens_details:u.input_tokens_details,completion_tokens_details:u.output_tokens_details}:undefined));out.enqueue(encoder.encode('data: [DONE]\n\n'));out.close();await reader.cancel();return;
    }
   }
   if(n.done){if(!completed)throw new PlanError('CHATGPT_INCOMPLETE',502);return;}if(sent)return;
  }
 }catch(e){await reader.cancel().catch(()=>{});out.error(e);}},cancel(){return reader.cancel();}});
}
