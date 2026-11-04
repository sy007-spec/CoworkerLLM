# CoworkerLLM

Independent gateway extracted from the owner's Coworker gateway, with LiteLLM as its provider and routing engine. Training callers connect only to CoworkerLLM. This repository does not change the running Coworker SaaS deployment. See [source provenance](PROVENANCE.md).

## Capability matrix

| Capability | Implementation |
| --- | --- |
| Existing native chat, embedding/rerank, scope assignments, tests and streaming cancellation | Extracted Coworker modules, retained for caller migration |
| Additional providers, custom endpoints, model aliases, routing pools, retries/fallbacks, spend attribution, optional monetary budgets | Pinned LiteLLM engine with persistent PostgreSQL |
| Virtual keys, model allowlists, expiry, revocation and tenant binding | CoworkerLLM entrypoint plus engine virtual keys |
| Monthly token cap, atomic reservations, concurrency and rate limits | Durable SQLite governance ledger |
| Chat/Completions, text Responses, embeddings and rerank | Budgeted `/v1` entrypoints |
| Models, provider configuration and spend administration | Master-only `/engine/*` proxies to the internal engine API |
| Legacy administration | Original master-only `/v1/admin/*` configuration APIs |

The engine is reused without maintaining a fork. Enterprise-only upstream features are not unlocked by this integration. Multimodal images/audio, files, batch jobs and arbitrary engine APIs are not exposed to budgeted tenant keys. Training extracts document text before model inference. Text-only messages/input are required for strict token reservations.

Existing trusted SaaS caller credentials retain their original scoped behavior and bypass the virtual-key ledger. Never issue them to training tenants. Training exclusively uses virtual keys. The Coworker production callers have not been migrated by this release.

## Deployment

Node.js 24 is required. Run `npm ci`, `npm run check`, `npm test`, `npm run build`. Tests use synthetic providers and do not prove live model delivery.

Copy `.env.example` and `model-config.example.yaml` into private operator storage. Generate independent random secrets of at least 32 characters; set real model credentials in the private `MODEL_ENV_FILE`. Gateway data must be owned by UID 10001 with mode 700. PostgreSQL uses a dedicated persistent directory. Start with `docker compose --env-file /private/gateway.env -p coworker-llm up -d --build --wait`.

Only gateway loopback port 4400 is published. Engine and database have no published ports. Remote consumers require a TLS proxy. Runtime configuration, provider keys, caller credentials and usage databases never belong in Git. Back up PostgreSQL consistently with the gateway state and private configuration. Run one gateway process against its governance database; horizontally replicated independent ledgers are not supported.

LiteLLM is pinned to `ghcr.io/berriai/litellm:v1.106.6`. Verify its upstream image signature before first production installation. The model list is configured in the engine, using native provider identifiers or `openai/...` with a custom `api_base`. Master-only `/engine/model/new`, `/engine/model/info` and other engine APIs manage that configuration without revealing the engine master credential. Availability depends on the selected provider and credentials.

`GET /healthz` checks the entrypoint. `GET /readyz` checks the engine's configured model catalog; it does not perform a billed inference. A live provider call remains a separate acceptance check.

## Tenant keys and accounting

`POST /key/generate` requires the master bearer token:

```json
{
  "key_alias": "training-space-month",
  "models": ["training-author"],
  "max_tokens": 40000000,
  "token_month": "2026-11",
  "duration": "32d",
  "rpm_limit": 60,
  "max_concurrent": 8,
  "metadata": {"tenant": "11111111-1111-4111-8111-111111111111"}
}
```

Optional positive `max_budget` adds the engine's monetary cap. It requires PostgreSQL and accurately configured model prices. Training uses a token allowance without inventing a USD conversion. The plaintext tenant key is returned on creation; only its hash/policy are stored by the entrypoint. `GET /key/list` reports policies and token counters. `POST /key/delete` with `{ "id": "<key hash>" }` revokes entrypoint access; the internal engine must remain inaccessible to clients.

Reserve UTF-8 request bytes, requested output limit and framing allowance before inference. Settle completed reported input/output usage; retain the conservative reservation on failures, interruptions or missing usage. Retained amounts can exceed actual provider spend and are not an invoice. Rate-window tokens remain conservative reservations. Crash recovery does not return tokens; concurrency leases expire after five minutes. Deletion/revocation preserves usage history.

Months use Asia/Shanghai. Issue a new month-bound key each month; an old-month key cannot use the next month's quota. Tenant identity is bound to the key and cannot be changed by a request header. Governance stores metadata only; the supplied engine configuration disables message logging.

## Google AI Studio Gemini key pools

Use `gemini-pool.example.env` as a private input template: set `MODEL_PROVIDER=gemini`, the model ID available in AI Studio, and `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, etc. Native Gemini does not require `MODEL_API_BASE`. The older `MODEL_API_KEY` remains supported, as do numbered `MODEL_API_KEY_1` fields and comma-separated `MODEL_API_KEYS`. Duplicate key values are removed. Up to 64 unique keys are accepted.

After building, run `node dist/engine-config.js /private/input.env /private/models.yaml /private/models.env`. The output configuration uses environment references, never plaintext keys. Both output files are private (mode 600). Back up the previous files before replacement and recreate the engine container after updating them so its environment is refreshed. Do not merely restart after changing an env_file.

All entries share the same model alias (default `training-author`), with distinct deployment IDs. LiteLLM `simple-shuffle` balances requests across keys; it is not strict sequential round robin. Router retries are capped at two (or the pool size minus one), and unhealthy deployments use a 60-second cooldown. Pre-stream failure handling is delegated to the pinned engine; a partially emitted stream is never replayed by the application. All keys serve the same tenant model alias and token ledger, so rotating provider keys does not reset customer quotas.

Google applies rate limits per project rather than per API key. Keys in one project share the project's limits. Only configure keys and projects you are authorized to use. Real key validity, quota and provider delivery remain a separate acceptance check.

References: https://docs.litellm.ai/docs/routing and https://ai.google.dev/gemini-api/docs/rate-limits .

## Official provider templates

`src/provider-templates.ts` is the authoritative registry of provider IDs, protocols, official endpoint bases, regional/resource requirements and documentation URLs. `GET /providers/templates` exposes only this public metadata. The hosting admin page reads it dynamically; no second address registry is maintained there.

Copy [providers.example.env](providers.example.env) to private storage, choose `MODEL_TEMPLATE`, then fill the actual model/deployment ID and provider key(s). Leaving `MODEL_PROVIDER` and `MODEL_API_BASE` empty uses the selected template defaults. An explicitly supplied protocol must match. Workspace/resource placeholders must be replaced before generating configuration. Changing providers requires replacing their keys too; do not mix different vendors in one key pool. Addresses and account regions must match. Bedrock/Vertex IAM configurations require their provider-specific cloud credential setup and are not represented as a universal API-key base URL. Templates do not prove provider connectivity or model availability.

Regenerate the documented env comments after a registry update: `node dist/provider-templates.js --env-help`. Endpoint sources and verification date are retained in every entry.

A master-issued key may explicitly use `max_tokens: null` for usage-accounted access without a token-total cap. Omitting the field is still rejected. Model scope, tenant binding, expiry, revocation, RPM, TPM (when configured), concurrency and per-request limits remain enforced; existing numeric budgets are unchanged. This is not an availability guarantee.

Explicit unallocated keys support up to 20 inline PNG/JPEG/WebP image parts in chat messages, within the existing 8MB request bound. Remote image URLs and other media parts are rejected. Finite token-budget keys remain text-only; reservations and actual provider usage accounting apply to all accepted requests.
