# Omni Agent Architecture

## Layers

```text
packages/core   Agent execution kernel
packages/network Target-scoped gateway, DNS policy, and authenticated loopback proxy
packages/models Model runtime, vendor catalog, provider plugins, and credentials
packages/app    Application lifecycle and extension host
packages/agent-host WebSocket Protocol v2 adapter for AgentServicePort
packages/tools  Domain-neutral tool implementations
packages/ui     User interaction and presentation surfaces
packages/cli    Commands and Agent use-case orchestration
apps/omni       Binary entry and composition root
apps/omni-game  Godot character, Session, and task UI
agents/*        Independently packaged business agents
```

Allowed workspace dependencies:

```text
tools -> core
network -> core
models -> core
app -> core, models
agent-host -> app
agents/* -> app, core, tools
ui -> app, core
cli -> app, core, tools, agents/*
apps/omni -> network, agent-host, app, core, tools, cli, ui
apps/omni-game -> WebSocket Protocol v2 only
```

Core and app must not import a concrete agent. Agent packages must not import the
CLI or another agent package. `packages/ui` owns interaction hosts, view models,
presentation code, browser assets, and terminal delivery. CLI and UI do not import
each other; `apps/omni` is the only package that composes both. UI must not create
Agents, load Blueprints, persist configuration, or branch on Agent identity.
Domain tools stay with their owning agent; only
domain-neutral tools may be promoted to `packages/tools`.

`packages/agent-host` owns only loopback WebSocket connection state, authentication, strict wire
validation, request correlation, bounded writes, heartbeat, and connection-created cancellation.
`AgentServicePort` is its only business interface. Catalog, Factory, Session, model, Tool, and
concrete Agent dependencies remain outside the package. `apps/omni` is the process owner that
composes those dependencies for the standalone `omni-host` entry.

`apps/omni-game` is a separate Godot application. Its concrete `AgentHostClient` connects directly
to Protocol v2 and owns only Socket, authentication, strict response parsing, request correlation,
and transport shutdown. `CharacterWorkspaceController` owns character, Session transition,
foreground Run, transcript, and screen state. Godot UI scenes depend on that Controller and never
access WebSocket or JSON. The game imports no Workspace package and does not create a Gateway Port,
Agent runtime, Session repository, or Tool path.

`apps/omni/src/game/GameBootstrap` is the parent process owner for development. It generates the
ephemeral Token, starts `omni-host` with the developer's original working directory, then starts the
pinned Godot project. Godot's project path never changes the Host Workspace. Bootstrap owns process
cleanup but has no access to `AgentServicePort`.

The headless entry shares `apps/omni/src/agent-service-composition.ts` with the WebSocket Host.
`packages/cli/src/headless/run.ts` owns one Session/Run invocation; Apps owns fresh task state,
explicit execution-mode initialization, OS signals, shared-resource disposal and native Trace
association. `benchmark/` is external evaluation tooling, not a production workspace package.
See [benchmark evaluation](benchmark-evaluation.md) for the process and artifact contract.

## Process and interaction lifecycle

`apps/omni` is the only process owner. It owns argv/cwd/home resolution, stdout and stderr,
exit-code mapping, SIGINT/SIGTERM registration, and the bounded graceful-shutdown deadline.
CLI returns use-case results and must not access `process` or `console` directly. UI owns prompt
and TUI lifecycles but receives termination through injected Host services.

A process termination is recorded once and propagated through both channels:

```text
SIGINT / SIGTERM
  -> ProcessTerminationController
       +-> AbortSignal -> onboarding/auth/confirmation prompts
       +-> subscription -> active or subsequently-created Agent Console
  -> ActiveAgentRun.close -> Application.dispose -> resource cleanup
```

The Console lifecycle is `created -> running -> closed`; termination before `start()` is retained
and returned without starting the terminal. Normal completion cancels the Host deadline. A second
signal, or expiry of the five-second graceful window, restores the first OS signal's default
termination behavior. This last boundary is required for native operations such as keychain calls
that cannot cooperate with JavaScript cancellation; App, CLI, and UI must not implement their own
force-exit paths.

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

