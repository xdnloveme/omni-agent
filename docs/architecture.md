# Omni Agent Architecture

## Layers

```text
packages/core   Agent execution kernel
packages/app    Application lifecycle and extension host
packages/tools  Domain-neutral tool implementations
packages/cli    Terminal host and composition root
agents/*        Independently packaged business agents
```

Allowed workspace dependencies:

```text
tools -> core
app -> core
agents/* -> app, core, tools
cli -> app, core, tools, agent-coding
```

Core and app must not import a concrete agent. Agent packages must not import the
CLI or another agent package. Domain tools stay with their owning agent; only
domain-neutral tools may be promoted to `packages/tools`.

## Extensions

Concrete agents enter an application through a declarative `AgentExtension`.
The extension manager validates all contributions before committing them and
rolls back tools, agents, and commands when activation fails.

```ts
const app = await createAgentApp({
  runtime,
  defaultAgentId: "coding",
  extensions: [codingExtension],
});
```

Optional local extensions can be exported from
`.omni-agent.local/extensions.mjs` or paths listed in
`OMNI_AGENT_EXTENSION_FILES`. Local extension code is trusted local code and is
not sandboxed.

## Compatibility

`AgentTool`, `AgentConfig`, and `runAgentLoop()` remain public core APIs. New
hosts should use `AgentRunner` and `createAgentApp()`. The default CLI preserves
the existing configuration, credential, session, command, and TUI behavior.
