// Extracted URL normalization; SaaS agent invocation is not part of the gateway.
export const isGeminiNative=(baseUrl:string)=>{try{return new URL(baseUrl).hostname==='generativelanguage.googleapis.com';}catch{return false;}};
// Accepts ".../v1beta", ".../v1beta/openai" (the old preset) or the bare host and returns ".../v1beta" (or ".../v1").
export function geminiBase(baseUrl:string){
 const u=new URL(baseUrl);let p=u.pathname.replace(/\/+$/,'').replace(/\/openai$/,'');
 if(!/\/v1(beta)?$/.test(p))p='/v1beta';
 return u.origin+p;
}
