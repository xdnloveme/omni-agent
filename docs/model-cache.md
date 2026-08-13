# Model Prompt Cache

## Ownership

Provider infrastructure owns actual prompt-cache content. Omni Agent owns a small,
runtime-only control plane:

```text
Model call identity + cache intent
  -> capability resolver
  -> default cache policy
  -> stable scope and semantic fingerprint
  -> Provider cache options
  -> normalized cache report
```

Session JSONL remains the transcript source of truth. Context remains an ephemeral model
projection. Neither subsystem imports the Models cache runtime or persists its state.

## Policy and scope

Primary calls request short retention by default. Auxiliary calls default to no cache;
the Context checkpoint summary call explicitly requests none. Long retention requires an
explicit request and is never silently downgraded to short.

The stable scope hashes Agent, Session, Provider, catalog model, request model, and cache
semantics version. A new Session or model selection therefore creates a new scope, while
ReAct calls in one Session reuse it. Raw identity values are not exposed as Provider keys.

Known protocols resolve their capability centrally from the catalog model's API, base URL,
and compatibility flags:

| API protocol                 | Mode                | Retention and scope facts                                                                      |
| ---------------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| Anthropic Messages           | explicit breakpoint | 5-minute short; optional 1-hour long; affinity scope only when compat enables it               |
| OpenAI Responses/Completions | automatic prefix    | short; optional 24-hour long according to compat; stable key according to concrete API mapping |
| Google Generative AI         | automatic prefix    | short, no stable Provider scope, unknown TTL                                                   |
| Mistral Conversations        | automatic prefix    | short with stable prompt-cache key, unknown TTL                                                |
| Custom/unknown               | none by default     | an explicit, validated capability may opt in                                                   |

Capability normalization, cross-field validation, and copying have one owner. Disabled
capabilities can declare only `none`; a TTL is legal only when its retention is supported.

## Fingerprints and lifecycle

Fingerprints are Provider-independent semantic evidence, not a claim about byte-level
Provider cache keys. They cover the system prompt, ordered tools, each ordered model
message, model selection, request-facing model, model settings, request-header digest,
and cache semantics version. Credentials, timeouts, retries, cancellation, timestamps,
and model-call IDs are excluded.

The runtime compares the previous successful fingerprint in a fixed order and reports
`cold`, `incompatible`, `expired`, `rebased`, `append_only`, `tail_changed`, or
`prefix_rewritten`. Provider `cacheRead` and `cacheWrite` usage is observational evidence
and never changes the deterministic classification.

Only successful cache-enabled calls replace state. Failed and cancelled calls emit a
report without destroying the previous baseline. The LRU stores at most 256 small digest
entries, lazily removes known-expired entries, and clears on runtime disposal. It never
stores request bodies, credentials, or raw headers.

The fingerprint, LRU entry, Provider cache DTO, and inner transport event/options are
Models implementation details. The transport event contract excludes cache reports, so
only `CacheAwareModelRuntime` can publish cache lifecycle observations. When retention is
`none`, Provider scope metadata is omitted as well as caching being disabled.

## Extension boundary

`model_cache_report` is the read-only hook for logs, metrics, harnesses, and future UI.
It carries identity correlation, capability, lifecycle, counts, token usage, and reason,
but no prompt or message content. The existing stream event system is reused; there is no
parallel cache observer framework.

Future cache breakpoint strategies, cache-expiry-aware Micro compression, complete
request snapshots, and cache-safe Full compression must be added as separate consumers.
They must not move Provider semantics into Context or durable cache state into Session.
