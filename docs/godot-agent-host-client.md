# Godot Agent Host Client

`apps/omni-game` is the Godot 4.7.2 graybox client for the local `omni-host`. It is another UI for
the existing Agent runtime, not a second runtime and not a remote Gateway.

## Requirements

- Node.js 22.19.0 or newer and pnpm.
- Godot 4.7.2 stable at `/Applications/Godot.app/Contents/MacOS/Godot`, on `PATH` as `godot` or
  `godot4`, or selected with `OMNI_GODOT_BINARY`.
- Existing CLI model configuration for real Agent Runs.

Other Godot versions are rejected deliberately. The launcher never installs or silently accepts an
engine version.

## Run

From the Workspace that the Agent should operate on:

```bash
pnpm game
```

The launcher generates the authentication Token, starts `omni-host` with the original working
directory as its Workspace, waits for Host readiness, and starts the Godot project. Developers do
not set `OMNI_AGENT_HOST_TOKEN` or copy connection values.

Use a nonstandard engine location only when needed:

```bash
OMNI_GODOT_BINARY=/absolute/path/to/Godot pnpm game
```

## Verify

```bash
pnpm run verify:game
```

This runs three Godot 4.7.2 headless checks:

1. A strict Protocol v2 parser/encoder harness.
2. A deterministic real-transport harness that verifies ordered Run events, Cancel propagation,
   the real `cancelled` terminal event, and WebSocket shutdown settlement without an external model.
3. A real `omni-host` composition harness that authenticates, lists the two registered built-in Agents, opens
   and closes the current Session, creates and closes a new Session, then verifies process cleanup.

It does not call an external model. A real streaming Run is verified manually after model
configuration:

```text
pnpm game
-> select a character
-> enter the task panel
-> submit a simple task
-> observe started, text_delta*, and completed
-> submit another task and Cancel
-> observe the real cancelled terminal event
```

The deterministic transport fixture implements only `AgentServicePort` inside the verification
script; it is not shipped with the game and does not create a backend framework or alternate Agent
runtime. The automatic harness also covers safe failure parsing for `agent_model_not_configured`,
but it does not force the current Workspace into an unconfigured state. Model selection is resolved
while opening an Agent instance, so inventing a Run-only failure path would violate the Service
contract.

## Ownership

```text
GameBootstrap
  owns Token, Host child, Godot child, signals, and shutdown barrier

GameRoot
  explicitly wires AgentHostClient, CharacterWorkspaceController, and graybox UI

AgentHostClient
  owns WebSocketPeer, hello/ready, Protocol v2 parsing, request IDs, permission correlation, and transport shutdown

CharacterWorkspaceController
  owns selected Agent, current Session, active foreground Run, transcript, and screen state

UI scenes
  own controls and presentation only
```

The UI never accesses `WebSocketPeer` or JSON. The Client never chooses Agents, queues Sessions, or
interprets tasks. The Controller never starts processes or parses wire messages. Godot never imports
App, Core, Tools, or concrete Agent packages.

## Session behavior

Characters come only from `list_agents`; production game code contains no `coding` or
`financial-analysis` allowlist. Selecting a different character first closes the current Session,
waits for confirmation, and then opens the new character. Creating a new task similarly closes the
current Session before calling `create_session`. A close failure stops the transition.

On application exit the Socket is closed directly. The Host then disposes AgentService and its open
instances, avoiding an extra network close handshake that could stall process shutdown.

## Current graybox scope

Included:

- Character list and selection.
- Current/new Session transition.
- Task text input, streamed transcript, terminal status, and Cancel.
- Safe model-configuration and unsupported-interaction messages.
- Correlated access-consent presentation with approve, deny, expiry, disconnect, and close settlement.

Deferred:

- The independent side-scrolling environment.
- Character information and Build/skill tree panels.
- Foreground questions.
- Formal art, desktop distribution, reconnect, and a remote Gateway.

See [`adr/0002-godot-agent-host-client.md`](adr/0002-godot-agent-host-client.md) for the decision and
[`engine-reference/godot/VERSION.md`](engine-reference/godot/VERSION.md) for the engine pin.
