import type {Hono} from 'hono';
import {z} from 'zod';
import {ChatgptPlan,PlanError,PLAN_BASE,planSettingsSchema} from './chatgpt-plan.js';
import type {ConfigStore,ScopeConfig} from './llm-gateway-admin.js';
export const planScopeSchema=z.object({kind:z.enum(['global','spaces','merchants']),id:z.string().max(36)}).strict().refine(s=>s.kind==='global'?s.id==='':z.uuid().safeParse(s.id).success);
export function registerPlanRoutes(app:Hono<any>,plan:ChatgptPlan|undefined,store:ConfigStore){
 app.post('/v1/admin/chatgpt/:action',async c=>{
  if(c.get('caller')!=='admin')return c.json({error:'forbidden'},403);
  const schema=z.object({actor:z.guid(),scope:planScopeSchema,settings:planSettingsSchema.optional(),state:z.string().max(100).optional(),code:z.string().max(4096).optional(),error:z.string().max(200).optional(),clientId:z.string().max(200).optional(),model:z.string().min(1).max(120).optional()}).strict();
  const parsed=schema.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:'invalid_request'},400);
  const b=parsed.data,action=c.req.param('action');
  if(!plan)return action==='status'?c.json({available:false,connected:false}):c.json({error:'CHATGPT_APP_NOT_CONFIGURED'},503);
  c.header('Cache-Control','no-store');
  try{
   if(action==='settings')return c.json(plan.configuration());
   if(action==='configure')return c.json(plan.configure(b.settings));
   if(action==='status')return c.json(plan.status(b.scope));
   if(action==='start')return c.json(await plan.start(b.actor,b.scope));
   if(action==='complete'){if(!b.state)return c.json({error:'invalid_request'},400);return c.json(await plan.complete(b.actor,b.scope,{...b,state:b.state}));}
   if(action==='models')return c.json({items:await plan.models(b.scope)});
   if(action==='disconnect')return c.json(await plan.disconnect(b.scope));
   if(action==='apply'){
    if(!b.model||!(await plan.models(b.scope)).some((m:{id:string})=>m.id===b.model))return c.json({error:'CHATGPT_MODEL_NOT_AVAILABLE'},400);
    const raw=structuredClone(store.load());let target:ScopeConfig=raw;
    if(b.scope.kind!=='global'){raw.assignments??={spaces:{},merchants:{},bindings:{}};target=raw.assignments[b.scope.kind][b.scope.id]??={};}
    const entry={id:'chatgpt-subscription',provider:'chatgpt' as const,baseUrl:PLAN_BASE,model:b.model,apiKey:'plan:'+plan.credentialId(b.scope)};
    const old=target.pools?.chat?.entries??(target.chat?[{...target.chat,id:'legacy'}]:[]);
    if(old.length>=20&&!old.some(x=>x.id===entry.id))return c.json({error:'CHATGPT_POOL_FULL'},400);
    target.pools??={};target.pools.chat={roundRobin:false,entries:[entry,...old.filter(x=>x.id!==entry.id)]};target.chat=entry;if(target.use)delete target.use.chat;
    store.save(raw);return c.json({ok:true,model:b.model});
   }
   return c.json({error:'not_found'},404);
  }catch(e){return c.json({error:e instanceof PlanError?e.code:'CHATGPT_UNAVAILABLE'},(e instanceof PlanError?e.status:503) as 400);}
 });
}