## Isolated model execution

Models also provides a single-admission Unix socket transport through `ModelTransportRuntimePort`.
App's `AgentModelService` separates execution/selection from optional local `ModelAdministration`.
`CacheAwareModelRuntime` remains in the Agent process; the isolated server binds the existing
`ModelRuntime` to a configured selection and retains credentials and private headers. It does not
implement another provider stack or an HTTP forwarding proxy. Apps owns the headless client and
model execution process entries. A remote session rejects configuration changes rather than silently
falling back to local execution.

The server removes its listening socket before acknowledging the connection. Tool children do not
inherit the connected descriptor. Disconnection aborts provider work; a partially consumed stream
closes the session. Terminal transport boundaries are drained before exposing terminal events to the
cache wrapper. Protocol v1 is single-flight, with 16 MiB maximum JSON frames and socket backpressure.

Deployment owns network and process isolation. The benchmark adapter gives the solver no network
interface except loopback and uses a private volume for initial Unix socket admission; only the model
service has network and credentials. This is not an isolation boundary against trusted in-process
extensions or arbitrary code injection into the Agent process.

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
`ToolInvocationRunner` invokes tool middleware only after access control. Unregistering
an extension removes both middleware kinds in reverse registration order. Runtime
middleware accepts only its current declared members; Context mutation belongs solely to
`contextMiddleware.transform`.

Each installed Agent exports a strict `agent.yaml` Manifest and an `AgentBlueprint`.
`AgentPackageCatalog` validates Manifest identity, API compatibility, and the Blueprint descriptor
shape before normalizing both sources into `LoadedAgentPackage`. Manifest v2 owns static identity and the
declarative composition recipe. The Blueprint descriptor declares available components, while its
builder owns executable implementations and Agent-scoped resources. Neither Blueprint nor Module
may declare a second Agent ID.

`AgentFactory` remains the only public assembly entry point. Internally, assembly is explicit:

```text
LoadedAgentPackage
  -> AssemblyInputResolver
  -> immutable ResolvedAgentAssemblyPlan (data only)
  +  AgentAssemblyEnvironment (live dependencies only)
  -> AgentRuntimeAssembler + AssemblyTransaction
  -> AgentAssemblyEvidence -> per-Run frozen AgentAssemblySnapshot
  -> AgentApplication
```

The Resolver resolves effective model and source configuration. `AgentCompositionPlanner` is the
sole owner of composition semantics: it matches Recipe IDs to the Blueprint descriptor, expands
the ordered mixture of Tool bundles and individual Tools, validates ordering, duplicates, and
dependencies, and emits `ResolvedAgentComposition`. `AgentAssemblyPlanner` combines that value
with the resolved Runtime inputs. The resulting Plan contains frozen values and no Blueprint,
service, Host, Catalog, registry, or disposer. The Catalog
validates descriptor shape but never interprets Recipe semantics. Live dependencies travel
separately in `AgentAssemblyEnvironment` and are consumed only by the Assembler. Runtime assembly
mechanics remain behind `AgentFactory`; the data-only `AgentCompositionPlanner` is exported only so
CLI inspection and package-author tooling can validate composition without creating resources.

`omni agent create` is a CLI-owned code-generation use case, not another Runtime construction
path. Its pure template renderer emits the smallest supported Manifest-first Package; its
filesystem transaction creates only a previously absent target and cleans up a failed write. The
generated Package subsequently enters the same Catalog, Planner, Blueprint, and Assembler chain as
every other external Agent. The scaffolder must not register an Agent, edit Workspace configuration,
invent template-specific capabilities, or introduce a second Factory API.

