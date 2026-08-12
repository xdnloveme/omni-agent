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

Core exposes only the stable `ModelRuntimePort`, `AgentMessage`, and `ModelEvent`
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

## Extensions

Concrete agents enter an application through a declarative `AgentExtension`.
The extension manager validates all contributions before committing them and
rolls back tools, agents, and commands when activation fails.
Provider contributions participate in the same transaction and are removed and
disposed in reverse registration order when activation fails.
Middleware contributions are stored by the extension manager. Model middleware is
orchestrated by the Agent loop; tool execution middleware is invoked by
`ToolInvocationRunner` only after authorization. Unregistering an extension removes
the same middleware instances from the live application.

Each installed Agent exports an `AgentBlueprint`. The application-scoped
`AgentFactory` is the only assembly entry point: it validates the blueprint,
builds and registers its extension, resolves the effective model, restores the
Agent's Session, and creates an isolated `AgentApplication`.

Optional extensions can be exported from `~/.omni-agent/extensions.mjs` and the
current project's `omni.extensions.mjs`. They merge by extension manifest ID,
with the project definition replacing the matching global definition. Local
extension code is trusted local code and is not sandboxed.

## Layered configuration

Global configuration under `~/.omni-agent` is the baseline. Files in the
current project root form the override layer:

- `omni.config.json`: version 3 stores a shared default model and optional
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
registry, or API key in `AgentConfig`. Runtime configuration accepts only
`OmniConfig` version 3; historical formats do not participate in model execution.
The default CLI preserves the existing command, tool, event, and TUI behavior.

Agent packages expose an `agentBlueprint` from their package root. The CLI
resolves `@omni-agent/agent-<id>` dynamically and passes that blueprint to the
single `AgentFactory`. Agent IDs are therefore not maintained in a CLI allowlist
or switch statement. `pnpm dev` selects `coding` only as its default argument,
while `pnpm run dev -- <id>` selects any installed Agent package through the same
chat runtime.

Each `AgentApplication` owns an `AgentSessionRepository` constructed with an
explicit `agentId`. Session indexes and JSONL histories live under
`~/.omni-agent/sessions/<agent-id>/`; the Repository restores the latest Session
on startup and creates a Session only when the directory is empty or `/new` is
requested. Model providers, catalogs, and credentials remain shared
infrastructure; model selection may be overridden per Agent. Prompts, tools,
capabilities, Runner, Session, and mutable runtime state remain instance-local.

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
one Shell analysis entry, its internal parser and command classifiers live with the Bash tool, while filesystem
and search tools map shared path-security facts into their own permission presentations.
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
one literal executable and deliberately does not classify its subcommands for persistence.
Generic sensitive-path, destructive, privileged, and hard-stop assessments cannot consume
that scope. Compound commands expose one requirement for each executable,
including targets resolved through supported wrappers. Multiple executable identities use
all-of matching: all existing grants allow execution, while one approval can atomically add
only the missing executable scopes. Every call is reassessed before scope lookup, so stored
state cannot override those boundaries. Constraining behavior inside an approved CLI is a
future sandbox responsibility.

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
