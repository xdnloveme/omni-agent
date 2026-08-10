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
cli -> app, core, tools, agent-coding
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
Middleware contributions are stored by the extension manager and executed around
model and tool calls by the single agent loop; unregistering an extension removes
the same middleware instances from the live application.

```ts
const app = await createAgentApp({
  modelSelection: { vendorId: "openai", connectionId: "default", modelId: "gpt-5.4" },
  defaultAgentId: "coding",
  extensions: [codingExtension],
});
```

Optional extensions can be exported from `~/.omni-agent/extensions.mjs` and the
current project's `omni.extensions.mjs`. They merge by extension manifest ID,
with the project definition replacing the matching global definition. Local
extension code is trusted local code and is not sandboxed.

## Layered configuration

Global configuration under `~/.omni-agent` is the baseline. Files in the
current project root form the override layer:

- `omni.config.json`: the project model selection replaces global
  `~/.omni-agent/config.json` as one atomic value.
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
registry, or API key in `AgentConfig`. Configuration migration is isolated in
App and converts historical config one-way into `OmniConfigV2` and the current
Provider definition format; historical formats never participate in model
execution. The default CLI preserves the existing session, command, tool, event,
and TUI behavior.

Keytar is the credential source of truth. Its non-secret credential index is
derived state; writes use provider-scoped serialization and compensation, while a
corrupt index is quarantined and reconciled from known active provider IDs.
Environment files are parsed without mutating `process.env`.
