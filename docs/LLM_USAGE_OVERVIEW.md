# 大模型、知识库与网关使用总览

状态日期：2026-11-08。本文只保存跨产品对比与网关采用情况；各产品的设计细则留在各自仓库，按下表链接查阅，不在此复制。

## 1. 问题与原则

三个产品都需要大模型，但接入路径各自演化：教学开源核心、教学托管平台、Coworker SaaS 各有一套模型配置与冷却规则，CoworkerLLM 已上线却未进入任何生产推理路径。本文让运营一眼看清“谁在用什么、谁负责、下一步决定什么”。

共同原则：密钥只在服务器受限文件或加密存储；失败不静默切换供应商；未知 token 显示未知，不推算费用；生成内容待人工审核后发布。

## 2. 现状对比（已核实）

| 维度 | TeachInPublic 独立站 | 教学托管平台 training.seii.top | Coworker SaaS |
|---|---|---|---|
| 代码 | [teach-in-public](https://github.com/sy007-spec/teach-in-public)（公开） | [top.seii.host.training](https://github.com/sy007-spec/top.seii.host.training)（私有，内含同一教学核心） | [inno-coworker-saas](https://github.com/sy007-spec/inno-coworker-saas)（私有） |
| 生产 | 47.84，`teach-in-public:9f11d1f` | 43.106，`seii-training-hosting:8d58657` | 47.84，`inno-coworker-saas` 全套容器 |
| 推理路径 | 课堂自有连接（DeepSeek、Gemini 池）直连供应商 | 课堂自有连接优先；Advanced 套餐的平台模型为 DeepSeek `deepseek-flash` 直连 | 自带内部 `llm-gateway`：对话、向量化、重排三类接入池，按平台→商户→空间解析；可选 ChatGPT/Codex 订阅授权 |
| 是否经 CoworkerLLM | 否 | 否（网关就绪，仅“全局大模型”管理页读写其模型目录） | 否（未迁移） |
| 知识库 | 单课程严格知识库：FTS5 + sqlite-vec，本地 multilingual-e5-small；引用 + 事实核验；课程/群讨论提炼为待复核卡片 | 同左 | 空间证据库（PostgreSQL FORCE RLS）；InnoData 完整检索（2026-10-25 起：BM25 + 1024 维 `qwen3.7-text-embedding` 向量 + `Qwen3-Reranker-8B` 重排，经内部网关；Wiki/图谱派生知识回填中），默认引擎；RAGFlow 0.22.1 按商户许可启用；飞书采集 |
| 用量账本 | 课堂内调用诊断与知识诊断 | 同左 + 平台模型按课堂月度用量降频 | 网关 `usage.sqlite` 不可变明细，平台/商户可查与导出 |
| 冷却 | 连接池：长冷却仅限密钥/计费/权限，其余 5 分钟退避 | 平台 DeepSeek：默认 300 秒冷却、300 秒探测；自有连接池同左（托管尚未部署该版本） | 失败直接报告，不自动换模型重试 |

产品设计与运营细则：教学两种形态见 [教学大模型与知识库运营方案](https://github.com/sy007-spec/top.seii.host.training/blob/main/docs/LLM_KNOWLEDGE_OPERATIONS.md)；Coworker 见管理库 [LLM与知识库总览](https://github.com/sy007-spec/InnoAgentManagement/blob/main/projects/inno-coworker-saas/docs/LLM与知识库总览.md)（产品仓库交付客户，运营与状态资料不放其中）。

## 3. CoworkerLLM 自身状态

- 部署：43.106，入口 `coworker-llm-gateway:c627268`，引擎 LiteLLM `v1.106.6`，PostgreSQL 17；仅回环 4400。2026-11-08 `healthz`、`readyz` 均 200（引擎已有模型目录；`readyz` 不含真实计费调用）。
- 已具备：虚拟密钥（模型范围、租户、月份绑定）、月度 token 上限或显式不限额、并发与速率限制、按模型接入的健康冷却（默认 24 小时，10 分钟探测）、19 个供应商模板。
- 未发生：任何生产产品的推理请求经由本网关；因此没有真实网关用量证据。

## 4. 待决事项

| 编号 | 决定 | 推荐及成立条件 | 责任 |
|---|---|---|---|
| G1 | 教学托管平台模型是否切回 CoworkerLLM | 需要多供应商路由、统一计量时切换：先在网关对 `training-author` 做真实调用，再取消 `HOSTING_LLM_PROVIDER=deepseek`；保留 DeepSeek 环境文件可回退 | 平台运营 |
| G2 | Coworker 是否迁移到 CoworkerLLM | 迁移前须对齐空间→商户作用域、向量维度与 ChatGPT 订阅授权；未对齐前保持内部网关 | Coworker 负责人 |
| G3 | 冷却口径统一 | 统一为“长冷却仅限密钥/计费/权限，其余短退避 + 真实探测”，各产品按此改造 | 各产品负责人 |
| G4 | 知识库向量来源不同 | 教学用服务器本地 E5-small（384 维，正文不外发）；Coworker 用网关上游 1024 维 Qwen 向量（资料片段发往供应商）。两者不共享索引；Coworker 更换向量模型或维度须整库重建 | 各产品负责人 |
