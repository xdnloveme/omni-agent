# Agent package contract

第一次创建 Agent，请先完成[五分钟构建教程](build-an-agent-in-five-minutes.md)，并运行仓库中的
[`examples/minimal-agent`](../examples/minimal-agent)。

An Agent package consists of one declarative Manifest and one executable Blueprint:

```text
agent.yaml          identity, API compatibility, and composition recipe
package.json        package name, version, and exports
agentBlueprint      component descriptor, implementations, extension, and owned lifecycle
```

The package must export its root and `./agent.yaml`. The Loader resolves and strictly validates the
Manifest before importing the root module. Unsupported versions, unknown fields, duplicate keys,
aliases, merge keys, custom tags, multiple documents, non-mapping roots, and files above 64 KiB are
rejected. Package name, requested Agent ID, Manifest ID, and the single contributed Agent ID must
agree.

Manifest API `omni-agent/v2` supports Blueprint API version `2`. The Manifest is the only Agent ID
source; `AgentBlueprint` and `AgentModule` therefore have no `id` field. Package version comes only
from `package.json`.

The Manifest recipe selects one Prompt profile, ordered Prompt contributors, one ordered sequence
of Tool bundles and individual Tool components, and optional Skills and Artifact Recovery capabilities. Component IDs
use Core's `isToolOriginId()` syntax and never contain module paths. The Recipe cannot declare
Prompt text, executable modules, credentials, authorization, execution, timeout, lifecycle, or
`maxTurns` behavior.

The Blueprint descriptor is a data-only catalog. The Loader validates its shape, but only the
Planner interprets Recipe references, expands bundles, validates dependencies, and produces the
immutable `ResolvedAgentComposition`. The Blueprint builder receives that resolved value and must
not re-read or reinterpret the Manifest recipe. The Assembler rejects any contributed Agent ID,
Tool order, Skills capability, or Artifact Recovery capability that differs from the Plan.

Built-in distribution uses the same canonical YAML files. The CLI build validates them with the
production parser and embeds their raw source and package versions. Bundled runtime parses those raw
sources through the same validation path; no handwritten Manifest object or monorepo path is kept.

Blueprint receives `{ manifest, composition, cwd, interaction }`, returns one `AgentExtension`,
capabilities, and an optional disposer for Agent-owned resources. It must not load models, restore
Sessions, register global extensions, create Trace storage, manage process signals, or set a
concrete Agent turn limit.

Resource ownership is transferred exactly once:

```text
Blueprint.build() owns resources created before it returns
  -> AgentModule returned
  -> AssemblyTransaction owns the Module during assembly
  -> AgentApplication owns Module, ExtensionManager, and Trace after commit
  -> ActiveAgentRun cancels and joins an active Run before Application disposal
```

If `build()` fails before returning, the Blueprint cleans up its partial resources. After return,
assembly failure invokes the optional Module disposer through the transaction. Normal disposal is
idempotent and follows `ExtensionManager -> AgentModule -> Trace`; no Loader, Planner, or concrete
Agent owns Session, model, permission, process-signal, or Trace lifecycle.

Tool bundles and individual Tools share one ordered sequence:

```yaml
composition:
  prompt:
    profile: coding.default
    contributors:
      - workspace.agents-md
      - skills.catalog
  tools:
    sequence:
      - bundle: coding.workspace
      - bundle: research.web
      - tool: interaction.request-user-input
      - tool: skills.read
  capabilities:
    skills: skills.local
    context:
      artifactRecovery: context.file-read-recovery
```

A bundle is only an explicit ordered convenience. A package author can replace it with its
individual Tool references. There is no exclusion, tag matching, automatic discovery, or hidden
default selection. Descriptor display names and descriptions support inspection but never affect
assembly, authorization, caching, policy, or execution.

Package authors can inspect and validate the effective composition without creating Runtime
resources:

```bash
omni agent describe coding
omni agent validate coding
omni agent plan coding
omni agent plan coding --json
```

The extension Manifest ID is the stable runtime namespace for its tools. The path or source that
loaded an extension is diagnostic provenance only; moving the same extension between global and
workspace sources must not create a new tool identity or permission scope.
