import {mkdirSync,readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {serve} from '@hono/node-server';
import {coworkerGateway} from './service.js';
import {Governance} from './governance.js';
import {UsageLedger} from './llm-usage.js';
import {type RawConfig} from './llm-gateway-admin.js';

const dir=process.env.GATEWAY_RUNTIME||'/data';mkdirSync(dir,{recursive:true,mode:0o700});
const configFile=dir+'/gateway.json';
const load=():RawConfig=>{try{return JSON.parse(readFileSync(configFile,'utf8'))}catch{return {}}};
const save=(next:RawConfig)=>{writeFileSync(configFile+'.tmp',JSON.stringify(next)+'\n',{mode:0o600});chmodSync(configFile+'.tmp',0o600);renameSync(configFile+'.tmp',configFile)};
const callers=():Record<string,string>=>{try{return JSON.parse(readFileSync(dir+'/callers.json','utf8'))}catch{return {}}};
const governance=new Governance(dir+'/governance.sqlite'),usage=new UsageLedger(dir+'/usage.sqlite');
const masterKey=process.env.COWORKER_MASTER_KEY||'',baseURL=process.env.LITELLM_BASE_URL||'http://engine:4000',engineKey=process.env.LITELLM_MASTER_KEY||'';
if(engineKey.length<32)throw Error('LITELLM_MASTER_KEY must contain at least 32 characters');
const app=coworkerGateway({masterKey,governance,engine:{baseURL,masterKey:engineKey},config:load as any,callers,store:{load,save},usage,log:e=>console.log(JSON.stringify(e))});
const server=serve({fetch:app.fetch,port:Number(process.env.PORT||4400),hostname:process.env.HOST||'0.0.0.0'});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>{governance.close();process.exit(0)}));
