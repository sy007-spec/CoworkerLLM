import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash} from 'node:crypto';
import {z} from 'zod';

const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const keyInput=z.object({key_alias:z.string().max(160).optional(),models:z.array(z.string().min(1).max(120)).min(1).max(100),max_tokens:positive,max_budget:z.number().positive().optional(),token_month:z.string().regex(/^\d{4}-\d{2}$/).optional(),rpm_limit:positive.default(60),tpm_limit:positive.optional(),max_concurrent:positive.max(128).default(8),duration:z.string().regex(/^\d{1,3}d$/).default('32d'),metadata:z.object({tenant:z.uuid(),month:z.string().regex(/^\d{4}-\d{2}$/).optional()}).strict()}).strict();
export type KeyPolicy=z.infer<typeof keyInput>;
export type VirtualKey=KeyPolicy&{id:string;expires:number;revoked:boolean};
export const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export const month=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date());
export class Governance{
 readonly db:DatabaseSync;
 constructor(file:string){this.db=new DatabaseSync(file);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS virtual_keys(hash TEXT PRIMARY KEY,policy TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS consumption(key TEXT,period TEXT,tokens INTEGER NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(key,period));
 CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,key TEXT NOT NULL,period TEXT NOT NULL,reserved INTEGER NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS rate_windows(key TEXT,window INTEGER,requests INTEGER NOT NULL,tokens INTEGER NOT NULL,PRIMARY KEY(key,window));`);}
 transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result}catch(e){this.db.exec('ROLLBACK');throw e}}
 create(input:unknown,issuedKey?:string){const policy=keyInput.parse(input),key=issuedKey||'cw-'+randomBytes(32).toString('base64url'),id=digest(key),value:VirtualKey={...policy,id,expires:Date.now()+Number(policy.duration.slice(0,-1))*86400000,revoked:false};this.db.prepare('INSERT INTO virtual_keys VALUES(?,?)').run(id,JSON.stringify(value));return {key,...value}}
 lookup(key:string):VirtualKey|undefined{const row=this.db.prepare('SELECT policy FROM virtual_keys WHERE hash=?').get(digest(key));if(!row)return;const p=JSON.parse(String(row.policy)) as VirtualKey;return p.revoked||p.expires<=Date.now()?undefined:p}
 list(){return this.db.prepare('SELECT policy FROM virtual_keys').all().map(r=>JSON.parse(String(r.policy)) as VirtualKey)}
 revoke(id:string){const row=this.db.prepare('SELECT policy FROM virtual_keys WHERE hash=?').get(id);if(!row)return false;const p=JSON.parse(String(row.policy));p.revoked=true;this.db.prepare('UPDATE virtual_keys SET policy=? WHERE hash=?').run(JSON.stringify(p),id);return true}
 usage(id:string,period=month()){return this.db.prepare('SELECT tokens,calls FROM consumption WHERE key=? AND period=?').get(id,period)||{tokens:0,calls:0}}
 reserve(key:VirtualKey,model:string,tokens:number){return this.transaction(()=>{const now=Date.now(),period=month();if(!this.lookupById(key.id)||key.token_month&&key.token_month!==period)throw Object.assign(Error('key_expired_or_revoked'),{status:403});if(!key.models.includes(model))throw Object.assign(Error('model_not_allowed'),{status:403});this.db.prepare('DELETE FROM leases WHERE expires<?').run(now);const active=Number(this.db.prepare('SELECT COUNT(*) n FROM leases WHERE key=?').get(key.id)!.n);if(active>=key.max_concurrent)throw Object.assign(Error('concurrency_limit'),{status:429});const used=Number(this.usage(key.id,period).tokens);if(used+tokens>key.max_tokens)throw Object.assign(Error('space_token_budget_exceeded'),{status:429});const minute=Math.floor(now/60000),rate=this.db.prepare('SELECT requests,tokens FROM rate_windows WHERE key=? AND window=?').get(key.id,minute);if(Number(rate?.requests||0)>=key.rpm_limit||key.tpm_limit&&Number(rate?.tokens||0)+tokens>key.tpm_limit)throw Object.assign(Error('rate_limit_exceeded'),{status:429});const id=randomBytes(16).toString('hex');this.db.prepare('INSERT INTO consumption VALUES(?,?,?,1) ON CONFLICT(key,period) DO UPDATE SET tokens=tokens+excluded.tokens,calls=calls+1').run(key.id,period,tokens);this.db.prepare('INSERT INTO rate_windows VALUES(?,?,1,?) ON CONFLICT(key,window) DO UPDATE SET requests=requests+1,tokens=tokens+excluded.tokens').run(key.id,minute,tokens);this.db.prepare('DELETE FROM rate_windows WHERE window<?').run(minute-2);this.db.prepare('INSERT INTO leases VALUES(?,?,?,?,?)').run(id,key.id,period,tokens,now+300000);return {id,key:key.id,period,reserved:tokens}})}
 private lookupById(id:string){const r=this.db.prepare('SELECT policy FROM virtual_keys WHERE hash=?').get(id);if(!r)return false;const p=JSON.parse(String(r.policy));return !p.revoked&&p.expires>Date.now()}
 settle(lease:{id:string;key:string;period:string;reserved:number},actual?:number){this.transaction(()=>{const found=this.db.prepare('SELECT id FROM leases WHERE id=?').get(lease.id);if(!found)return;if(actual!==undefined&&Number.isSafeInteger(actual)&&actual>=0)this.db.prepare('UPDATE consumption SET tokens=MAX(0,tokens+?) WHERE key=? AND period=?').run(actual-lease.reserved,lease.key,lease.period);this.db.prepare('DELETE FROM leases WHERE id=?').run(lease.id)})}
 close(){this.db.close()}
}
