# Model Prompt Cache

## Ownership

Provider infrastructure owns actual prompt-cache content. Omni Agent owns a small control
plane whose successful lease baseline can survive Session resume:

```text
Model call identity + cache intent
  -> capability resolver
  -> default cache policy
  -> ModelCacheCoordinator
  -> stable scope and semantic fingerprint
  -> Provider cache options
  -> normalized cache report
```

Session JSONL remains the durable source of truth for Transcript and Environment records.
Context remains an ephemeral model projection. Neither subsystem imports the Models cache
runtime. App persists one optional, derived lease sidecar beside Context state; it never
changes the Session JSONL schema or attempts to persist Provider cache content.

## Policy and scope

Primary calls prefer long retention by default and fall back to short when the Provider does
not support long retention. Native Provider contributions declare model-specific cache
capabilities. Compatible endpoints may enable long retention only through an explicit
compatibility declaration. Auxiliary calls default to no cache; the Context checkpoint summary
call explicitly requests none. An explicitly requested long retention is never silently
downgraded to short.

The stable scope hashes Agent, Session, Provider, catalog model, request model, and cache
semantics version. A new Session or model selection therefore creates a new scope, while
ReAct calls in one Session reuse it. Raw identity values are not exposed as Provider keys.

Native Providers own their model-specific capability rules. Compatible protocols use validated
compatibility flags and never infer long-retention support from an endpoint URL:

| Capability source    | Mode                | Retention and scope facts                                           |
| -------------------- | ------------------- | ------------------------------------------------------------------- |
| Native Provider      | Provider-owned      | Model-specific and normalized before use                            |
| Compatible Anthropic | explicit breakpoint | 5-minute short; long only with `supportsLongCacheRetention`         |
| Compatible OpenAI    | automatic prefix    | Provider-managed short; long only with `supportsLongCacheRetention` |
| Compatible Google    | automatic prefix    | Provider-managed short; no stable Provider scope; unknown TTL       |
| Compatible Mistral   | automatic prefix    | Provider-managed short with stable prompt-cache key; unknown TTL    |
| Custom/unknown       | none by default     | An explicit, validated capability may opt in                        |

The native OpenAI contribution consumes catalog compatibility metadata such as
`supportsExplicitPromptCacheMode` and `supportsLongCacheRetention`; it does not maintain a
model-name allowlist or classify endpoints by URL.

Capability normalization, cross-field validation, and copying have one owner. Disabled
capabilities can declare only `none`; a TTL is legal only when its retention is supported.
Stable scope support is retention-aware through `stableScopeRetentions`, because pi-ai may
consume `sessionId` for one retention but not another. Configured compatible providers may
set only the validated pi-ai compat subset supported by their selected protocol.

## Fingerprints and lifecycle

Fingerprints are Provider-independent semantic evidence, not a claim about byte-level
Provider cache keys. They cover the system prompt, ordered tools, each ordered model
message, model selection, request-facing model, model settings, request-header digest,
and cache semantics version. Credentials, timeouts, retries, cancellation, timestamps,
and model-call IDs are excluded.

The current Environment is one of those ordered model messages, ahead of conversation
history. An unchanged Environment therefore preserves the same cacheable request prefix; a
changed fingerprint replaces that one complete entry and is classified through the normal
prefix-rewrite lifecycle. Environment refresh never initiates a separate model call and does
not create cache state outside the existing coordinator.

The runtime compares the previous successful fingerprint in a fixed order and reports
`cold`, `incompatible`, `expired`, `rebased`, `append_only`, `tail_changed`, or
`prefix_rewritten`. Provider `cacheRead` and `cacheWrite` usage is observational evidence
and never changes the deterministic classification.

Only successful primary cache-enabled calls replace state. Failed, cancelled, and auxiliary
calls do not destroy the previous baseline. The LRU stores at most 256 small entries containing
digests, applied retention, and known expiry; it lazily removes known-expired entries and
clears on runtime disposal. It never stores request bodies, credentials, or raw headers.

After each successful primary cache-enabled call, App atomically writes only the latest lease
for that Session to `<sessionsRoot>/<agentId>/context/<sessionId>/cache-lease.json`. Resume
hydrates this baseline before the Context rewrite guard is created. The sidecar reuses the
Context lock, corrupt-file quarantine, and clear lifecycle. Missing, invalid, expired, or
unreadable state degrades to `cold`; persistence errors are diagnostic-only. The snapshot
contains only `scopeId`, semantic fingerprint digests, retention, and optional `expiresAt`.

The fingerprint, LRU entry, Provider cache DTO, and inner transport event/options are
Models implementation details. The transport event contract excludes cache reports, so
only `CacheAwareModelRuntime` can publish cache lifecycle observations. When retention is
`none`, Provider scope metadata is omitted as well as caching being disabled.

The coordinator also exposes a read-only lease advisor. It classifies the current scope
as `disabled`, `cold`, `active`, `expired`, or `unknown_expiry`. Inspection neither
promotes an LRU entry nor removes an expired entry, so it cannot consume the lifecycle
classification of the next model call. Unknown Provider TTLs remain unknown.

## Extension boundary

`model_cache_report` is the read-only hook for logs, metrics, harnesses, and future UI.
It carries identity correlation, capability, lifecycle, counts, token usage, and reason,
but no prompt or message content. The existing stream event system is reused; there is no
parallel cache observer framework.

App adapts lease advice to the business-independent Context rewrite guard. Context sees
only `allow/defer`, never cache capabilities or TTLs. Known active leases may delay Micro
projection; unknown expiry is never guessed, and Heavy compression is never blocked.
Stable replay keeps subsequent projected prefixes identical. `model_cache_report`
remains the post-call evidence for `prefix_rewritten`, `append_only`, and Provider token
usage.

Future cache breakpoint strategies and complete request snapshots must be added as
separate consumers. They must not move Provider semantics into Context or durable cache
state into Session JSONL.

## Cache hit display metric

Models Cache is the sole owner of the user-visible Provider token cache hit calculation:

```text
totalPromptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
cacheHitRate       = cacheReadTokens / totalPromptTokens
```

Cache writes contribute to the denominator but are not hits. Cache-disabled calls,
auxiliary calls, failed/cancelled calls, and zero usage report an unknown rate. Values come
only from pi-ai normalized `input`, `cacheRead`, and `cacheWrite` usage; Omni never reparses
Provider responses. When normalized prompt usage is positive, an upstream `cacheRead` value
of zero is a real 0% result. The CLI correlates a successful report to
`contextSnapshotId` and displays only the last successful primary model call beside the
matching Context occupancy. It never estimates cache hit from common-prefix message counts,
and cache-hit reports themselves are not restored from the lease sidecar.
