# Omni Agent Architecture

## Layers

```text
packages/core   Agent execution kernel
packages/models Model runtime, vendor catalog, provider plugins, and credentials
packages/app    Application lifecycle and extension host
packages/tools  Domain-neutral tool implementations
packages/cli    Terminal host and composition root
agents/*        Independently packaged business agents
```

Allowed workspace dependencies:

```text
tools -> core
models -> core
app -> core, models
agents/* -> app, core, tools
cli -> app, core, tools, agents/*
```

Core and app must not import a concrete agent. Agent packages must not import the
CLI or another agent package. Domain tools stay with their owning agent; only
domain-neutral tools may be promoted to `packages/tools`.

## Models and providers

Core exposes only the stable `ModelRuntimePort`, `ModelContextMessage`, and `ModelEvent`
contracts. `packages/models` owns the application-scoped provider collection,
provider construction, authentication persistence, and protocol conversion at the
runtime boundary. The concrete backend library is an implementation detail.
Interactive API keys and refreshed OAuth credentials are persisted through keytar.
Process variables, the project `.env`, and `~/.omni-agent/.env` are read-only
fallback sources. Model configuration and Provider definitions must never contain
plaintext keys, tokens, authorization headers, or passwords.

The application classifies model access vendor-first:

```text
ModelSelection -> VendorRegistry -> VendorPlugin -> ModelRuntime -> Provider
```

A vendor may expose several connections backed by distinct providers. Model
catalogs remain provider-owned and are queried at runtime. Trusted extensions may
contribute a `VendorPlugin`. `defineVendor()` composes connection specifications;
each connection delegates construction to a native, compatible, or transport
Provider Factory strategy. A genuinely new protocol implements the stable
`ModelTransport` port.
Compatible providers can supply an abortable `fetchModels` callback without exposing
backend-library types; the runtime owns catalog publication and persistence.
Provider objects are sealed inside an opaque `ProviderContribution`. Backend
transport types never cross into Core, App, CLI, agent packages, or extension
contracts. A second
global adapter registry or a protocol switch in Core is forbidden.

Agent-facing settings use a constrained JSON Schema Draft-07 subset. Schemas are
admitted and compiled once with Ajv when a plugin is registered; model selection
reuses the compiled validator. Ajv never coerces, defaults, removes, or otherwise
modifies input. Domain validators separately enforce provider IDs, HTTP endpoints,
environment-variable names, and unique model IDs.

The models package is organized by technical responsibility rather than backend
library or individual model name:

```text
packages/models/src/
  cache/        prompt-cache policy, semantic fingerprints, bounded state, and runtime decorator
  runtime/      ModelRuntime and message/event conversion
  providers/    one directory per vendor; custom protocols and shared provider mechanics
    openai/ anthropic/ google/ mistral/ deepseek/ qwen/ openrouter/ moonshot/
    volcengine/ zhipu/
    custom/      backend-neutral unknown-protocol contract and stream adapter
    factories/   native, compatible, and transport connection strategies
    shared/      provider model mapping shared by factory strategies
  vendors/      vendor contracts, registry, selection resolver, and plugin transactions
  credentials/  credential contracts, keychain persistence, and environment lookup
  catalog/      provider model-catalog persistence
  config/       layered Provider repository and definition-to-plugin loader
  schema/       agent-facing schema admission and compiled validation
  storage/      atomic JSON persistence owned by the models package
```

Provider implementations must live in their owning vendor directory. The
`providers/index.ts` file is composition-only: it may aggregate built-in vendor
plugins but must not contain provider construction, model definitions, or
vendor-specific request logic. Providers are never split into directories by
individual model name.

## System prompt contributions

The Coding Agent owns its base prompt. Core supplies domain-neutral contributors for the working
directory, project rules, and the Skill index. Project rules and Skill XML declare their authority
and task scope explicitly: neither can override runtime safety, expand the user's requested scope,
or grant permissions. Web search results retain source URLs when they support important conclusions.

All prompt contribution limits use the same UTF-8-aware text estimator as Context budgeting.
Project rules, the Skill index, loaded Skill bodies, and the complete stable prompt each have one
explicit budget. Exceeding a budget raises `PromptContributionBudgetError`; content is never
silently truncated and there is no alternate unbounded assembly path. Runtime-only loop-protection
sections remain owned by `RuntimePromptComposer` and are still included in the final Context token
estimate before dispatch.

## Prompt cache ownership

Prompt cache content is remote Provider state. Omni Agent owns only cache intent,
stable scope, semantic fingerprints, lifecycle classification, and usage observation.
It does not persist prompt bodies or treat Session JSONL as a cache store.

```text
Session resume
  -> App ModelCacheLeaseRepository
  -> CacheAwareModelRuntime hydrate

PreparedModelContext
  -> CacheAwareModelRuntime
       -> capability resolution
       -> default cache policy
       -> semantic request fingerprint
       -> bounded in-memory state
       -> concrete ModelRuntime
  -> pi-ai Provider adapter
  -> remote Provider prompt cache

Successful primary cache report
  -> App ModelCacheLeaseController
  -> cache-lease.json
```

