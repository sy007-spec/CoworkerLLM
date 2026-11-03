# Source provenance

Initial native gateway modules and regression tests were extracted from the owner-supplied repository `sy007-spec/inno-coworker-saas`, commit `971ce3c35ef69aa9efe45f8a1a64b5162f82093a`. This private application does not assert an open-source license over those modules.

New governance and protocol functionality is maintained here. LiteLLM is reused through its pinned official container as the protocol, provider and routing engine. Its source is https://github.com/BerriAI/litellm at v1.106.6; the open-source engine is MIT licensed. No LiteLLM source files are copied into this repository. Dependency license notices remain in their packages.