Agent packages keep each component's data-only Descriptor beside its package-private Factory. The
public Blueprint Descriptor is derived from that component catalog; default selection remains
exclusively in `agent.yaml`. Bundles are explicit ordered lists, never discovery rules. CLI
inspection reuses the same `AgentPackageCatalog` and `AgentCompositionPlanner` for `describe`,
`validate`, and `plan` without calling
`Blueprint.build()` or creating Runtime resources.

This is Omni Agent's deliberately bounded adaptation of DeepSeek Harness composition: declarative
configuration corresponds to the Recipe, stable Ports remain capability seams,
`AssemblyTransaction` provides reversible ownership transfer, and Assembly Evidence exposes the
effective facts. Omni Agent does not adopt an everything-is-a-plugin kernel, configuration patches,
hot loading, or a general dependency injection container.

The Assembler passes the validated Manifest and resolved composition, plus injected `cwd` and
interaction, to the Blueprint. It never passes the original YAML source or asks the Blueprint to
interpret the Recipe. It verifies that the contributed Agent ID, Tool names and order, Skills
capability, and Artifact Recovery capability match the Plan.
Concrete Agents do not set `maxTurns`; long Runs end through cancellation, process signals, and the
existing Model/Tool timeout boundaries. The Assembler registers every acquired disposer immediately.
Failure rolls all acquired resources back in reverse order; normal ownership transfers to `AgentApplication`. Structured assembly errors
identify the Agent and failing stage while retaining the original cause. Rollback and application
disposal errors additionally identify each resource whose cleanup failed. Sources may discover and
load extensions, but only `ExtensionManager` may register runtime contributions.
`ExtensionManager` also completes every fallible Provider and Extension cleanup operation even when
an earlier cleanup fails. Activation rollback retains the activation error as its cause and reports
all cleanup failures by resource; normal unregistration uses the same cleanup semantics.

`ExtensionSourceLoader` is an independent Assembly Source Port, not a Host Runtime capability.
Source adapters translate ordered source references into candidates and diagnostics; they cannot
access registries. Required source failures stop assembly, while optional failures remain diagnostic.

Extension source identity and runtime identity are intentionally different facts. A source origin
identifies where code was loaded for diagnostics and assembly evidence. Tool identity is derived
from the stable extension manifest ID and tool name, so moving identical extension code between
global and workspace sources cannot change permission scope. The source origin never reaches a
runtime registry.

`AgentAssemblyEvidence` is the single owner of the current effective model, composition IDs,
Prompt digest, extensions, and exposed tools. Model changes and instruction refreshes update that evidence through
the same configuration transition that updates `AgentConfig`. Each Run captures one frozen snapshot
at start and uses it for both its running and completed Trace manifests; later configuration changes
cannot rewrite an earlier Run's evidence.

Assembly Snapshot and digest are audit-only facts. They never enter model-cache scope, fingerprint,
policy, or Provider cache keys; the cache remains derived from Agent/Session/Model identity and the
actual model request semantics.

The App-owned Workspace module canonicalizes the CLI launch directory, selects
the nearest Git root when present, and derives a stable path-based workspace ID.
It owns only workspace identity, manifest initialization, and storage layout.
The CLI resolves one `WorkspaceContext` and passes it into `AgentFactory`; Core,
the TUI, and concrete Agents do not derive workspace identity or construct Session
paths. Global configuration, credentials, execution settings, and global extensions remain
shared. Transcript and Context state are isolated under
`~/.omni-agent/workspaces/<workspaceId>/sessions/<agentId>/`.

Optional extensions can be exported from `~/.omni-agent/extensions.mjs` and the
current project's `omni.extensions.mjs`. They merge by extension manifest ID,
with the project definition replacing the matching global definition. Local
extension code is trusted local code and is not sandboxed.

## Agent package catalog and service Host boundary

`packages/app` owns two separate application boundaries:

```text
AgentPackageCatalog
  -> discover explicitly registered built-in Agent descriptors
  -> validate Manifest before executing package code
  -> load a validated Agent Package by exact ID

AgentService
  -> admit only Agents returned by Catalog.list()
  -> own one AgentInstance per open Session
  -> schedule Runs and expose a Host-neutral event stream
  -> cancel, close, and dispose instances it created
```