`CacheAwareModelRuntime` decorates the transport runtime at the App composition
boundary. The Agent loop supplies only model-call identity and a cache intent. It does
not create scope IDs, inspect TTLs, compare request prefixes, or persist cache state.
The concrete Models runtime receives only transport execution options and maps the
resolved scope and retention to `pi-ai` `sessionId` and `cacheRetention`; Provider-specific `cache_control` and
`prompt_cache_key` fields remain backend implementation details. Only the cache
decorator can emit `cache_report`; the inner transport event contract excludes it.

Cache state contains only SHA-256 digests, applied retention, and known expiry. It is
bounded to 256 scopes and is cleared with the Models runtime. App persists at most one
successful primary baseline per Session in the existing Context sidecar directory, without
changing Session JSONL; missing, corrupt, or expired state degrades to `cold`. Lifecycle
classification is deterministic: incompatible request semantics, known expiry, static-prefix
rebase, append-only history, last-message replacement, whole-history rebase, then other prefix
rewrites.

Primary model calls prefer confirmed long retention and fall back to short when unsupported.
Native Provider contributions own model-specific capability declarations. Compatible endpoints
must explicitly declare long-retention support. Auxiliary calls are cache-disabled unless they
explicitly request a supported retention. Unknown custom transports are cache-disabled; a custom
transport may declare a capability explicitly. Cache reports are read-only stream events
correlated by model-call and Context snapshot IDs. Context and Session modules do not import cache
runtime implementations.

Native capability resolution is owned by Provider contributions and may consume catalog model
metadata. Compatible transports use the catalog model's API and validated pi-ai compatibility
flags; endpoint URLs are not capability signals. Stable scope support is declared per retention.
Capability validation and copying have one Models-layer owner.
Fingerprints, bounded state, and transport execution contracts are internal implementation
details rather than Models package exports.

`ModelCacheCoordinator` is the sole owner of cache policy, capability resolution,
fingerprinting, state, and successful-baseline updates. Its read-only lease advisor
reports `disabled`, `cold`, `active`, `expired`, or `unknown_expiry` without consuming a
lifecycle result or updating the LRU. App maps that model-cache fact to the generic
`ContextRewriteGuardPort`. Context sees only `allow` or `defer`; it never imports cache
types or guesses Provider TTLs. A known active lease may defer Micro projection, while
unknown TTLs do not create guessed delays and the 90% Heavy gate is never deferred.

Stable projection makes the first Micro advance an intentional prefix rewrite and keeps
later requests append-only against the new projected prefix. Cache breakpoints and
complete request snapshots remain future work. See [`docs/model-cache.md`](model-cache.md).

## Extensions

Concrete agents enter an application through a declarative `AgentExtension`.
The extension manager validates all contributions before committing them and
rolls back tools, agents, and commands when activation fails.
Provider contributions participate in the same transaction and are removed and
disposed in reverse registration order when activation fails.
Middleware contributions are stored by the extension manager in two independent
registries. Context middleware transforms only a detached `ContextDraft`; lifecycle
middleware observes a detached completed model call or wraps authorized tool execution.
`ToolInvocationRunner` invokes tool middleware only after authorization. Unregistering
an extension removes both middleware kinds in reverse registration order. Runtime
middleware accepts only its current declared members; Context mutation belongs solely to
`contextMiddleware.transform`.

Each installed Agent exports an `AgentBlueprint`. The application-scoped
`AgentFactory` is the only assembly entry point: it validates the blueprint,
builds and registers its extension, resolves the effective model, restores the
Agent's Session, and creates an isolated `AgentApplication`.

The App-owned Workspace module canonicalizes the CLI launch directory, selects
the nearest Git root when present, and derives a stable path-based workspace ID.
It owns only workspace identity, manifest initialization, and storage layout.
The CLI resolves one `WorkspaceContext` and passes it into `AgentFactory`; Core,
the TUI, and concrete Agents do not derive workspace identity or construct Session
paths. Global configuration, credentials, permissions, and global extensions remain
shared. Transcript and Context state are isolated under
`~/.omni-agent/workspaces/<workspaceId>/sessions/<agentId>/`.

Optional extensions can be exported from `~/.omni-agent/extensions.mjs` and the
current project's `omni.extensions.mjs`. They merge by extension manifest ID,
with the project definition replacing the matching global definition. Local
extension code is trusted local code and is not sandboxed.

## Host interaction surface

Core defines `InteractionSurfacePort` as the sole structured foreground-interaction
contract. It accepts serializable single-select, multi-select, text, and explicit-action
fields and returns a structurally validated response. It does not understand approval,
commands, clarification, focus, terminal layout, or persistence.

Request-level `title`, `detail`, `message`, `tone`, `dismissLabel`, `status`, and
`completionStatus` are presentation hints. A Host may render them using native UI, but
must not interpret them as policy or alter stable field, option, and action IDs.

```text
PermissionGate -> ApprovalBroker ------------┐
Command -> TuiCommandInteractionAdapter ------+-> InteractionSurfacePort
request_user_input -> clarification adapter --┘             |
                                                        CLI TUI Surface
```

