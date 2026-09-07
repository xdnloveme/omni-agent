# Omni Agent Repository Guide

## Purpose

Omni Agent is a TypeScript monorepo for building reusable agent infrastructure
and independently packaged business agents. The default product is an
interactive coding agent. The repository also contains an optional, read-only
financial analysis agent that computes deterministic technical indicators; it
does not place trades.

The architecture must support additional agents, tools, hosts, and local
extensions without coupling the runtime kernel to a product domain.

## Repository Layers

```text
packages/core   Agent execution kernel and stable runtime ports
packages/network Target-scoped gateway, DNS policy, and authenticated loopback proxy
packages/models Model runtime, vendor plugins, catalogs, and credentials
packages/app    Agent package Catalog, Host-neutral Service, lifecycle, extensions, and sessions
packages/agent-host WebSocket Protocol v2 adapter for AgentServicePort
packages/tools  Domain-neutral filesystem, shell, search, and web tools
packages/ui     Interaction hosts, views, presentation models, and input handling
packages/cli    Commands and Agent use-case orchestration
apps/omni       Binary entry, process lifecycle, and composition root
apps/omni-game  Godot character, Session, task interaction, and presentation
agents/*        Independently packaged business agents
```

Allowed workspace dependency direction:

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

Do not introduce reverse dependencies. `core` and `app` must never import a
concrete agent. Agent packages must not import the CLI or another agent package.
Concrete agents are registered explicitly through `AgentExtension`.

See `docs/architecture.md` for the detailed architecture contract.
See `docs/agent-service.md` for the Host-neutral Agent discovery, Session, Run,
failure-projection, and lifecycle contract.
See `docs/agent-host.md` for the loopback WebSocket protocol, authentication,
transport cancellation, and process contract.
See `docs/godot-agent-host-client.md` for the concrete Godot client, Session
interaction, and development process lifecycle.
See `docs/tool-call-runtime.md` for the authoritative Tool access, execution,
cancellation, and sandbox-boundary contract.

## Ownership Rules

- Put the agent loop, tool execution, cancellation, events, middleware, and the
  stable `ModelRuntimePort` contract in `packages/core`.
- Put model transport execution, vendor/provider plugins, model catalogs,
  protocol conversion, and credential persistence in `packages/models`.
- Put Agent package Catalog behavior, Host-neutral Agent Service orchestration,
  agent/tool/command registration, extension loading, application lifecycle,
  sessions, and configuration in `packages/app`.
- Put only WebSocket connection, Protocol v2 validation, request correlation,
  transport cancellation, bounded writes, and backpressure in `packages/agent-host`.
  Its only business interface is `AgentServicePort`.
- Put a tool in `packages/tools` only when it has complete technical meaning
  outside a specific agent or business domain.
- Keep prompts, domain types, domain services, domain tools, and workflows in the
  owning package under `agents/`.
- Keep browser and terminal rendering, view interaction, input handling, and presentation
  lifecycle in `packages/ui`; keep Agent and onboarding workflow orchestration in `packages/cli`;
  keep composition and process lifecycle in `apps/omni`.
- Keep Godot Socket and Protocol v2 behavior in `AgentHostClient`, game interaction state in
  `CharacterWorkspaceController`, and Godot presentation in scene UI. Do not add a Gateway or
  backend Port until a second real backend demonstrates the boundary.
- Prefer composition and declarative definitions over `BaseAgent` inheritance.
- Do not add a framework abstraction until at least two real consumers require
  it or it removes meaningful existing complexity.

Examples:

```text
file_read, bash, grep                 -> packages/tools
repository-specific analysis         -> agents/coding
RSI, MACD, IBKR data adapters         -> agents/financial-analysis
TUI widgets and keyboard interaction  -> packages/ui
```

## Runtime Contract

The coding agent is the default agent and must remain usable after every change.
Preserve its system prompt composition, exposed tool names and order, commands,
stream events, configuration behavior, credential storage, and JSONL session
format unless a change explicitly requires a migration.