The default Catalog factory remains in `packages/cli` because it is the adapter that knows the two
concrete built-in packages (`coding` and `financial-analysis`), distribution build variables, and
the existing installed-package resolution root. `packages/app` never imports a concrete Agent or
reads bundler globals. `Catalog.list()` returns only those explicit built-ins. `Catalog.load(id)`
also retains exact-ID loading for an installed external package so the existing CLI behavior does
not regress; it does not scan packages or make an external Agent discoverable.

The three capabilities are intentionally different:

```text
Catalog.list()              current Host's discoverable and Service-eligible Agents
Catalog.load(agentId)       validated exact-package loading used by the existing CLI
AgentService.openSession()  Catalog.list()-gated Agent execution
```

`AgentService` is process-local and binds to one Workspace through its injected `AgentFactory`.
An open `(agentId, sessionId)` owns exactly one `AgentInstance`. Opening and closing the same key are
deduplicated, partially constructed instances are rolled back, and Service disposal covers opening,
open, and closing records. The Service does not own or dispose the injected Catalog, Model service,
configuration service, or process runtime.

Runs start only when the returned `AsyncIterable` is first consumed. Requests in one Session are
strict FIFO; different Sessions may run concurrently. Active and queued request IDs are unique
within the Service. Consumer exit, explicit abort, Session close, and Service disposal all converge
on the same request cancellation path, and every consumed Run emits at most one terminal event.
`AgentApplication` independently rejects overlapping Runs and Session mutation so callers cannot
bypass this invariant outside the Service.

Each Run event stream has exactly one consumer. Creating a second iterator fails explicitly instead
of splitting events or allowing one consumer to cancel another. A Host that needs multiple views,
such as UI rendering and logging, consumes the Service stream once and performs its own downstream
fan-out.

Process-local errors retain their structured type, diagnostic fields, and `cause`. They are not wire
objects. `toAgentServiceFailure()` is the single safe projection into the stable `code`, `message`,
and `retryable` shape shared by failed Run events and future Host adapters. The projection preserves
actionable error codes while replacing paths and other internal diagnostics with bounded messages.
Adapters must serialize that projection rather than an `Error`, its `cause`, or cleanup failure
details. This keeps transport serialization outside the Service without duplicating error mappings
across Godot, WebSocket, or IM Hosts.

Explicit concurrent opens for the same `(agentId, sessionId)` share one opening operation. A
session-less "latest" open and a simultaneous explicit open may resolve to the same persisted
Session only after assembly; in that bounded case the Service keeps one instance and immediately
disposes the redundant one. V1 accepts this transient assembly cost instead of adding an Agent-wide
opening lock or a second Session-locator abstraction. Session absence remains owned by Core's
Repository as `AgentSessionNotFoundError`; the Service maps it to its stable `session_not_found`
boundary error without parsing Repository messages.

The default CLI still owns its existing Run and `ActiveAgentRun` lifecycle; it does not route through
`AgentService`. The concrete `packages/agent-host` WebSocket adapter calls only the Service Port and
does not change Agent assembly, Core execution, Tool coordination, or Session persistence. Dynamic
Agent registration, source merging, hot reload, additional transports, and multi-process Session
ownership remain outside this boundary.

The application contract is summarized in [`agent-service.md`](agent-service.md); the WebSocket
transport and companion-process contract are in [`agent-host.md`](agent-host.md).
The concrete Godot client and process handoff are in
[`godot-agent-host-client.md`](godot-agent-host-client.md).

## Host interaction surface

Core defines `InteractionSurfacePort` as the sole structured foreground-interaction
contract. It accepts serializable single-select, multi-select, text, and explicit-action
fields and returns a structurally validated response. It does not understand approval,
commands, clarification, focus, terminal layout, or persistence.