`AgentFactory` lends one host-owned Surface to each Blueprint. The factory and Blueprint
do not own or dispose it, and non-interactive hosts receive `RejectingInteractionSurface`,
which fails with `interaction_unavailable` instead of guessing an answer or waiting
forever. The CLI owns `TuiInteractionSurface`, its single foreground slot, focus and input
handoff, abort listeners, and disposal. Nested requests fail with `interaction_busy`.

Permission, Command, and clarification retain independent adapters and validation:
the Surface never grants permission, maps command values, or decides whether a question
is required. Escape is a neutral `dismissed` response; each adapter maps it to deny,
escape, or skipped respectively. Interaction presentation is process-local. Session
history persists the ordinary tool call/result pair, not an editable widget or pending
Promise. Cross-process pending-interaction recovery is intentionally unsupported.

Tests that consume the Surface reuse `ScriptedInteractionSurface` from the test-only
`@omni-agent/core/testing` subpath. It records validated requests and returns queued,
validated responses without adding a second production interaction implementation.

## Layered configuration

Global configuration under `~/.omni-agent` is the baseline. Files in the
current project root form the override layer:

- `omni.config.json`: stores a shared default model and optional
  `agents.<agent-id>.model` overrides. Resolution order is project Agent,
  global Agent, project shared, then global shared.
- `omni.providers.json`: vendors merge with global
  `~/.omni-agent/providers.json` by vendor ID and connections merge by
  connection ID; a matching project connection replaces the global connection
  as one atomic value.
- `omni.extensions.mjs`: extensions merge with global
  `~/.omni-agent/extensions.mjs` by manifest ID.
- `.env`: process variables win, then the project file, then global
  `~/.omni-agent/.env`.

Each layer is validated independently before merging. A present but invalid
project file is an error and never triggers a silent global fallback. Secrets do
not participate in configuration merging; keytar remains the credential source
of truth. Runtime assembly consumes only the validated effective result and does
not create a second execution path.

OpenAI-compatible connections use the portable `system` role by default;
reasoning capability never implies `developer` role support. Native Provider
factories retain their own authoritative capabilities. The compatible contract
does not expose a speculative role switch; a provider-owned exception should be
introduced only when a verified endpoint requires one.

## Runtime invariants

`AgentRunner` receives exactly one `ModelRuntimePort` through its constructor.
There is no legacy execution branch, global runtime setter, static model
registry, or API key in `AgentConfig`. Runtime configuration accepts only the
validated `OmniConfig` structure. The global file may carry an internal
storage-version marker owned by the CLI; that marker is not part of the project
configuration contract.
The default CLI preserves the existing command, tool, event, and TUI behavior.

Agent packages expose an `agentBlueprint` from their package root. The CLI keeps
static loaders only for built-in Agents so the distribution bundler can discover
them; other IDs resolve `@omni-agent/agent-<id>` through standard Node module
resolution, first from the CLI installation and then from the package-manager-neutral
`~/.omni-agent/agents/node_modules` root. The CLI requests only the exact package name;
it does not scan packages or maintain an Agent registry. Every blueprint passes to the single `AgentFactory`. `pnpm dev`
selects `coding` by default, while `pnpm run dev -- run <id>` selects another
installed Agent package through the same run runtime.

Each `AgentApplication` owns an `AgentSessionRepository` constructed with an
explicit `agentId`. Session indexes and JSONL histories live under
`~/.omni-agent/workspaces/<workspaceId>/sessions/<agentId>/`; the Repository
restores the latest Session on startup and creates a Session only when the directory
is empty or `/new` is requested. Model providers, catalogs, and credentials remain shared
infrastructure; model selection may be overridden per Agent. Prompts, tools,
capabilities, Runner, Session, and mutable runtime state remain instance-local.

## Local tracing and replay

See [Runtime Observation and Local Trace](./tracing.md) for scoped lifecycle, capture, processor,
and compatibility contracts.

Tracing is an optional, Agent-scoped diagnostic capability built as three explicit layers:

```text
Core Runtime Observation SPI
        |
        v
Core Trace Processing
        |
        v
App Store / Query adapters -> CLI Preview
```

Runtime code depends only on typed, scoped Observation handles. Run, Turn, Context, Model,
Tool Batch, Tool Call, authorization, preflight, and execution scopes report readonly facts at
their authoritative execution points. They do not know span names, replay kinds, storage,
OpenTelemetry, or an observability vendor. Observation methods are synchronous, fail-open, and
cannot alter inputs, results, authorization, scheduling, cancellation, or exceptions.

Trace Processing is the sole owner of translating Runtime facts into span conventions and replay
records. `SpanRuntimeObserver` and `ReplayRuntimeObserver` are independent consumers combined by
`CompositeRuntimeObserver`; a failing consumer degrades to a Noop child without disabling the
other. Noop Observation keeps the Runtime path transparent when capture is absent.

Core separately retains `TracerPort`, `SpanPort`, `ReplaySinkPort`, and `TraceControlPort` for
Trace processors. The Runtime Observation SPI is a Host composition boundary exposed through
`@omni-agent/core/host`, not Core's default Agent-facing entry point or `AgentBlueprintContext`.
Concrete Agents receive no Trace capability and retain the unchanged Blueprint construction
contract.

