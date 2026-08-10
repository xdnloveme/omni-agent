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
packages/models Model runtime, vendor plugins, catalogs, and credentials
packages/app    Application lifecycle, registries, extensions, and sessions
packages/tools  Domain-neutral filesystem, shell, search, and web tools
packages/cli    CLI composition root, interaction layer, and onboarding
agents/*        Independently packaged business agents
```

Allowed workspace dependency direction:

```text
tools -> core
models -> core
app -> core, models
agents/* -> app, core, tools
cli -> app, core, tools, agent-coding
```

Do not introduce reverse dependencies. `core` and `app` must never import a
concrete agent. Agent packages must not import the CLI or another agent package.
Concrete agents are registered explicitly through `AgentExtension`.

See `docs/architecture.md` for the detailed architecture contract.

## Ownership Rules

- Put the agent loop, tool execution, cancellation, events, middleware, and the
  stable `ModelRuntimePort` contract in `packages/core`.
- Put model transport execution, vendor/provider plugins, model catalogs,
  protocol conversion, and credential persistence in `packages/models`.
- Put agent/tool/command registration, extension loading, application lifecycle,
  sessions, and configuration in `packages/app`.
- Put a tool in `packages/tools` only when it has complete technical meaning
  outside a specific agent or business domain.
- Keep prompts, domain types, domain services, domain tools, and workflows in the
  owning package under `agents/`.
- Keep terminal rendering, input handling, onboarding, and process lifecycle in
  `packages/cli`.
- Prefer composition and declarative definitions over `BaseAgent` inheritance.
- Do not add a framework abstraction until at least two real consumers require
  it or it removes meaningful existing complexity.

Examples:

```text
file_read, bash, grep                 -> packages/tools
repository-specific analysis         -> agents/coding
RSI, MACD, IBKR data adapters         -> agents/financial-analysis
TUI widgets and keyboard interaction  -> packages/cli
```

## Runtime Contract

The coding agent is the default agent and must remain usable after every change.
Preserve its system prompt composition, exposed tool names and order, commands,
stream events, configuration behavior, credential storage, and JSONL session
format unless a change explicitly requires a migration.

`ModelRuntimePort`, `AgentMessage`, `AgentRunner`, `ToolExecutor`,
`createAgentApp()`, and `AgentExtension` are the current architecture. Do not
add legacy model execution branches, compatibility overloads, global runtime
setters, static model registries, or aliases for removed model-library types.
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
- Declare tool risk and approval metadata accurately.
- Return structured errors instead of hiding failures in successful output.
- Keep trading and order execution out of the financial analysis agent unless
  the product scope is explicitly changed.

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