Request-level `title`, `detail`, `message`, `tone`, `dismissLabel`, `status`, and
`completionStatus` are presentation hints. A Host may render them using native UI, but
must not interpret them as policy or alter stable field, option, and action IDs.

```text
ToolAccessController -> AccessConsentBroker --┐
Command -> TuiCommandInteractionAdapter -------+-> InteractionSurfacePort
request_user_input -> clarification adapter ---┘             |
                                                         UI TUI Surface
```

`AgentFactory` lends one host-owned Surface to each Blueprint. The factory and Blueprint
do not own or dispose it, and non-interactive hosts receive `RejectingInteractionSurface`,
which fails with `interaction_unavailable` instead of guessing an answer or waiting
forever. The UI package owns `TuiInteractionSurface`, its single foreground slot, focus and input
handoff, abort listeners, and disposal. CLI consumes only the interaction ports supplied by the
Host. Nested requests fail with `interaction_busy`.

Access consent, Command, and clarification retain independent adapters and validation:
the Surface never computes access policy, maps command values, or decides whether a question
is required. Escape is a neutral `dismissed` response; each adapter maps it to disabled,
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

Agent packages expose `./agent.yaml` and an `agentBlueprint` from their package root. The CLI default
Catalog keeps static module loaders only for built-in Agents so the distribution bundler can discover
them; other IDs loaded directly by the CLI resolve `@omni-agent/agent-<id>` through standard Node module
resolution, first from the CLI installation and then from the package-manager-neutral
`~/.omni-agent/agents/node_modules` root. The Catalog requests only the exact package name;
it does not scan packages or maintain a dynamic Agent registry. Every validated package passes to
the single `AgentFactory`. `pnpm dev`
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
App Store / Query adapters -> UI Preview Server -> Browser
```

Runtime code depends only on typed, scoped Observation handles. Run, Turn, Context, Model,
Tool Batch, Tool Call, access, preflight, and execution scopes report readonly facts at
their authoritative execution points. They do not know span names, replay kinds, storage,
OpenTelemetry, or an observability vendor. Observation methods are synchronous, fail-open, and
cannot alter inputs, results, access decisions, scheduling, cancellation, or exceptions.

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
control-and-inspection capability to CLI orchestration. The CLI owns `/trace`; concrete Agents do not
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

App local query factory --> TraceQueryPort --> loopback-only UI Preview server --> browser
                                      ^
                                      |
                               apps/omni composition
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

Capture is off by default. The CLI may explicitly enable it for the current Agent process with
`--trace`, and Host control may enable or disable future Runs interactively. An already active Run
remains attached to its original capture scope. The shared Core sanitizer
removes credential-shaped fields while preserving operational metrics before payloads reach local
persistence. A bounded write queue keeps Runtime non-blocking; lifecycle records take priority over
streamed detail, and overload degrades capture with diagnostics plus a persisted Run-summary
dropped-record count. Trace write failures never alter model, permission, tool,
Stream, or Session behavior. The local viewer is read-only, listens only on `127.0.0.1`, validates
Host and identifiers, disables caching and framing, applies a restrictive Content Security Policy,
and loads no external resources. Host-owned `omni trace clear <agentId>` is the only deletion path
and rejects active captures.

The browser UI projects the span parent graph into a collapsible Waterfall and correlates the
selected span with Replay payloads for Input, Output, and Attributes. This projection remains a
read-only UI concern: it may add presentation-only grouping or historical correlation fallback,
but it does not infer execution state or feed decisions back into Core, App, or an Agent.

`TraceQueryPort` is the stable local query boundary. App owns the concrete store, layout, query,
and maintenance adapters and exposes only factories for Host composition. A future OpenTelemetry
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
execution, access, timeout, or host policy to a Provider.

Assembly owns the single `TranscriptMessage` to `ModelContextMessage` projection plus the
projection of Context-only checkpoint and artifact entries. Checkpoints are emitted only
as tagged model-context user entries and never enter Session JSONL. The manifest records
identities, middleware and policy-stage versions, before/after estimates, checkpoint
lineage, message counts, decisions, and stable SHA-256 digests; it contains no message
text. A `model_context_prepared` event exposes it without adding it to the Session.

Compression uses a stable input budget of `contextWindow - ceil(contextWindow * 0.05)`.
Models resolves the Provider capability and explicit user ceiling, without a uniform output
cap. Context computes the actual request output from the final estimated input and stores
it in the manifest; transport sends that exact budget or fails validation. The budget
policy is shared within Context, not owned by a compression implementation. Stable Micro uses
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
the coordinator, including extension tools and structured validation or access
errors. It uses stable result signatures and trailing batch-cycle rules without knowing
concrete tool names. A hard halt waits for the full tool batch, emits a structured error,
and returns all produced messages for persistence. Concrete built-in Agents have no fixed
model-turn limit; long Runs end through explicit cancellation, process signals, and existing
Model/Tool timeout boundaries. Core retains its generic loop contract without exposing a turn
limit through the Agent Manifest recipe.

Keytar is the credential source of truth. Its non-secret credential index is
derived state; writes use provider-scoped serialization and compensation, while a
corrupt index is quarantined and reconciled from known active provider IDs.
Environment files are parsed without mutating `process.env`.

## Runtime access and process sandbox

The complete and authoritative runtime contract is in
[`docs/tool-call-runtime.md`](tool-call-runtime.md). This section records only the
cross-package boundary.

Every Tool call crosses one access path before execution:

```text
AgentLoop -> ToolCallCoordinator -> schema validation -> domain preflight
                                   -> ToolAccessController -> AccessGrant
                                   -> ProcessExecutionPlanner -> final ToolExecutionPlan
          -> lifecycle -> ToolInvocationRunner
                         |-> in-process Tool
                         `-> ProcessExecutionRouter -> Rust Seatbelt or direct host
```