App creates one `AgentScopedTraceRuntime` per `AgentFactory` instance. That runtime supplies local
recording adapters, controls capture independently for each Agent, owns fail-open persistence,
implements the narrow `AgentRunObservationPort` consumed by `AgentApplication`, and exposes only a
control-and-inspection capability to the CLI Host. The CLI owns `/trace`; concrete Agents do not
register or import Trace commands.

```text
CLI Host command
        |
        v
TraceControlPort
        |
AgentRunObservationPort -- begin immutable Run capture lease
        |
AgentApplication -- execute the Run with generic Observation
        |
Runtime Observation scopes -- typed, read-only execution facts
        |
CompositeRuntimeObserver
        +--> SpanRuntimeObserver ----> TracerPort ----> local span lifecycle store
        +--> ReplayRuntimeObserver --> ReplaySinkPort -> local replay and payload store

App local query factory --> TraceQueryPort --> loopback-only CLI Preview server --> browser
```

The observability data classes are intentionally separate:

- Stream events are the live product presentation contract.
- Session JSONL is the durable conversation source of truth.
- Span lifecycle records explain causal structure and duration.
- Replay records preserve sanitized model and tool payloads for historical and live inspection.
- Logs and future metrics correlate through `agentId`, `sessionId`, `runId`, `traceId`,
  `modelCallId`, `batchId`, and `toolCallId`; they do not replace the other stores.
- Runtime middleware, tool lifecycle adapters, and permission observers remain separate because
  they have different control or domain semantics.

Local Trace data lives at `~/.omni-agent/traces/<agentId>/<sessionId>/<runId>/`. A versioned
manifest records workspace provenance for collision checks, but the viewer navigates by the
selected Agent, Session, and Run rather than exposing Workspace as another product dimension.
Each Run owns append-only span and replay JSONL, with oversized replay payloads split into ordered
UTF-8 parts. Session discovery reconciles Run manifests from disk; the Agent-level index is a
rebuildable optimization, not business truth.

Capture is off by default. The shared Core sanitizer removes credential-shaped fields while
preserving operational metrics before payloads reach local persistence. A bounded write queue
keeps Runtime non-blocking; lifecycle records take priority over streamed detail, and overload
degrades capture with diagnostics plus a persisted Run-summary dropped-record count. Trace write
failures never alter model, permission, tool,
Stream, or Session behavior. The local viewer is read-only, listens only on `127.0.0.1`, validates
Host and identifiers, disables caching and framing, applies a restrictive Content Security Policy,
and loads no external resources. Host-owned `omni trace clear <agentId>` is the only deletion path
and rejects active captures.

`TraceQueryPort` is the stable local query boundary. App owns the concrete store, layout, query,
and maintenance adapters and exposes only factories for CLI composition. A future OpenTelemetry
span exporter, remote replay sink, desktop viewer, or metrics adapter can attach below Trace
Processing without adding a parallel Agent-loop, tool-execution path, or generic Runtime event
bus.

## Context engineering and data ownership

Model context is an ephemeral projection, not the Session transcript. The runtime has
three explicit ownership layers and a business-independent policy hook:

```text
SessionSnapshot
  -> WorkingConversation
  -> Agent Context Input Adapter
  -> ContextConversationSource
  -> detached ContextDraft
  -> Context middleware
  -> ContextEnvelope
       -> fixed Environment context
       -> ContextHistoryFrame
  -> ContextPolicyPipeline
       -> Agent and Extension policy stages
       -> StableMicroCompressionStage
            -> Artifact Projection
            -> optional Skill Projection
            -> Thinking Projection
       -> mandatory ContextFinalGatePort
            -> HeavyCheckpointGateStage
  -> Context assembly
  -> ModelContextMessage
  -> PreparedModelContext
  -> ModelRuntimePort
```

`AgentSessionRepository` owns a strict JSONL stream of typed `SessionRecord` values:
ordinary Transcript messages and Environment snapshots. It returns a detached
`SessionSnapshot` containing pure conversation messages plus only the latest Environment,
and maintains a process-local revision for the active Session. There is no legacy reader,
migration, or format fallback. `WorkingConversation` owns one Agent run and returns all new
records through the terminal `produced` path. It has no Repository, Context, or model dependency.

Transcript and model messages are distinct semantic contracts. `TranscriptMessage`
retains timestamps, usage, diagnostics, response IDs, errors, deferred state, tool-result
details, and routing metadata. `ModelContextMessage` contains only model-visible content,
tool-call pairing, and the routing fields needed for continuing an assistant response.
The system prompt remains a separate request field and is never represented as a
transcript message.

Mutable runtime facts are not Transcript messages. App captures
a normalized workspace/date/timezone/platform/architecture/shell snapshot before each
user-message append, and Core refreshes it before each primary model preparation. Identical
fingerprints produce no Environment Record, no environment-specific revision advance, and no
extra write; changes produce a complete `environment` Session Record rather than a diff.
Pre-run Environment and user records are committed in one append. Session JSONL retains every
replacement for audit. Context carries the latest snapshot in the fixed side of a
`ContextEnvelope`, structurally outside middleware, compression, and checkpoints.

