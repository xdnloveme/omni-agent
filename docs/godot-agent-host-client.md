# Godot Agent Host Client

`apps/omni-game` is the Godot 4.7.2 side-scrolling workshop client for the local `omni-host`. It is another UI for
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

The headless suite checks strict Protocol v2 parsing, real-transport Run/Cancel/shutdown behavior,
Controller recovery and conversation state, permission correlation, and real Host composition.
It also runs the world and UI regressions listed in the
[workshop verification guide](godot-workshop-environment.md#verification); use `--visual` for
rendered selection and both production characters in Main.

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
runtime. The real composition harness uses its own temporary HOME and Workspace, with an explicit
session-only provider pointed at a closed loopback endpoint. It never reads the repository's model
configuration or requires developer credentials. Godot still loads the real project from the repository;
the Host TypeScript loader is resolved from the installed application, independently of its Workspace.
The automatic harness also covers safe failure parsing for `agent_model_not_configured`.
Model selection is resolved
while opening an Agent instance, so inventing a Run-only failure path would violate the Service
contract.

## Ownership

```text
GameBootstrap
  owns Token, Host child, Godot child, signals, and shutdown barrier

GameRoot
  explicitly wires the client, Controller, world, and one menu/task/info/permission overlay state

AgentHostClient
  owns WebSocketPeer, hello/ready, Protocol v2 parsing, request IDs, permission correlation, and transport shutdown

CharacterWorkspaceController
  owns selected Agent, current Session, active Run and current-open-Session conversation messages

WorkshopWorld and its world nodes
  own spatial intent, movement, ladder state, and camera composition; never Sessions

CharacterPresentationCatalog
  owns portrait, role-title, and accent decoration only; it is not an Agent allowlist

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
current Session before calling `create_session`. A close failure stops the transition. If the old
Session closes but its replacement cannot be opened or created, the Controller returns to character
selection rather than presenting a workspace backed by a stale Session. Session responses must
belong to the requested Agent; a mismatch closes the Client because its state can no longer be
reconciled safely.

The catalog contains two production appearances: the male and female mages. Agents without a
dedicated presentation share the male mage's portrait and animation resources while retaining
their Host-provided name and a generic role. No retired companion artwork is loaded.

The in-world conversation uses one right-side panel that can expand without changing scenes.
Minimizing preserves the Session, running task, draft and reading context; only Stop requests
cancellation. While a task runs the player may move in the world and reopen the conversation.
The controller retains received turns until the Session is replaced. Protocol v2 has no history
replay or tool-detail events, so this does not claim cross-restart chat history or fabricate tools.
See [the conversation UX contract](agent-conversation-ux.md) for interaction and ownership rules.

Cancel has one Controller-owned pending state per active Run. Repeated clicks do not create
additional protocol requests, and the UI remains pending until the real terminal Run event arrives.

Permission decisions are correlated separately from Session and Run commands in `AgentHostClient`.
A rejected decision is delivered to its permission panel, not the Session controller. If settlement
already removed that permission, a late reply leaves the current queue, Session, and connection
unchanged; otherwise the panel shows the error and allows another decision. The real Host/broker
regression covers cancellation during decision submission and a subsequent Run in the same Session.

On application exit the Socket is closed directly. The Host then disposes AgentService and its open
instances, avoiding an extra network close handshake that could stall process shutdown.

## Scope and related contracts

Current controls, furniture behavior, production artwork, display limits, and gameplay verification
belong to the [workshop guide](godot-workshop-environment.md). Conversation presentation belongs to
[the conversation contract](agent-conversation-ux.md); this page owns startup, transport, and Session
behavior. Desktop distribution, reconnect/replay, foreground questions, and a remote Gateway remain
deferred.

See [ADR-0002](adr/0002-godot-agent-host-client.md) for the client decision,
[ADR-0003](adr/0003-godot-workshop-environment.md) for the spatial boundary,
[ADR-0004](adr/0004-godot-character-information.md) for INFO ownership, and
[the engine pin](engine-reference/godot/VERSION.md).
