import {providerTemplates} from './provider-templates.js';
import {readFileSync,writeFileSync,chmodSync,renameSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

/** One public model alias, multiple private provider deployments. Never embed keys in config. */
export function engineConfiguration(env:Record<string,string|undefined>){
 const template=env.MODEL_TEMPLATE?.trim()?providerTemplates.find(t=>t.id===env.MODEL_TEMPLATE!.trim()):undefined;if(env.MODEL_TEMPLATE?.trim()&&!template)throw Error('Unknown MODEL_TEMPLATE');if(template&&env.MODEL_PROVIDER?.trim()&&env.MODEL_PROVIDER.trim()!==template.provider)throw Error('MODEL_PROVIDER does not match selected template');
 const provider=(env.MODEL_PROVIDER||template?.provider||'openai').trim(),name=(env.MODEL_NAME||'').trim(),alias=(env.MODEL_ALIAS||'training-author').trim();
 if(!/^[a-zA-Z0-9_-]+$/.test(provider)||!name||name.length>200||!alias||alias.length>120)throw Error('Set MODEL_PROVIDER and MODEL_NAME; MODEL_ALIAS is optional');
 const numbered=Object.keys(env).filter(k=>/^(MODEL|GEMINI)_API_KEY_[1-9]\d*$/.test(k)).sort((a,b)=>Number(a.split('_').at(-1))-Number(b.split('_').at(-1))||a.localeCompare(b));
 const values=[env.MODEL_API_KEY,provider==='gemini'?env.GEMINI_API_KEY:undefined,...numbered.filter(k=>provider==='gemini'||k.startsWith('MODEL_')).map(k=>env[k]),...(env.MODEL_API_KEYS||'').split(',')];
 const keys=[...new Set(values.map(v=>(v||'').trim()).filter(Boolean))];
 if(!keys.length||keys.length>64||keys.some(k=>k.length>4096||/[\s'"\\]/.test(k)))throw Error('Provide 1–64 valid unique API keys in the private file');
 const base=(env.MODEL_API_BASE||template?.apiBase||'').trim();if(template?.requiresCustomBase&&!env.MODEL_API_BASE?.trim()||/[{}<>]/.test(base))throw Error('Replace the template resource/workspace address with your actual MODEL_API_BASE');if(base){let u;try{u=new URL(base)}catch{throw Error('Invalid model endpoint')}if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('Model endpoint must use HTTPS')}else if(provider==='openai')throw Error('OpenAI-compatible endpoints require MODEL_API_BASE');
 const secrets:Record<string,string>={};
 const config={model_list:keys.map((key,index)=>{const variable='COWORKER_PROVIDER_KEY_'+(index+1);secrets[variable]=key;return {model_name:alias,litellm_params:{model:provider==='openai'&&template?provider+'/'+name:name.startsWith(provider+'/')?name:provider+'/'+name,api_key:'os.environ/'+variable,...(base?{api_base:base}:{})},model_info:{id:alias+'-key-'+(index+1)}}}),router_settings:{routing_strategy:'simple-shuffle',num_retries:Math.min(2,keys.length-1),cooldown_time:60},litellm_settings:{drop_params:true,set_verbose:false,turn_off_message_logging:true},general_settings:{store_model_in_db:true}};
 return {config,secrets};
}
function privateWrite(file:string,text:string){writeFileSync(file+'.new',text,{mode:0o600});chmodSync(file+'.new',0o600);renameSync(file+'.new',file)}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const [input,configFile,secretsFile]=process.argv.slice(2);if(!input||!configFile||!secretsFile)throw Error('Usage: node dist/engine-config.js <private-input.env> <models.yaml> <models.env>');if(new Set([input,configFile,secretsFile].map(x=>path.resolve(x))).size!==3)throw Error('Input, config and secrets files must differ');const {config,secrets}=engineConfiguration(parseEnv(readFileSync(input,'utf8')));privateWrite(configFile,JSON.stringify(config,null,2)+'\n');privateWrite(secretsFile,Object.entries(secrets).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n');console.log('Engine configuration generated: '+config.model_list.length+' private key deployments; alias '+config.model_list[0]!.model_name)}catch(e){console.error((e as Error).message);process.exitCode=1}
}