Each stateless primary model request contains exactly one rendered Environment user-context
entry ahead of history. It is not stable system-prompt text, does not become a Transcript
message, and does not trigger an additional model call. Its token cost and fingerprint are
included in Context estimates and request digests. Tool execution binds to the `cwd` from the
same record used for the requesting model call. Mid-run replacements use the existing terminal
`produced` persistence path rather than a parallel incremental Session write. Snapshot
normalization, real calendar/IANA validation, fingerprinting, and prompt-budget validation
complete before persistence. Failures are structured, stop the affected run, and never reuse a
stale capture. The Node host provider uses `unknown` only when the shell cannot be identified.

The only Agent-to-Context boundary is `agent/contextInput.ts`. It copies a
`WorkingConversationSnapshot` into a Context-owned `ContextConversationSource` and
projects executable `RegisteredAgentTool` values into pure `ModelToolSpec` definitions.
Consequently the Context Engine's public request does not reference Working Conversation
or executable tools.

The Context module is contained under `packages/core/src/context`:

```text
contracts <- policy, checkpoints, compression, assembly
policy <- runtime
```

Micro compression is a stable projection rather than a Session mutation. A Context
sidecar stores only versioned projection records and content-addressed artifacts. The
composite Micro stage replays existing records on every preparation. Above the dynamic
admission threshold, one read-only Tool Cycle index protects call/result integrity and every
strategy returns independently estimated candidates. A pure selector orders candidates by
information-loss class and net token savings, selecting only enough to reach a recovery target
with an 8,000-token/5% headroom. If the safe candidates cannot reach that target, no rewrite
occurs. Built-ins remain Artifact, optional Skill, and capability-gated Thinking; no central
tool-name switch exists.

```text
ContextHistoryFrame
  -> stable replay
  -> pressure admission
  -> Tool Cycle index
  -> Strategy assessments
  -> minimum sufficient candidate selector
  -> ContextRewriteGuardPort
  -> selected Strategy projections
  -> one atomic projection commit
  -> mandatory Heavy final gate
```

Artifact eligibility is based on the shared token estimator rather than character count. Only
complete, successful, already-consumed, text-only Tool Cycles can be externalized, and the
latest three eligible cycles remain inline. Pending, malformed, failed, unconsumed, image, and
mixed-content results remain visible. Capability-approved old Thinking is lower-loss than a
recoverable Artifact or Skill reference, so it cannot be starved by strategy registration
order. Projection state remains keyed by stable strategy identifiers rather than fixed slots.
Runtime model capabilities and cache leases are resolved from the current Agent model on every
preparation. The final Heavy checkpoint gate remains mandatory and cannot be blocked by Micro
policy.

The Session Repository does not know the Context sidecar. `ContextSidecarLayout`, the
projection/checkpoint repositories, and lifecycle cleanup are composed in App. Physical
co-location under the Agent Session directory does not imply shared ownership.

The contract dependency direction is strictly one-way:

```text
data -> messages -> model contracts -> context -> agent -> app composition
```

Contracts do not depend on implementation layers. `ContextPolicyPipeline` is a generic
Hook: it serially executes detached stages, validates outputs, propagates cancellation,
re-estimates tokens, and records decisions. It has no dependency on compression or
checkpoint implementations. Public stages receive only identity, the current estimate,
and cancellation. Raw source messages, middleware digests, and upstream stage manifests
are reserved for the required `ContextFinalGatePort`. An Agent or Extension may add
pre-gate stages; the App composition root appends the built-in Stable Micro composite
and separately injects the mandatory Heavy Checkpoint gate. There is no post-gate
extension point or alternate Full History runtime path. Below all thresholds the
pipeline preserves full history unchanged.

The Engine never reads a Session, saves a checkpoint, or directly calls a model. Concrete
compression stages depend only on explicit token estimator, artifact store, checkpoint
store, and summary generator ports. The App owns the ModelRuntime summary adapter and
sidecar repositories.

Every ownership boundary copies arrays, message objects, content blocks, tool arguments,
diagnostic data, tool-result details, and model-visible schemas. TypeScript
`DeepReadonly` prevents accidental mutation in extension contracts, while runtime copies
provide the actual isolation. Micro Strategy calls also receive detached frame, state,
candidate, and estimate values; replay changes without matching persisted projection records
fail closed. Immutable scalar and image-data strings may be shared.

Executable `RegisteredAgentTool` values remain in the tool-call path. The Agent adapter
projects them to `ModelToolSpec`, which contains only name, description, schema, and
strictness before Context preparation begins. `PreparedModelContext` and `ModelRequest` therefore cannot expose tool
execution, authorization, timeout, or host policy to a Provider.

Assembly owns the single `TranscriptMessage` to `ModelContextMessage` projection plus the
projection of Context-only checkpoint and artifact entries. Checkpoints are emitted only
as tagged model-context user entries and never enter Session JSONL. The manifest records
identities, middleware and policy-stage versions, before/after estimates, checkpoint
lineage, message counts, decisions, and stable SHA-256 digests; it contains no message
text. A `model_context_prepared` event exposes it without adding it to the Session.