Core owns `ToolCallCoordinator`, `ToolAccessController`, the process-planning port, immutable authorized calls, and
`ToolInvocationRunner`. The coordinator remains AgentLoop's only Tool entry. Access and execution
are independent explicit strategies. The tools package owns Shell, filesystem, search, and web
facts plus filesystem consent candidates; App owns versioned workspace settings; UI owns mode
management and access consent. No layer dispatches behavior through a central Tool-name switch.
Tool domains report ordinary access-contract rejections through `ToolAccessIntent.denial` and
reserve `hardStop` for security facts that override mode-specific evaluation.

The modes are `controlled`, `autonomous`, and `unrestricted`. Controlled confines access to the
canonical workspace plus filesystem roots explicitly approved for that workspace and Agent, and
reuses persisted exact network targets without repeated consent. Targets can be preconfigured with
`/permissions network add <URL> [URL ...]`. Public, private, and localhost services use the same
target policy. Approved roots distinguish read from read/write and remain
subject to sensitive-path policy. Autonomous retains Seatbelt while consuming bounded per-call
path and network scope without prompts or persistence. Unrestricted requires explicit mode confirmation and routes Process Tools
directly to the host. It still keeps Schema, preflight, timeout, cancellation, output, and
file-consistency protections.

`packages/network` has one buffered/streaming HTTP implementation and a process proxy adapter.
Core supplies the execution mode and call lifetime; the transport does not ask for consent.
DNS and address checks are internal functions. Known cloud credential metadata addresses require
unrestricted mode; localhost and private services do not. See `docs/network-security.md` for the
revocation, redirect, and response-framing boundaries.

Tree-sitter handles Shell syntax once; the tools-local semantic IR is recursively analyzed for
command, path, effect, uncertainty, and hard-stop facts. A bounded context tracks static cwd,
literal variables, and security effects carried by known variables without attempting to model
general command output. Bash execution rejects command-local shell startup injection and removes
`BASH_ENV`, `ENV`, and exported Bash functions from the host environment so startup hooks cannot
invalidate the analyzed command graph. Process execution captures an immutable host PATH at
startup. The same snapshot drives controlled/autonomous lookup and the sandboxed Bash environment,
so mutable process state cannot make analysis and execution select different host executables.

