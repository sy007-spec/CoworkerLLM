import {describe,it,expect} from 'vitest';
import {llmGateway} from '../src/llm-gateway.js';
import {buildChat,buildEmbeddings,chatJson,chatStream,supports,EmptyCompletion} from '../src/llm-providers.js';

const target={apiKey:'k',model:'m1',dimension:3};
const body={messages:[{role:'system',content:'be brief'},{role:'user',content:'hi'},{role:'assistant',content:'hello'},{role:'user',content:[{type:'text',text:'bye'}]}],temperature:0.2,max_tokens:50,stop:'END'};

describe('request translation',()=>{
 it('maps OpenAI chat to Gemini generateContent',()=>{
  const o=buildChat('gemini','https://generativelanguage.googleapis.com/v1beta',target,body);
  expect(o.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent');
  expect(o.headers).toEqual({'x-goog-api-key':'k'});
  expect(o.body).toEqual({systemInstruction:{parts:[{text:'be brief'}]},contents:[{role:'user',parts:[{text:'hi'}]},{role:'model',parts:[{text:'hello'}]},{role:'user',parts:[{text:'bye'}]}],generationConfig:{temperature:0.2,maxOutputTokens:50,stopSequences:['END']}});
  expect(buildChat('gemini','https://generativelanguage.googleapis.com/v1beta/openai',target,{...body,stream:true}).url).toBe('https://generativelanguage.googleapis.com/v1beta/models/m1:streamGenerateContent?alt=sse');
 });
 it('maps OpenAI chat to Anthropic messages',()=>{
  const o=buildChat('anthropic','https://api.anthropic.com/v1',target,body);
  expect(o.url).toBe('https://api.anthropic.com/v1/messages');
  expect(o.headers).toEqual({'x-api-key':'k','anthropic-version':'2023-06-01'});
  expect(o.body).toMatchObject({model:'m1',max_tokens:50,system:'be brief',temperature:0.2,stop_sequences:['END'],messages:[{role:'user',content:'hi'},{role:'assistant',content:'hello'},{role:'user',content:'bye'}]});
  expect((buildChat('anthropic','https://api.anthropic.com/v1',target,{messages:[]}).body as any).max_tokens).toBe(4096);
 });
 it('pins the model on OpenAI-compatible providers and maps Gemini embeddings with the configured dimension',()=>{
  expect(buildChat('openai','https://x.test/v1',target,{messages:[],model:'other'}).body).toMatchObject({model:'m1'});
  const e=buildEmbeddings('gemini','https://generativelanguage.googleapis.com/v1beta',target,{input:['a','b']});
  expect(e.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/m1:batchEmbedContents');
  expect(e.body).toEqual({requests:[{model:'models/m1',content:{parts:[{text:'a'}]},outputDimensionality:3},{model:'models/m1',content:{parts:[{text:'b'}]},outputDimensionality:3}]});
 });
 it('knows which vendors offer which capability',()=>{
  expect(supports('anthropic','chat')).toBe(true);expect(supports('anthropic','embedding')).toBe(false);expect(supports('gemini','embedding')).toBe(true);
  expect(supports('gemini','rerank')).toBe(false);expect(supports('openai','rerank')).toBe(true);
 });
});
describe('response translation',()=>{
 it('maps Gemini and Claude replies to chat.completion',()=>{
  const g=chatJson('gemini',{candidates:[{content:{parts:[{text:'ab'},{text:'c'}]},finishReason:'MAX_TOKENS'}],usageMetadata:{promptTokenCount:2,candidatesTokenCount:3}},'m');
  expect(g.choices[0]).toMatchObject({message:{role:'assistant',content:'abc'},finish_reason:'length'});expect(g.usage).toEqual({prompt_tokens:2,completion_tokens:3,total_tokens:5});
  const a=chatJson('anthropic',{content:[{type:'text',text:'yo'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}},'m');
  expect(a.choices[0]).toMatchObject({message:{content:'yo'},finish_reason:'stop'});
  expect(()=>chatJson('gemini',{candidates:[{finishReason:'SAFETY'}]},'m')).toThrow(EmptyCompletion);
 });
 async function collect(provider:'gemini'|'anthropic',events:string[]){
  const src=new ReadableStream<Uint8Array>({start(c){for(const e of events)c.enqueue(new TextEncoder().encode(e));c.close();}});
  const text=await new Response(chatStream(provider,src,'m')).text();
  const chunks=text.split('\n\n').filter(Boolean).map(x=>x.replace(/^data: /,''));
  return {chunks,deltas:chunks.filter(x=>x!=='[DONE]').map(x=>JSON.parse(x).choices[0])};
 }
 it('converts a Gemini SSE stream, including events split across reads',async()=>{
  const e1='data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\r\n\r\ndata: {"candidates":[{"content":{"parts":[{"te';
  const e2='xt":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2}}\r\n\r\n';
  const {chunks,deltas}=await collect('gemini',[e1,e2]);
  expect(deltas.map(d=>d.delta.content).filter(Boolean).join('')).toBe('Hello');
  expect(deltas.at(-1)).toMatchObject({finish_reason:'stop'});expect(chunks.at(-1)).toBe('[DONE]');
 });
 it('converts an Anthropic SSE stream',async()=>{
  const ev=(type:string,d:object)=>'event: '+type+'\ndata: '+JSON.stringify({type,...d})+'\n\n';
  const {deltas}=await collect('anthropic',[ev('message_start',{message:{usage:{input_tokens:4}}}),ev('content_block_delta',{delta:{type:'text_delta',text:'Hi'}}),ev('content_block_delta',{delta:{type:'text_delta',text:'!'}}),ev('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:2}}),ev('message_stop',{})]);
  expect(deltas.map(d=>d.delta.content).filter(Boolean).join('')).toBe('Hi!');expect(deltas.at(-1)).toMatchObject({finish_reason:'stop'});
 });
 it('fails the stream when the vendor produced no text',async()=>{
  const src=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('data: {"candidates":[{"finishReason":"SAFETY"}]}\n\n'));c.close();}});
  await expect(new Response(chatStream('gemini',src,'m')).text()).rejects.toBeTruthy();
 });
});
describe('gateway with vendor upstreams',()=>{
 const callers={saas:'key'};
 function run(provider:'gemini'|'anthropic',reply:unknown,path:string,over:Record<string,unknown>={}){
  const seen:{url:string;headers:Record<string,string>;body:any}[]=[];
  const base=provider==='gemini'?'https://generativelanguage.googleapis.com/v1beta':'https://api.anthropic.com/v1';
  const app=llmGateway({config:()=>({chat:{provider,baseUrl:base,apiKey:'up-key',model:'m'},embedding:{provider,baseUrl:base,apiKey:'up-key',model:'e',dimension:3}}),callers:()=>callers,hosts:['generativelanguage.googleapis.com','api.anthropic.com'],fetchImpl:(async(url:any,init:any)=>{seen.push({url:String(url),headers:init.headers,body:JSON.parse(init.body)});return Response.json(reply);}) as typeof fetch});
  const post=(b:unknown)=>app.request('/v1/'+path,{method:'POST',headers:{authorization:'Bearer key','content-type':'application/json'},body:JSON.stringify({...(b as object),...over})});
  return {post,seen};
 }
 it('serves OpenAI-shaped chat from Gemini and hides the vendor key from callers',async()=>{
  const {post,seen}=run('gemini',{candidates:[{content:{parts:[{text:'ok'}]},finishReason:'STOP'}]},'chat/completions');
  const r=await post({messages:[{role:'user',content:'x'}]});
  expect(r.status).toBe(200);expect((await r.json()).choices[0].message.content).toBe('ok');
  expect(seen[0]!.headers['x-goog-api-key']).toBe('up-key');expect(seen[0]!.url).toContain('/models/m:generateContent');
 });
 it('serves OpenAI-shaped embeddings from Gemini and checks the dimension',async()=>{
  const ok=run('gemini',{embeddings:[{values:[1,2,3]},{values:[4,5,6]}]},'embeddings');
  const j=await (await ok.post({input:['a','b']})).json();expect(j.data.map((d:any)=>d.embedding)).toEqual([[1,2,3],[4,5,6]]);
  const bad=run('gemini',{embeddings:[{values:[1,2]}]},'embeddings');
  expect((await bad.post({input:'a'})).status).toBe(502);
 });
 it('serves chat from Claude and refuses embeddings it cannot provide',async()=>{
  const {post,seen}=run('anthropic',{content:[{type:'text',text:'claude says hi'}],stop_reason:'end_turn'},'chat/completions');
  expect((await (await post({messages:[{role:'user',content:'x'}]})).json()).choices[0].message.content).toBe('claude says hi');
  expect(seen[0]!.headers['x-api-key']).toBe('up-key');
  const emb=run('anthropic',{},'embeddings');
  expect((await emb.post({input:'a'})).status).toBe(501);expect(emb.seen).toHaveLength(0);
 });
});