`ModelRuntimePort`, `AgentMessage`, `AgentRunner`, `ToolCallCoordinator`,
`ToolAccessController`, `ProcessExecutionPlanner`, `ProcessExecutionRouter`, `ToolInvocationRunner`, `AgentPackageCatalogPort`,
`AgentServicePort`, `AgentFactory`, `AgentBlueprint`, and `AgentExtension` are the current architecture. Do not add alternate tool
execution paths, legacy model execution branches, compatibility overloads,
global runtime setters, static model registries, or aliases for removed types.
Historical configuration and credentials may be handled only by isolated,
one-way data migration into the current format.

Local ESM extensions are trusted local code. Do not imply that
`omni.extensions.mjs` or `~/.omni-agent/extensions.mjs` files are sandboxed.

## Extension And Tool Rules

- Validate an extension completely before registration and roll back all of its
  contributions if activation fails.
- Optional local extension failures should produce diagnostics and must not stop
  the default coding agent from starting.
- Tools must support `AbortSignal` where work can block.
- Every Tool must declare an explicit access strategy (`internal` or `dynamic`), execution
  strategy (`in_process` or `process`), and timeout policy (`none`, `fixed`, or schema-bound
  `input`). There is no metadata fallback.
- Optional Tool preflight validates domain readiness before access control. It must return a
  structured domain error without performing access policy, UI, or execution work; tools
  must still revalidate mutable state at execution time.
- All Bash access facts must come from the single `analyzeShellCommand` entry and its
  Tree-sitter-backed `ShellProgram`. Command semantics, path analysis, wrappers, and executable
  analysis must not reparse raw command text or reconstruct wrapper payloads. Partial syntax
  must still expose recoverable nested commands to hard-stop analysis.
- Bash execution must remove `BASH_ENV`, `ENV`, and exported `BASH_FUNC_*` values before spawning
  and Shell analysis must reject non-empty command-local assignments to those names, so runtime
  startup injection cannot invalidate the analyzed command graph. Keep bounded variable security
  effects inside the unified analysis pipeline so assignment and pipeline boundaries cannot erase
  known download, decode, or credential-read flows.
- Controlled mode limits filesystem access to the canonical workspace plus user-approved
  filesystem roots stored per workspace and Agent. Ordinary roots are read or read/write
  capabilities; sensitive reads must be exact, and protected or sensitive writes are denied.
  Autonomous mode accepts bounded per-call scopes. Unrestricted mode bypasses access boundaries
  only after explicit mode confirmation.
- Controlled and autonomous Process Tools must use the Rust Seatbelt runner and must never fall
  back to host execution. In-process Tools are trusted local code and are not described as
  running inside Seatbelt.
- Keep the single Rust package rooted directly at `sandbox/`; do not add a one-crate Cargo
  workspace layer. `pnpm dev` and `pnpm run build` must build the current-host release binary,
  while `pnpm run build:cli` owns macOS arm64/x64 cross-build and distribution packaging.
- Sandboxed Process Tools resolve their primary executable plus statically discovered Shell
  executables, including each command's effective cwd, against the immutable host PATH captured at
  startup. `ProcessExecutionPlanner` must finish this work before the authorized call is created;
  `ProcessExecutionRouter` must not add capabilities. Relative PATH entries are valid only when the
  canonical executable target is already covered by the call's access policy. Runtime projection may add
  only bounded, per-call read scopes for lexical executables, canonical package roots, shebang
  interpreters, and platform-native dependencies. Do not restore global development-directory
  projections, installer/CLI name tables, shell-based executable lookup, or host fallback.
  Direct executables and shebang interpreters must resolve. Static command candidates inside a
  shell script are projected only when present in the immutable PATH; an absent candidate neither
  broadens lookup nor blocks the shell's own conditional or command-not-found behavior.
- Keep tool-domain assessment with the tool owner. Do not add a central
  `switch(toolName)` or make App/CLI parse Bash commands or paths.
- Resolve paths and spawn processes with the injected execution `cwd`; tool
  implementations must not choose their own `process.cwd()`.
- `ToolCallCoordinator` is the Agent loop's only tool entry. Middleware and
  lifecycle adapters run only after access control.