Before Core creates an authorized Process call, the tools-owned `ProcessExecutionPlanner` resolves
the direct invocation executable and the static external executable facts produced by the single
Shell analysis. Each fact preserves its effective cwd. A tools-owned runtime
projection resolver follows lexical symlinks, bounded package roots, shebang interpreters, shell
shim dependencies, and macOS Mach-O images. It contributes only per-call read scopes; these do not
become approved filesystem roots or persistence state. Runtime scopes are minimized, combined
with existing policy by one compiler, and remain subject to the shared sensitive deny overlay.
The direct executable and shebang interpreter must resolve. Static command candidates found inside
a shell script are projected when present; candidates absent from the immutable PATH are left for
the shell's normal conditional or command-not-found behavior and never trigger broader lookup.
Dynamic plugins and dependencies discovered only after launch do not trigger expansion, retry, or
host fallback. `ProcessExecutionRouter` consumes only the frozen final plan and cannot add scopes.
External dependency inspection during planning has a fixed bounded deadline and reuses Core's
operation supervisor for cancellation, cooperative cleanup, and late-settlement consumption.
Relative PATH entries are trusted only when their canonical target is already covered by the
current access policy. PATH target replacement remains a documented residual boundary.

Filesystem and search access binds explicit path input to its canonical target before Core creates
the immutable call. In controlled mode, an uncovered ordinary path can propose a canonical
filesystem capability; user approval persists it, then Core re-evaluates the unchanged access
intent. Ordinary file operations propose a parent subtree, while sensitive reads can only propose
an exact file. The same capability matcher is consumed by file, search, and shell access, and only
capabilities used by the current call are projected into its sandbox policy. Autonomous accepts
ordinary external scope, exact sensitive reads, and rejects protected or sensitive writes.
Execution still revalidates mutable path state. The shared sensitive-policy snapshot drives both
TypeScript access inspection and Rust policy construction.

State lives in `~/.omni-agent/execution-settings.json`, keyed by workspace and Agent, and uses v6
with the shared inter-process lock plus atomic JSON persistence. The one-way v5 migration preserves
mode and filesystem roots but discards coarse network grants; exact targets start empty. Earlier
versions pass through the isolated migrations. Invalid state fails closed to controlled with no
approved targets or roots.

The formal Rust package under `sandbox/` enforces Process Tool policy with macOS Seatbelt.
Protocol v4 permits only the call's proxy port for sandboxed network access and protects the workspace and each projected read/write subtree root against deletion or
rename while allowing mutations below it. A per-launch diagnostic token distinguishes Rust startup
failures from target output. Controlled/autonomous never fall back to host.
The package is rooted directly at `sandbox/`: development and repository builds compile the
current-host release binary, while the CLI distribution builder separately cross-builds and
packages macOS arm64 and x64 binaries.
In-process Tools and local extensions remain trusted local code and are not described as
Seatbelt-contained. Rust exposes a platform apply/exec boundary, and TypeScript isolates native
dependency discovery behind a platform resolver. Linux or Windows support must add both a complete
enforcement backend and dependency resolver; unsupported or partial backends fail closed.

Every tool declares a required timeout strategy: `none`, runtime-owned `fixed`, or
schema-bound `input`. The invocation runner starts a deadline only after access control and
`beforeExecute` middleware. A timeout aborts the linked execution signal, permits a
bounded cooperative cleanup window, and suppresses all late results. Bash and grep
share one host-process runner; file and web tools retain domain-specific I/O behavior.
Linked cancellation, timers, and late settlement observation are isolated in Core's
`OperationDeadlineSupervisor` and reused by execution and bounded planning inspections.

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

## Agent loop orchestration