Compression uses `usableInputBudget = contextWindow - requestedOutputTokens`. The catalog's
`modelMaxOutputTokens` is only a capability ceiling; Models resolves a distinct per-call
`requestedOutputTokens` budget (16,384 by default, capped by the model and context window),
and the same value is sent to the Provider and recorded in the Context manifest. Stable Micro uses
the dynamic warning-buffer threshold documented below. The mandatory Heavy gate starts at
90%, limits its internal summary to 10% of usable input, and targets a post-checkpoint
context at or below 50%. It preserves
complete recent user/tool groups and fails the request after at most two summary attempts;
it never silently restores full history or hard-truncates content.

All Context consumers share one conservative estimator: ASCII and non-ASCII UTF-8 bytes
have separate ratios and message/tool structures contribute explicit overhead. Heavy
summary input is projected to a Context-owned semantic DTO that excludes Transcript-only
metadata, Thinking bodies, and raw image bytes. Stable HTML-safe JSON prevents historical
text from closing prompt delimiters. Prompt v2 requires one strictly validated structured
summary; plain prose is not a valid checkpoint.

The Heavy partition and frozen summary request are created once. A retry receives the
same request object, including the same prompt, coverage, model-call identity, output
budget, and cancellation signal. Preflight capacity, cancellation, and persistence errors
do not enter the retry loop. There is no alternate prompt, retry partition, mechanical
summary, or Full History fallback.

Session JSONL remains the sole transcript source of truth. Context state is physically
co-located but logically isolated under
`workspaces/<workspaceId>/sessions/<agentId>/context/<sessionId>/`: `checkpoints.json` stores the parent-linked
checkpoint chain, `projections.json` stores derived Context projections, `cache-lease.json`
stores the latest successful primary model-cache baseline, and `artifacts/toolResults/`
stores content-addressed large tool results. Context owns checkpoints, projections, and
artifacts; the App Models cache layer owns the cache lease. Dedicated repositories own only
their own schemas and cannot clear one another's data.
`ContextSidecarLifecycle` is the single owner of whole-Session Context cleanup. Corrupt
sidecars are quarantined and rebuilt from the Transcript. Its shared Session lock lives
outside the deletable sidecar directory, so cleanup remains mutually exclusive until it
finishes. Session clear is coordinated by the Application through that lifecycle
component.

Checkpoint append validates records and parent lineage while holding that same Context
Session lock. Parent records must already exist, coverage must strictly increase, exact
duplicates are idempotent, and conflicting IDs fail without replacing the sidecar.
Checkpoint summaries remain unescaped at rest; XML escaping is owned exclusively by the
final Context-entry projection, so stored digests and model-visible markup cannot diverge.

Heavy-summary semantic evaluation is offline release infrastructure, not a runtime Context
stage. Its versioned Transcript fixtures pass through the production source projection and Prompt
builder, including long-history pressure cases. Each report records one model identity and binds
results to Corpus and Evaluation Contract digests; the latter covers the Prompt, source projection,
encoding, validator protocol, evaluator schema, and metrics. Deterministic checks cover protocol,
fact-level recall, exact identifiers, false completion, field-specific state/next action, and
injection canaries. Manual review is mandatory for fabrication, semantic injection, and all other
semantic failures. No report can establish quality for another contract, corpus, or model, and no
evaluation runner or judge call is reachable from AgentLoop.

`ModelRuntimePort` receives only `ModelContextMessage` and `ModelToolSpec`. The Provider
mapper creates a new backend Context, deep-copies content, arguments, deferred state, and
schemas, and adds backend-library transport placeholders such as `timestamp: 0` and zero
usage. Those placeholders do not leak back into the model-domain message contract.

See [`docs/context-engineering.md`](context-engineering.md) for extension contracts and
the lifecycle migration.

Core composes model prompts in three layers: the Agent-owned base prompt, stable
runtime-owned policy sections, and one-shot runtime guidance. The runtime composer never
mutates the base prompt or durable conversation. Tool-enabled Agents receive the stable
tool-loop policy; detected repetition produces ephemeral guidance for the next request.
Loop rules, prompt wording, and enforcement remain separate responsibilities under
`packages/core/src/loop-protection` and `packages/core/src/system-prompt`.

Loop protection is created per `runAgentLoop` call and covers every tool routed through
the coordinator, including extension tools and structured validation or authorization
errors. It uses stable result signatures and trailing batch-cycle rules without knowing
concrete tool names. A hard halt waits for the full tool batch, emits a structured error,
and returns all produced messages for persistence. Coding has no fixed model-turn limit;
`maxTurns` is unlimited when omitted and remains available to Agents such as financial
analysis that deliberately configure a finite bound.

Keytar is the credential source of truth. Its non-secret credential index is
derived state; writes use provider-scoped serialization and compensation, while a
corrupt index is quarantined and reconciled from known active provider IDs.
Environment files are parsed without mutating `process.env`.

## Runtime permissions

