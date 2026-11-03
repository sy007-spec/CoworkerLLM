import type {RawConfig,RawUpstream,ScopeConfig} from './llm-gateway-admin.js';
export type ModelCapability='chat'|'embedding'|'rerank';
export function resolveModel(raw:RawConfig,space:string,cap:ModelCapability){
 const merchant=raw.assignments?.bindings?.[space]??space;
 const candidates:[string,string,ScopeConfig|undefined][]=[['spaces',space,raw.assignments?.spaces?.[space]],['merchants',merchant,raw.assignments?.merchants?.[merchant]],['global','',raw]];
 for(const [kind,id,config] of candidates){
  if(!config)continue;
  const ref=config.use?.[cap];
  if(ref){const up=globalEntries(raw,cap).find(u=>u.id===ref);return {up,pool:undefined,key:kind+':'+id+':'+cap,kind,id};}
  const pool=config.pools?.[cap];
  if(pool||config[cap])return {up:config[cap],pool,key:kind+':'+id+':'+cap,kind,id};
 }
 return {up:undefined,pool:undefined,key:'global::'+cap,kind:'global',id:''};
}
export const globalEntries=(raw:RawConfig,cap:ModelCapability):RawUpstream[]=>raw.pools?.[cap]?.entries??(raw[cap]?[{...raw[cap],id:'legacy'}]:[]);
export function validAssignments(raw:RawConfig){
 if(Object.keys(raw.assignments?.spaces??{}).length>500||Object.keys(raw.assignments?.merchants??{}).length>500||Object.keys(raw.assignments?.bindings??{}).length>1000)return 'model_scope_limit_exceeded';
 const signature=(u:RawUpstream)=>JSON.stringify([u.provider??'openai',u.baseUrl?.replace(/\/+$/,''),u.model,u.dimension??null]);
 const entries=globalEntries(raw,'embedding'),defaults=raw.pools?.embedding?.roundRobin?entries:entries.slice(0,1);
 for(const config of [...Object.values(raw.assignments?.spaces??{}),...Object.values(raw.assignments?.merchants??{})]){
  for(const cap of ['chat','embedding','rerank'] as const)if(config.use?.[cap]&&!globalEntries(raw,cap).some(u=>u.id===config.use![cap]))return 'model_reference_in_use';
  const selected=config.use?.embedding?entries.find(u=>u.id===config.use!.embedding):undefined;
  const embedding=selected?[selected]:config.pools?.embedding?.entries??(config.embedding?[config.embedding]:[]);
  if(embedding.length&&(!defaults.length||embedding.some(u=>!u.dimension||defaults.some(d=>signature(d)!==signature(u)))))return 'scoped_embedding_incompatible';
 }
 return null;
}