`runAgentLoop` is the Run-level imperative shell. It owns iteration and Run termination but
delegates each loop iteration to an internal orchestrator. One iteration maps to the Runtime
Observation Turn scope and keeps environment/context preparation, model streaming, and optional
tool-batch work in explicit order. Each phase owns exactly its scoped Runtime Observation lifecycle;
the iteration orchestrator alone owns the Turn terminal, and `ToolCallCoordinator` remains the only
tool-call entry.

```text
runAgentLoop
  -> runLoopIteration
       -> environment/context preparation
       -> model streaming
       -> tool batch -> ToolCallCoordinator
```

Phase results are internal discriminated unions for normal control flow. Phase functions are not
extension points and are not exported from Core. Model runtimes, middleware, context policies,
tools, and observers remain the supported composition boundaries; extensions cannot insert or
reorder Agent-loop phases.

## Stream presentation boundary

User-visible streaming follows one direction:

```text
Tool / Context / Model Cache
  -> immutable Core event DTO
  -> StreamSession callbacks
  -> UI StreamPresentationRouter
  -> feature presenters
  -> pure ViewModel
  -> generic TUI component
```

Core owns event facts and never terminal wording. The UI presenters own correlation,
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
`done`, or the last rendered component. The UI run presentation model owns stable
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

The UI `ToolBatchPresenter` applies Composite presentation: a single visible tool keeps
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

The UI labels `inputTokens / usableInputBudget` as Context pressure because that is the
ratio used by Micro and Heavy. Wide rendering also shows `inputTokens / contextWindow` as
Window usage and keeps Cache hit beside it. Compression disclosures receive the triggering
input total, usable budget, and threshold from the immutable progress DTO; UI never
recomputes compression policy or reads Context decisions.

Commands depend on Core's `CommandInteractionPort`, not a TUI type or `AgentConfig`.
Skill reload asks `AgentApplication.refreshInstructions()` to rebuild instructions; CLI
code does not mutate runtime configuration. Skill tool-event claiming lives exclusively
in `SkillStreamPresenter`, so generic Tool presentation contains no Skill special case.

### Output truncation recovery

The existing Agent Loop owns output recovery. `length` is incomplete output, never a successful
Run terminal. At most three consecutive recovery requests use the same Run cancellation and
turn budget, with fresh model-call identities. Recovery instructions enter prepared context,
not durable user messages. Raw partial responses remain in the transcript/Trace; unexecuted
truncated tool calls are excluded from request projection and compression tool-cycle analysis.
Signed tool envelopes that cannot be safely projected fail explicitly. No tools are replayed
by recovery. Normal stop/toolUse resets the streak; exhaustion and unsupported stop reasons
use existing structured failures. The request Trace records recovery attempt and parent call.

### Generic tool output storage

Core owns OutputRecord, SessionOutputPort and the unified post-execution retention policy. App's persistence/SessionArtifactStore owns Session binding, storage budgets, integrity and lifecycle. Tools implement process capture and the generic output_read reader using Core ports; App never depends on Tools. The neutral text-page reader and file snapshot helper were moved from Tools to Core and are shared with file_read. Coding only selects the reader through its tool catalog. Benchmark archives and checks the existing native state without becoming the storage owner.

Output recovery persists part intent before body I/O. Under the exclusive Session lease it reconstructs interrupted sizes/digests, marks missing bodies explicitly and reclaims only store-owned orphan/temporary names. The shared InterprocessFileLock now supports cancellable acquisition; no second lock implementation is introduced.

### Provider tool constraint ownership

Models compiles tool generation intents into the existing SDK or custom transport request.
Core exposes the neutral `inputConstraint` contract and observes the resolution report, but
never interprets vendor compatibility. Provider/model capability declarations belong to
Models; they do not grant tool execution access. There is one request path, no proxy service
or alternate executor. See `docs/tool-call-runtime.md` for migration, schema limits and replay
semantics. Constraint decisions are resolved once per call; the same decision feeds request
mapping and observation. Existing cache fingerprints include tool intents, and their semantic
version changes when the protocol mapping changes; they remain semantic evidence rather than
an assertion about provider cache hits.