The complete and authoritative runtime contract is in
[`docs/tool-call-runtime.md`](tool-call-runtime.md). This section records only the
cross-package boundary.

Every tool call crosses one authorization path before execution:

```text
AgentLoop -> ToolCallCoordinator -> schema validation -> domain preflight
                                   -> ToolAuthorizationRouter
                                      |-> trusted -> authorized call
                                      `-> permission -> PermissionGate -> authorized call
          -> lifecycle -> ToolInvocationRunner -> host or sandbox-eligible execution
```

Core owns the stable authorization and permission contracts, `ToolCallCoordinator`,
`ToolAuthorizationRouter`, `PermissionGate`, and `ToolInvocationRunner`. The
coordinator is the AgentLoop's only tool-call entry. The router admits explicitly
trusted internal tools without consulting permission state and delegates all other
tools to the gate. The runner accepts only authorized calls and routes execution from
the tool's explicit strategy. Authorization and execution strategy are independent.
Concrete risk assessment stays with the owning technical domain in `packages/tools`:
one Shell analysis entry, the Tree-sitter Bash adapter, its permission-specific `ShellProgram`,
and command classifiers live with the Bash tool, while filesystem and search tools map shared
path-security facts into their own permission presentations.
Cross-domain path normalization, workspace-boundary checks, and sensitive-path
definitions remain pure shared security primitives. The app
owns the default policy, Agent-scoped permission service, and atomic persistence.
The CLI supplies the approval broker and renders approval prompts. No layer
dispatches permission behavior through a central switch on tool name.

The default modes are `standard` and `supervised`. Standard mode permits routine
workspace reads and writes but asks before ordinary process execution.
Supervised mode also asks before writes. Assessments separately describe operational
impact (`risk`) and the domain operation category (`operationClass`). Routine package
operations may use an existing Agent/tool/scope grant. Bash persistent approval identifies
one literal executable and deliberately does not classify its subcommands or dynamic ordinary
arguments for persistence. Static sensitive-path, destructive, privileged, and hard-stop
assessments cannot consume that scope. Compound commands and nested substitutions expose one
requirement for each known executable, including targets resolved through supported wrappers.
Unresolved executables and unsupported syntax cannot expose persistent scopes. Multiple
executable identities use
all-of matching: all existing grants allow execution, while one approval can atomically add
only the missing executable scopes. Every call is reassessed before scope lookup, so stored
state cannot override those boundaries. Constraining behavior inside an approved CLI is a
future sandbox responsibility.

Tree-sitter handles Shell syntax once; the tools-local semantic IR is recursively analyzed for
command, path, effect, uncertainty, and approval facts. A bounded context tracks static cwd,
literal variables, and security effects carried by known variables without attempting to model
general command output. Bash execution rejects command-local shell startup injection and removes
`BASH_ENV`, `ENV`, and exported Bash functions from the host environment so startup hooks cannot
invalidate the analyzed command graph. PATH target replacement remains a documented sandbox
boundary.

Filesystem path approval remains domain-owned. Ordinary external files may consume a
canonical parent-directory read or write scope, while sensitive reads may consume only an exact-file
scope. Read/write and tool identities remain isolated. Sensitive-path classification runs before scope matching, so a directory grant never
silently includes `.env`, credential locations, system paths, or symlink targets that resolve
into those locations. Core treats filesystem scope keys as opaque alternatives and does not
parse paths.

Filesystem and search tools use optional domain preflight before authorization to reject
missing, dangling, special, or wrong-kind targets without presenting an unusable approval.
The execution implementation repeats the target-state check after approval to protect the
later execution boundary; Core does not interpret path facts.

Permission state is stored in `~/.omni-agent/permissions.json`, keyed by Agent, stable
tool origin, and opaque approval scope. Updates use an inter-process lock and atomic JSON
replacement.
Invalid state fails closed to supervised behavior with no automatic approvals.
Approval presentations and diagnostic events exclude raw tool input and file
contents.

Authorization and execution are separate tool-definition strategies. A trusted
internal capability such as `skill_read` or deterministic indicator computation
bypasses permission state but still crosses schema validation, lifecycle,
middleware, cancellation, and structured result handling. Filesystem, search, web,
and Bash tools carry domain-owned dynamic assessors. Bash alone is currently marked
`sandbox_eligible`; this marker does not grant permission and does not imply that a
sandbox implementation exists.

Permissions are policy and interaction, not an operating-system security
boundary. Local extensions remain trusted code, and a spawned process can still
perform behavior that static command analysis cannot observe. `SandboxRunnerPort`
is an optional execution backend injected into `ToolInvocationRunner`; it receives
only tools declared `sandbox_eligible`. Host tools, including Skill loading and
deterministic in-memory computation, are never routed to it. No OS-level sandbox
implementation is included yet. A future sandbox runner may enforce eligible calls
at the OS boundary, but it must not own Agent modes, TUI interaction, or persistent
approval rules.

Every tool declares a required timeout strategy: `none`, runtime-owned `fixed`, or
schema-bound `input`. The invocation runner starts a deadline only after approval and
`beforeExecute` middleware. A timeout aborts the linked execution signal, permits a
bounded cooperative cleanup window, and suppresses all late results. Bash and grep
share one host-process runner; file and web tools retain domain-specific I/O behavior.
Linked cancellation, timers, and late settlement observation are isolated in the
runner-owned `ExecutionDeadlineSupervisor`.

Filesystem tools share canonical path resolution, snapshot/version checks, an
in-process path/inode mutex, text validation, streaming line reads, and direct writes.
`file_read` exposes versioned continuation data in both structured metadata and
LLM-visible text, including byte continuations for oversized UTF-8 lines. It defaults
to 500 lines, accepts explicit limits up to 2,000, and remains bounded by 64 KiB.
`file_edit`
and `file_write` prepare complete content in memory and call the shared writer once.
They deliberately do not implement temporary-file replacement or recovery, so a
failed direct overwrite has an unknown target state. The detailed contract and
residual risks are documented in `docs/tool-call-runtime.md`.

Search navigation remains in the tools layer. Glob reports stable paths and file sizes;
grep parses ripgrep JSON into file size, line, column, and bounded preview facts. Both
publish the facts in structured metadata and LLM-visible text. The coding Agent chooses
file-read ranges from those facts; search tools do not invoke file reads, and file reads
do not consume hidden search state.

## Stream presentation boundary

User-visible streaming follows one direction:

```text
Tool / Context / Model Cache
  -> immutable Core event DTO
  -> StreamSession callbacks
  -> CLI StreamPresentationRouter
  -> feature presenters
  -> pure ViewModel
  -> generic TUI component
