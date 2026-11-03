// Durable metadata ledger. Terminal sequence numbers, rather than request start IDs, drive incremental reads.
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
export type Usage={input:number|null;output:number|null;cached:number|null;reasoning:number|null;cacheWrite?:number|null};
export type CallRecord={id:string;operation:string|null;caller:string;space:string|null;merchant:string|null;capability:string;provider:string;model:string;started:string;finished:string;status:string;httpStatus:number;ms:number;usage:Usage;usageState:string};
export const emptyUsage=():Usage=>({input:null,output:null,cached:null,reasoning:null});
const count=(n:unknown):number|null=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?n:null;
// Only read provider-reported counters. Missing data remains unknown, including interrupted streams.
export function readUsage(provider:string,j:any,old:Usage=emptyUsage()):Usage{
 const u=provider==='gemini'?j?.usageMetadata:provider==='anthropic'?j?.usage??j?.message?.usage:j?.usage??j?.response?.usage;
 if(!u)return old;
 const pick=(n:unknown,prior:number|null)=>count(n)??prior;
 return provider==='gemini'?{input:pick(u.promptTokenCount,old.input),output:count(u.totalTokenCount)!==null&&count(u.promptTokenCount)!==null?count(u.totalTokenCount-u.promptTokenCount):count(u.candidatesTokenCount)!==null?count(u.candidatesTokenCount+(count(u.thoughtsTokenCount)??0)):old.output,cached:pick(u.cachedContentTokenCount,old.cached),reasoning:pick(u.thoughtsTokenCount,old.reasoning)}:
 provider==='anthropic'?{input:count(u.input_tokens)!==null?count(u.input_tokens+(count(u.cache_read_input_tokens)??0)+(count(u.cache_creation_input_tokens)??0)):old.input,output:pick(u.output_tokens,old.output),cached:pick(u.cache_read_input_tokens,old.cached),cacheWrite:pick(u.cache_creation_input_tokens,old.cacheWrite??null),reasoning:old.reasoning}:
 {input:pick(u.prompt_tokens??u.input_tokens,old.input),output:pick(u.completion_tokens??u.output_tokens,old.output),cached:pick(u.prompt_tokens_details?.cached_tokens,old.cached),reasoning:pick(u.completion_tokens_details?.reasoning_tokens,old.reasoning)};
}
export function usageObserver(provider:string,stream:boolean){
 let buffer='',overflow=false,usage=emptyUsage(),failed=false,terminal=false;const decoder=new TextDecoder();
 const parse=(s:string)=>{if(s==='[DONE]'){terminal=true;return;}try{const j=JSON.parse(s);usage=readUsage(provider,j,usage);if(j?.error||j?.type==='error')failed=true;if(j?.type==='message_stop'||j?.delta?.stop_reason||j?.candidates?.some((x:any)=>x.finishReason)||j?.choices?.some((x:any)=>x.finish_reason))terminal=true;}catch{/* keepalives / non-JSON error pages */}};
 return {get usage(){return usage;},get failed(){return failed;},get terminal(){return terminal;},push(bytes:Uint8Array){
  if(overflow)return;buffer+=decoder.decode(bytes,{stream:true});
  if(stream){const lines=buffer.split('\n');buffer=lines.pop()??'';for(const line of lines)if(line.startsWith('data:'))parse(line.slice(5).trim());}
  // Never accumulate model responses without a bound; no response text is persisted.
  if(buffer.length>2*1024*1024){buffer='';overflow=true;}
 },end(){if(!overflow){buffer+=decoder.decode();if(stream){if(buffer.startsWith('data:'))parse(buffer.slice(5).trim());}else parse(buffer);}buffer='';}};
}
const integer=z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const query=z.object({after:integer.default(0),snapshot:integer.optional(),limit:z.coerce.number().int().min(1).max(10001).default(100),from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional(),merchant:z.uuid().optional(),space:z.uuid().optional(),capability:z.enum(['chat','embedding','rerank']).optional(),status:z.enum(['succeeded','failed','cancelled','timed_out','interrupted']).optional(),model:z.string().max(120).optional()}).strict();
export class UsageLedger{
 private db:DatabaseSync;
 constructor(path:string){
  this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY,record TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS calls(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,finished TEXT NOT NULL,merchant TEXT,space TEXT,capability TEXT NOT NULL,status TEXT NOT NULL,model TEXT NOT NULL,record TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS calls_merchant_time ON calls(merchant,finished,seq);
   CREATE INDEX IF NOT EXISTS calls_time ON calls(finished,seq);
   CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  this.db.prepare("INSERT OR IGNORE INTO meta VALUES('since',?)").run(new Date().toISOString());
  // A prior process cannot still be generating on this instance. Never report it as successful or zero-token.
  for(const row of this.db.prepare('SELECT record FROM pending').all()){
   const r=JSON.parse(String(row.record)) as CallRecord;
   this.finish({...r,finished:new Date().toISOString(),status:'interrupted',httpStatus:503,ms:Math.max(0,Date.now()-Date.parse(r.started)),usageState:'unavailable'});
  }
 }
 start(r:CallRecord){this.db.prepare('INSERT INTO pending VALUES(?,?)').run(r.id,JSON.stringify(r));}
 finish(r:CallRecord){
  this.db.exec('BEGIN IMMEDIATE');try{
   this.db.prepare('INSERT OR IGNORE INTO calls(id,finished,merchant,space,capability,status,model,record) VALUES(?,?,?,?,?,?,?,?)').run(r.id,r.finished,r.merchant,r.space,r.capability,r.status,r.model,JSON.stringify(r));
   this.db.prepare('DELETE FROM pending WHERE id=?').run(r.id);this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 query(raw:Record<string,string>){
  const q=query.parse(raw),to=q.to??new Date(Date.now()+1).toISOString(),from=q.from??new Date(Date.parse(to)-7*86400000).toISOString();
  if(Date.parse(from)>=Date.parse(to)||Date.parse(to)-Date.parse(from)>366*86400000)throw Error('INVALID_USAGE_RANGE');
  // Consistent cutoff and cursor for both the aggregate and every detail page.
  const snapshot=q.snapshot??Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM calls').get()!.n);
  const parts=['seq<=?','finished>=?','finished<?'],args:(string|number)[]=[snapshot,new Date(from).toISOString(),new Date(to).toISOString()];
  for(const key of ['merchant','space','capability','status','model'] as const)if(q[key]){parts.push(key+'=?');args.push(q[key]!);}
  const where=parts.join(' AND ');
  const stats=this.db.prepare(`SELECT COUNT(*) AS calls,
   SUM(status='succeeded') AS succeeded,SUM(status='failed') AS failed,SUM(status='cancelled') AS cancelled,SUM(status='timed_out') AS timedOut,SUM(status='interrupted') AS interrupted,
   SUM(json_extract(record,'$.usage.input')) AS input,SUM(json_extract(record,'$.usage.output')) AS output,
   SUM(json_extract(record,'$.usage.cached')) AS cached,SUM(json_extract(record,'$.usage.cacheWrite')) AS cacheWrite,SUM(json_extract(record,'$.usage.reasoning')) AS reasoning,
   SUM(json_extract(record,'$.ms')) AS ms,SUM(json_extract(record,'$.usageState')='reported') AS reported,
   SUM(json_extract(record,'$.usageState')='partial') AS partial,SUM(merchant IS NULL) AS unattributed FROM calls WHERE ${where}`).get(...args)!;
  const rows=this.db.prepare(`SELECT seq,record FROM calls WHERE ${where} AND seq>? ORDER BY seq LIMIT ?`).all(...args,q.after,q.limit+1),hasMore=rows.length>q.limit;
  const items=rows.slice(0,q.limit).map(r=>({seq:Number(r.seq),...JSON.parse(String(r.record)) as CallRecord}));
  return {from:new Date(from).toISOString(),to:new Date(to).toISOString(),snapshot,after:q.after,nextCursor:items.at(-1)?.seq??q.after,hasMore,summary:stats,items,
   since:String(this.db.prepare("SELECT value FROM meta WHERE key='since'").get()!.value),
   note:'按完成时间统计网关已观测调用；token 为供应商报告，未知不按零计算。缓存/推理为细分项，禁止重复相加。耗时为请求墙钟毫秒，非 GPU 算力秒或计费金额。中断可能仅有部分用量。'};
 }
 close(){this.db.close();}
}