- Keep target-scoped network transport, DNS/IP/redirect enforcement, and the authenticated
  loopback proxy in `packages/network`. Tools receive only a bound `AuthorizedNetworkClient`;
  `tools` and `core` must not import the concrete network package.
- Controlled and autonomous Process network access is proxy-only. Never add broad Seatbelt
  network permission, inherited proxy bypass, or Host fallback.
- Use Core's shared sanitizer, abort helpers, schema validator, and
  `InterprocessFileLock`; do not create parallel implementations.
- Return structured errors instead of hiding failures in successful output.
- Keep trading and order execution out of the financial analysis agent unless
  the product scope is explicitly changed.

## Tool Execution And Filesystem Contract

- `ToolCallCoordinator` is the Agent loop's only tool-call entry. Access
  decisions belong to `ToolAccessController`; final Process plans belong to
  `ProcessExecutionPlanner`; authorized execution, middleware order,
  and metrics belong to `ToolInvocationRunner`.
- A Process Tool's `createProcessInvocation` runs during planning before lifecycle and middleware.
  Keep it a pure, bounded input-to-arguments mapping; it must not spawn, perform I/O, or read mutable
  access state.
- `OperationDeadlineSupervisor` owns linked cancellation, deadline timers,
  bounded cooperative cleanup, and late-settlement observation for both Tool execution and
  bounded process-planning inspections. Do not recreate timeout races or cancellation linking in
  individual tools or platform adapters.
- Bash and grep share `ProcessExecutionRouter` and the tools-layer `HostProcessRunner`.
  Controlled/autonomous calls route through the formal Rust sandbox; unrestricted calls route
  directly to the host. Process tools must use
  the injected execution `cwd` and signal and must preserve exit-code and signal
  termination semantics.
- Filesystem tools share canonical path resolution, path/inode locking, snapshot
  checks, text validation, streaming reads, and direct writes. Do not add a
  second file-write or process-execution path inside an individual tool.
- `file_read` pagination is bounded and versioned; continuation parameters must
  remain visible in both structured metadata and LLM-facing text. Oversized
  lines continue by UTF-8 byte offset.
- Search tools expose navigation facts through both structured metadata and
  LLM-facing text: glob returns file sizes, while grep returns file sizes and
  structured line/column matches. They must not choose or invoke file-read
  ranges on the Agent's behalf.
- `file_read` defaults to 500 lines, accepts an explicit range of 1-2000 lines,
  and always keeps the final tool text within 64 KiB. It must not depend on
  prior glob or grep calls.
- `file_edit` and `file_write` prepare complete content in memory before one
  direct `fs.writeFile` submission. Direct overwrite is deliberately not an
  atomic commit and may leave an unknown target state on I/O failure; do not
  imply temp-file recovery, rollback, or OS-level isolation.
- See `docs/tool-call-runtime.md` for the complete runtime, cancellation,
  timeout, process, and filesystem contracts.

## Development Workflow

Use Node.js 22.19.0 or newer and pnpm.

```bash
pnpm install
pnpm dev
pnpm run format:check
pnpm run typecheck
pnpm run test
pnpm run build
```

Before finishing a change:

1. Run `pnpm run format` and focused tests for the modified behavior.
2. Run `pnpm run format:check`, `pnpm run typecheck`, and `pnpm run test`.
3. Run `pnpm run build` when package exports, references, or dependencies change.
4. Smoke-test `pnpm dev` when CLI startup, composition, configuration, sessions,
   commands, or TUI behavior changes.
5. Check dependency direction when adding imports or workspace dependencies.

Add tests for runtime loops, cancellation, extension atomicity, tool boundaries,
important indicator calculations, and user-visible compatibility. Avoid tests
that only mirror implementation details.

## Change Discipline

Keep changes scoped and preserve unrelated work in the working tree. Prefer
existing repository patterns, explicit dependencies, and small migration steps.
Do not move business semantics into shared infrastructure merely to reduce file
count. Update `README.md` or `docs/architecture.md` when public usage or layer
boundaries change.