```

Core owns event facts and never terminal wording. The CLI presenters own correlation,
labels, sanitization, bounded formatting, and responsive metrics. `DisclosureMessage`
only renders `DisclosureViewModel`; it does not import Agent packages, App services,
Context decisions, tool names, or compression kinds. AgentLoop bridges Context progress
through an asynchronous queue while `prepare()` is pending. It neither classifies
compression nor calculates cache metrics.

AgentLoop also bridges model-runtime facts into Core events. `packages/models` normalizes
provider streams so text present in a completed response has already been emitted as
`text_delta`; Core does not reconstruct transport events from the completed message. Model text
deltas carry the opaque `modelCallId` of their originating call and a `textSegmentId` that stays
stable only across contiguous text deltas. Thinking lifecycle events end the active text segment,
so presentation consumers preserve content order without interpreting provider payloads. When a
successfully completed assistant response containing text will end the Agent loop rather than enter
tool execution, AgentLoop emits
`final_response(modelCallId)` before `done`. Presentation consumers use that identity to
mark the matching text node as final; they must not infer final content from event order,
`done`, or the last rendered component. The CLI run presentation model owns stable
nodes and projects process, final, and metrics regions. TUI components render that
projection and retain only local interaction state such as whether the process region is
expanded.

File tools publish a generic canonical resource reference in transient tool-result
presentation metadata. The ToolCall boundary removes that presentation field before
forming Transcript details, preserving the Session JSONL contract. A collapsed tool card
therefore needs only a path; its bounded, sanitized input and captured result are formatted
only on first expansion. Expansion never reads the filesystem again.

One Assistant `toolUse` response defines one Tool Batch. Core emits an immutable batch
descriptor, correlated child positions, and one completion event; it does not infer a
batch from timing. Tool definitions may declare a bounded semantic invocation preview
using an action, resource kind, and input key. This declaration is validated at tool
registration and excluded from `ModelToolSpec`. Tools never provide terminal wording.

The CLI `ToolBatchPresenter` applies Composite presentation: a single visible tool keeps
its existing disclosure, while two or more visible tools become one progressively updated
group. The collapsed group previews the currently executing operation and its elapsed
time. Expanding it renders the existing child disclosures, which remain independently
clickable and lazy. Skill-owned calls may be claimed by `SkillStreamPresenter` and are
excluded from the generic group without changing the Core batch. Batch events and preview
facts never enter Session, Working Conversation, Model Context, or Provider requests.

Context compression publishes a single lifecycle per Context preparation. Micro and Heavy
stages report only domain operations to a Pipeline-owned collector; the collector emits one
started event and one terminal completed/failed event. Micro starts only after a sufficient
candidate selection and rewrite-guard approval, and cannot complete before its atomic state
commit. Stable replay, threshold skips, insufficient candidates, cache deferral, and
no-candidate paths emit nothing. These events are observation-only and never enter Session,
Model Context, or checkpoint storage.

The CLI labels `inputTokens / usableInputBudget` as Context pressure because that is the
ratio used by Micro and Heavy. Wide rendering also shows `inputTokens / contextWindow` as
Window usage and keeps Cache hit beside it. Compression disclosures receive the triggering
input total, usable budget, and threshold from the immutable progress DTO; CLI never
recomputes compression policy or reads Context decisions.

Commands depend on Core's `CommandInteractionPort`, not a TUI type or `AgentConfig`.
Skill reload asks `AgentApplication.refreshInstructions()` to rebuild instructions; CLI
code does not mutate runtime configuration. Skill tool-event claiming lives exclusively
in `SkillStreamPresenter`, so generic Tool presentation contains no Skill special case.
