// Vendor adapters for the LLM gateway. Callers always speak the OpenAI wire format; the gateway translates to the vendor's native API
// (Google Gemini generateContent / batchEmbedContents, Anthropic Messages) and back, including streaming.
import {geminiBase} from './model-check.js';

export type Provider='openai'|'gemini'|'anthropic'|'chatgpt';
export type Capability='chat'|'embedding'|'rerank';
export const PROVIDERS:Provider[]=['openai','gemini','anthropic','chatgpt'];
export const DEFAULT_BASE:Record<Provider,string>={openai:'',gemini:'https://generativelanguage.googleapis.com/v1beta',anthropic:'https://api.anthropic.com/v1',chatgpt:'https://api.openai.com/v1'};
// Anthropic offers no embedding or rerank API; reranking is only available through OpenAI-compatible providers.
export const supports=(p:Provider,cap:Capability)=>cap==='chat'||(cap==='embedding'&&p!=='anthropic'&&p!=='chatgpt')||(cap==='rerank'&&p==='openai');

// Reduce a pasted full request URL (.../models/x:generateContent, .../chat/completions, ...) to its base address.
export function normalizeBase(raw:string,provider:Provider='openai'){
 let s=raw.trim().split(/[?#]/)[0]!.replace(/\/+$/,'');
 s=s.replace(/\/models\/[^/]+:(?:stream)?(?:generateContent|batchEmbedContents|embedContent|streamGenerateContent)$/i,'');
 s=s.replace(/\/(?:chat\/completions|completions|embeddings|rerank|messages)$/i,'').replace(/\/+$/,'');
 return provider==='gemini'?s.replace(/\/openai$/,''):s;
}

export type Target={apiKey:string;model:string;dimension?:number};
export type Outgoing={url:string;headers:Record<string,string>;body:unknown};
const ANTHROPIC_VERSION='2023-06-01';

const text=(c:unknown):string=>typeof c==='string'?c:Array.isArray(c)?c.map(p=>typeof p==='string'?p:p&&typeof p==='object'&&(p as any).type==='text'?String((p as any).text??''):'').join(''):'';
const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:undefined;
const stops=(v:unknown)=>typeof v==='string'?[v]:Array.isArray(v)?v.filter(x=>typeof x==='string').slice(0,5):undefined;
function split(body:any){
 const system:string[]=[],turns:{role:'user'|'assistant';text:string;content:unknown}[]=[];
 for(const m of Array.isArray(body?.messages)?body.messages:[]){
  const t=text(m?.content);
  if(m?.role==='system'||m?.role==='developer')system.push(t);
  else turns.push({role:m?.role==='assistant'?'assistant':'user',text:t,content:m?.content});
 }
 return {system:system.join('\n'),turns};
}
const drop=(o:Record<string,unknown>)=>Object.fromEntries(Object.entries(o).filter(([,v])=>v!==undefined));
function imageParts(content:unknown,provider:'gemini'|'anthropic'){
 if(!Array.isArray(content)||!content.some(p=>p?.type==='image_url'))return null;
 return content.map(p=>{
  if(p?.type==='text')return provider==='gemini'?{text:String(p.text??'')}:{type:'text',text:String(p.text??'')};
  const m=typeof p?.image_url?.url==='string'?/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(p.image_url.url):null;
  if(!m)throw Error('IMAGE_INPUT_UNSUPPORTED');
  return provider==='gemini'?{inlineData:{mimeType:m[1],data:m[2]}}:{type:'image',source:{type:'base64',media_type:m[1],data:m[2]}};
 });
}

export function buildChat(provider:Provider,base:string,t:Target,body:any):Outgoing{
 if(provider==='chatgpt')throw Error('CHATGPT_USE_AUTHORIZATION');
 if(provider==='openai')return {url:base+'/chat/completions',headers:{authorization:'Bearer '+t.apiKey},body:{...body,model:t.model}};
 const {system,turns}=split(body),maxTokens=num(body?.max_tokens)??num(body?.max_completion_tokens);
 if(provider==='gemini'){
  const stream=body?.stream===true;
  return {
   url:geminiBase(base)+'/models/'+encodeURIComponent(t.model.replace(/^models\//,''))+(stream?':streamGenerateContent?alt=sse':':generateContent'),
   headers:{'x-goog-api-key':t.apiKey},
   body:drop({
    systemInstruction:system?{parts:[{text:system}]}:undefined,
    contents:turns.map(x=>({role:x.role==='assistant'?'model':'user',parts:imageParts(x.content,'gemini')??[{text:x.text}]})),
    generationConfig:drop({temperature:num(body?.temperature),topP:num(body?.top_p),maxOutputTokens:maxTokens,stopSequences:stops(body?.stop)}),
   }),
  };
 }
 return {
  url:base+'/messages',
  headers:{'x-api-key':t.apiKey,'anthropic-version':ANTHROPIC_VERSION},
  body:drop({model:t.model,max_tokens:maxTokens??4096,system:system||undefined,messages:turns.map(x=>({role:x.role,content:imageParts(x.content,'anthropic')??x.text})),temperature:num(body?.temperature),top_p:num(body?.top_p),stop_sequences:stops(body?.stop),stream:body?.stream===true?true:undefined}),
 };
}

export function buildEmbeddings(provider:Provider,base:string,t:Target,body:any):Outgoing{
 if(provider==='openai')return {url:base+'/embeddings',headers:{authorization:'Bearer '+t.apiKey},body:{...body,model:t.model}};
 const inputs:string[]=(Array.isArray(body?.input)?body.input:[body?.input]).filter((x:unknown)=>typeof x==='string');
 const model=t.model.replace(/^models\//,'');
 return {
  url:geminiBase(base)+'/models/'+encodeURIComponent(model)+':batchEmbedContents',
  headers:{'x-goog-api-key':t.apiKey},
  body:{requests:inputs.map(s=>drop({model:'models/'+model,content:{parts:[{text:s}]},outputDimensionality:t.dimension}))},
 };
}

const finish=(r?:string|null)=>!r?null:/^(STOP|end_turn|stop_sequence|stop)$/i.test(r)?'stop':/^(MAX_TOKENS|max_tokens|length)$/i.test(r)?'length':'content_filter';
const completion=(model:string,content:string,reason:string|null,usage?:{prompt:number;completion:number})=>({
 id:'chatcmpl-'+crypto.randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),model,
 choices:[{index:0,message:{role:'assistant',content},finish_reason:reason??'stop'}],
 ...(usage?{usage:{prompt_tokens:usage.prompt,completion_tokens:usage.completion,total_tokens:usage.prompt+usage.completion}}:{}),
});
export class EmptyCompletion extends Error{}

// Non-streaming vendor reply -> OpenAI chat.completion.
export function chatJson(provider:Provider,j:any,model:string){
 if(provider==='gemini'){
  const c=j?.candidates?.[0],content=(c?.content?.parts??[]).map((p:any)=>typeof p?.text==='string'?p.text:'').join('');
  if(!content)throw new EmptyCompletion();
  const u=j?.usageMetadata;
  return completion(model,content,finish(c?.finishReason),u?{prompt:u.promptTokenCount??0,completion:u.candidatesTokenCount??0}:undefined);
 }
 const content=(j?.content??[]).map((p:any)=>p?.type==='text'?String(p.text??''):'').join('');
 if(!content)throw new EmptyCompletion();
 const u=j?.usage;
 return completion(model,content,finish(j?.stop_reason),u?{prompt:u.input_tokens??0,completion:u.output_tokens??0}:undefined);
}

export function embeddingsJson(j:any,model:string){
 const list:number[][]=(j?.embeddings??[]).map((e:any)=>e?.values).filter(Array.isArray);
 return {object:'list',model,data:list.map((embedding,index)=>({object:'embedding',index,embedding})),usage:{prompt_tokens:0,total_tokens:0}};
}
export const embeddingLength=(provider:Provider,j:any)=>provider==='openai'?j?.data?.[0]?.embedding?.length:j?.embeddings?.[0]?.values?.length;

// Streaming vendor SSE -> OpenAI chat.completion.chunk SSE.
export function chatStream(provider:Provider,body:ReadableStream<Uint8Array>,model:string):ReadableStream<Uint8Array>{
 const enc=new TextEncoder(),dec=new TextDecoder(),id='chatcmpl-'+crypto.randomUUID(),created=Math.floor(Date.now()/1000);
 const chunk=(delta:Record<string,unknown>,reason:string|null=null,usage?:Record<string,number>)=>enc.encode('data: '+JSON.stringify({id,object:'chat.completion.chunk',created,model,choices:[{index:0,delta,finish_reason:reason}],...(usage?{usage}:{})})+'\n\n');
 let buffer='',reason:string|null=null,usage:{prompt:number;completion:number}|undefined,started=false,sentText=false;
 const handle=(data:any,out:(b:Uint8Array)=>void)=>{
  let piece='';
  if(provider==='gemini'){
   const c=data?.candidates?.[0];
   piece=(c?.content?.parts??[]).map((p:any)=>typeof p?.text==='string'?p.text:'').join('');
   if(c?.finishReason)reason=finish(c.finishReason);
   const u=data?.usageMetadata;if(u)usage={prompt:u.promptTokenCount??0,completion:u.candidatesTokenCount??0};
  }else{
   if(data?.type==='content_block_delta'&&data.delta?.type==='text_delta')piece=String(data.delta.text??'');
   else if(data?.type==='message_start'&&data.message?.usage)usage={prompt:data.message.usage.input_tokens??0,completion:usage?.completion??0};
   else if(data?.type==='message_delta'){if(data.delta?.stop_reason)reason=finish(data.delta.stop_reason);if(data.usage)usage={prompt:usage?.prompt??0,completion:data.usage.output_tokens??0};}
  }
  if(!started){started=true;out(chunk({role:'assistant',content:''}));}
  if(piece){sentText=true;out(chunk({content:piece}));}
 };
 const drain=(final:boolean,out:(b:Uint8Array)=>void)=>{
  const lines=buffer.split('\n');buffer=final?'':lines.pop()??'';
  for(const line of lines){
   const l=line.replace(/\r$/,'');if(!l.startsWith('data:'))continue;
   const payload=l.slice(5).trim();if(!payload||payload==='[DONE]')continue;
   try{handle(JSON.parse(payload),out);}catch{/* ignore malformed keep-alive lines */}
  }
 };
 const reader=body.getReader();
 return new ReadableStream<Uint8Array>({
  async pull(controller){
   // Keep reading until something is enqueued: a pull that enqueues nothing would never be called again.
   let enqueued=0;const out=(b:Uint8Array)=>{enqueued++;controller.enqueue(b);};
   try{
    for(;;){
     const {value,done}=await reader.read();
     if(!done){buffer+=dec.decode(value,{stream:true});drain(false,out);if(enqueued)return;continue;}
     drain(true,out);
     if(!sentText)controller.error(new EmptyCompletion());
     else{
      out(chunk({},reason??'stop',usage?{prompt_tokens:usage.prompt,completion_tokens:usage.completion,total_tokens:usage.prompt+usage.completion}:undefined));
      out(enc.encode('data: [DONE]\n\n'));controller.close();
     }
     return;
    }
   }catch(e){controller.error(e);}
  },
  cancel(){return reader.cancel();},
 });
}
