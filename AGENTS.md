# CoworkerLLM

- Independent Node.js 24 gateway extracted from the owner’s inno-coworker-saas gateway. LiteLLM is reused as the model protocol and routing engine; preserve its license and pinned upstream provenance.
- Preserve native provider conversions, scope routing, streaming cancellation and metadata-only usage records.
- Credentials, model configuration, keys and usage databases belong to ignored runtime/ or parent .local/. Never commit binary attachments or customer prompts.
- Every inference route authenticates, binds space identity to the credential and reserves quota transactionally before egress. Unknown usage retains the reservation.
- Run npm test and npm run check; commit and push this repository before parent submodule pointers.
