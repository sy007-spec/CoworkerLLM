// Sensitive-content filter (PRD 3.3 "敏感内容", 7.3 external model boundary).
// Applied to text that is sent to a model or shown to a team as a derived summary, and to Git evidence before it is stored.
// The original Feishu/Lark message stays untouched in the evidence store; only derived and outbound text is filtered.
export const REDACTED='[已过滤敏感信息]';
const RULES:RegExp[]=[
 /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
 /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
 /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
 /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
 /\bsk-[A-Za-z0-9_-]{16,}\b/g,
 /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
 /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
 /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];
// user:password@host in connection strings keeps the scheme, user and host.
const URL_PASSWORD=/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi;
// "password: value", "api_key=value", "密码：值". The key word must be followed by a separator and a non-space value.
const LABELLED=/(密码|口令|密钥|令牌|passwd|password|pwd|secret|api[_-]?key|access[_-]?key|token)(\s*[:：=]\s*)(["']?)([^\s"'，。；;,]{3,})\3/gi;
export function redact(text:string):string{
 let out=text;
 for(const r of RULES)out=out.replace(r,REDACTED);
 out=out.replace(URL_PASSWORD,(_m,a:string,b:string)=>a+REDACTED+b);
 return out.replace(LABELLED,(_m,k:string,sep:string)=>k+sep+REDACTED);
}
export const hasSensitive=(text:string)=>redact(text)!==text;
