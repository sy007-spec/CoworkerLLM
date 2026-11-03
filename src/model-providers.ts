// Model endpoints must be HTTPS hosts on an allow-list (prevents server-side requests to internal addresses).
// The built-in list covers common OpenAI-compatible providers; operators may add hosts with MODEL_ALLOWED_HOSTS.
export const DEFAULT_MODEL_HOSTS=[
 'api.openai.com','api.anthropic.com',
 'generativelanguage.googleapis.com', // Google Gemini (OpenAI-compatible endpoint)
 'openrouter.ai','api.groq.com','api.mistral.ai','api.together.xyz','api.x.ai',
 'api.deepseek.com','dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','open.bigmodel.cn','api.moonshot.cn','api.siliconflow.cn','ark.cn-beijing.volces.com',
];
export function allowedModelHosts(extra=process.env.MODEL_ALLOWED_HOSTS??''){
 return [...new Set([...DEFAULT_MODEL_HOSTS,...extra.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)])];
}
export const MODEL_PRESETS=[
 {name:'Google Gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta',example:'gemini-flash-latest'},
 {name:'OpenAI',baseUrl:'https://api.openai.com/v1',example:'gpt-4o-mini'},
 {name:'DeepSeek',baseUrl:'https://api.deepseek.com/v1',example:'deepseek-chat'},
 {name:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1',example:'openai/gpt-4o-mini'},
];
// Only OpenAI itself is known to accept every OpenAI-specific request field; for other providers send the portable subset.
export function compatFor(baseUrl:string){
 if(new URL(baseUrl).hostname==='api.openai.com')return undefined;
 return {supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:false,supportsUsageInStreaming:false,maxTokensField:'max_tokens' as const};
}
