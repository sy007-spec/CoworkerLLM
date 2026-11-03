import {pathToFileURL} from 'node:url';
import path from 'node:path';
export const providerTemplates = [
  {
    "id": "openai",
    "label": "OpenAI",
    "provider": "openai",
    "apiBase": "https://api.openai.com/v1",
    "protocol": "OpenAI-compatible",
    "note": "填写账户可用模型ID。",
    "source": "https://developers.openai.com/api/reference/overview",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "gemini",
    "label": "Google AI Studio Gemini（原生）",
    "provider": "gemini",
    "apiBase": "",
    "protocol": "Gemini native",
    "note": "推荐留空地址；原生API为https://generativelanguage.googleapis.com/v1beta；支持Gemini多Key。",
    "source": "https://ai.google.dev/api/generate-content",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "gemini-openai",
    "label": "Google Gemini（OpenAI兼容）",
    "provider": "openai",
    "apiBase": "https://generativelanguage.googleapis.com/v1beta/openai",
    "protocol": "OpenAI-compatible",
    "note": "使用MODEL_API_KEY_1等通用Key字段。",
    "source": "https://ai.google.dev/gemini-api/docs/openai/",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "anthropic",
    "label": "Anthropic Claude（原生）",
    "provider": "anthropic",
    "apiBase": "",
    "protocol": "Anthropic native",
    "note": "推荐留空地址；原生API为https://api.anthropic.com/v1；Messages协议不能填入只接受OpenAI的客户端。",
    "source": "https://platform.claude.com/docs/en/api/overview",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "deepseek",
    "label": "DeepSeek",
    "provider": "openai",
    "apiBase": "https://api.deepseek.com",
    "protocol": "OpenAI-compatible",
    "note": "填写DeepSeek控制台当前可用模型ID。",
    "source": "https://api-docs.deepseek.com/",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "xai",
    "label": "xAI Grok",
    "provider": "openai",
    "apiBase": "https://api.x.ai/v1",
    "protocol": "OpenAI-compatible",
    "note": "模型ID和支持的调用能力以xAI控制台为准。",
    "source": "https://docs.x.ai/docs/api-reference",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "mistral",
    "label": "Mistral AI",
    "provider": "openai",
    "apiBase": "https://api.mistral.ai/v1",
    "protocol": "OpenAI-compatible",
    "note": "使用La Plateforme的API Key。",
    "source": "https://docs.mistral.ai/resources/migration-guides",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "groq",
    "label": "Groq",
    "provider": "openai",
    "apiBase": "https://api.groq.com/openai/v1",
    "protocol": "OpenAI-compatible",
    "note": "注意路径包含/openai/v1。",
    "source": "https://console.groq.com/docs/overview",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "together",
    "label": "Together AI",
    "provider": "openai",
    "apiBase": "https://api.together.ai/v1",
    "protocol": "OpenAI-compatible",
    "note": "使用当前官方.ai域名；模型ID可能包含组织名。",
    "source": "https://docs.together.ai/docs/inference/openai-compatibility",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "openrouter",
    "label": "OpenRouter",
    "provider": "openai",
    "apiBase": "https://openrouter.ai/api/v1",
    "protocol": "OpenAI-compatible",
    "note": "模型ID通常包含供应商前缀。",
    "source": "https://openrouter.ai/developers",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "huggingface",
    "label": "Hugging Face Router",
    "provider": "openai",
    "apiBase": "https://router.huggingface.co/v1",
    "protocol": "OpenAI-compatible",
    "note": "需要有Inference Providers权限的HF Token。",
    "source": "https://huggingface.co/docs/chat-ui/main/index",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "moonshot",
    "label": "Moonshot / Kimi 国际",
    "provider": "openai",
    "apiBase": "https://api.moonshot.ai/v1",
    "protocol": "OpenAI-compatible",
    "note": "Key与国际站账户匹配；中国站地址需以对应控制台为准。",
    "source": "https://platform.kimi.ai/docs/get-your-api-key",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "zai",
    "label": "Z.AI GLM 国际",
    "provider": "openai",
    "apiBase": "https://api.z.ai/api/paas/v4",
    "protocol": "OpenAI-compatible",
    "note": "通用API地址；Coding订阅专用地址不能混用。",
    "source": "https://docs.z.ai/guides/overview/quick-start",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "siliconflow",
    "label": "SiliconFlow 国际",
    "provider": "openai",
    "apiBase": "https://api.siliconflow.com/v1",
    "protocol": "OpenAI-compatible",
    "note": "Key与国际站匹配，不自动切换地区。",
    "source": "https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions",
    "requiresCustomBase": false,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "qwen-beijing",
    "label": "阿里云千问 / 百炼 北京",
    "provider": "openai",
    "apiBase": "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "protocol": "OpenAI-compatible",
    "note": "将WorkspaceId替换为控制台实际值；旧版DashScope账户使用控制台提供的兼容地址。",
    "source": "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
    "requiresCustomBase": true,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "qwen-singapore",
    "label": "阿里云千问 / 百炼 新加坡",
    "provider": "openai",
    "apiBase": "https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "protocol": "OpenAI-compatible",
    "note": "必须使用新加坡工作空间及其Key。",
    "source": "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
    "requiresCustomBase": true,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "qwen-us",
    "label": "阿里云千问 / 百炼 美国",
    "provider": "openai",
    "apiBase": "https://{WorkspaceId}.us-east-1.maas.aliyuncs.com/compatible-mode/v1",
    "protocol": "OpenAI-compatible",
    "note": "必须使用美国工作空间及其Key。",
    "source": "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
    "requiresCustomBase": true,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "azure-openai",
    "label": "Azure OpenAI v1",
    "provider": "openai",
    "apiBase": "https://{resource}.openai.azure.com/openai/v1",
    "protocol": "OpenAI-compatible",
    "note": "替换资源名；MODEL_NAME填写Azure部署名称，而不是基础模型名称。",
    "source": "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/switching-endpoints",
    "requiresCustomBase": true,
    "verifiedOn": "2026-11-03"
  },
  {
    "id": "custom",
    "label": "自定义 / 私有兼容网关",
    "provider": "openai",
    "apiBase": "",
    "protocol": "OpenAI-compatible",
    "note": "填写你授权使用的HTTPS兼容地址；云端地址不要填写localhost。",
    "source": "https://docs.litellm.ai/docs/providers/openai_compatible",
    "requiresCustomBase": true,
    "verifiedOn": "2026-11-03"
  }
] as const;
export function providerEnvHelp(){return '# MODEL_API_BASE为API根路径，不填聊天网页，不拼/chat/completions或模型ID。\n# MODEL_NAME以供应商控制台可用模型为准；模板不代表模型连通或账号已获授权。\n# 一个env文件只启用一组MODEL_TEMPLATE/MODEL_PROVIDER/MODEL_API_BASE；下列均为注释示例。\n# 多Key：MODEL_API_KEY_1/2/3；原生Gemini也可用GEMINI_API_KEY_1/2/3。\n'+providerTemplates.map(t=>'# ['+t.id+'] '+t.label+' | '+t.protocol+'\n# MODEL_TEMPLATE='+t.id+'\n# MODEL_PROVIDER='+t.provider+'\n# MODEL_API_BASE='+t.apiBase+'\n# '+t.note+'\n# 官方说明：'+t.source).join('\n\n')+'\n'}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href&&process.argv.includes('--env-help'))process.stdout.write(providerEnvHelp());
