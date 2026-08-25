# ADR-0002: Godot Agent Host Client

## Status

Accepted

## Date

2026-08-26

## Engine Compatibility

| Field                 | Value                                                                  |
| --------------------- | ---------------------------------------------------------------------- |
| Engine                | Godot 4.7.2 stable                                                     |
| Language              | GDScript                                                               |
| Domain                | Local game client / companion-process lifecycle                        |
| Knowledge Risk        | High; the pinned engine version postdates the prior knowledge baseline |
| References Consulted  | Godot 4.7 `WebSocketPeer`, `OS`, and `JSON` documentation              |
| Post-Cutoff APIs Used | `WebSocketPeer` and current Godot 4.7 project/script behavior          |
| Verification Required | Pinned-engine import, protocol harness, and real Host process harness  |

## ADR Dependencies

| Field         | Value                                                             |
| ------------- | ----------------------------------------------------------------- |
| Depends On    | ADR-0001 and the stable WebSocket Protocol v1                     |
| Enables       | Character selection, Session tasks, streaming Runs, and game UI   |
| Blocks        | Visual game work should not bypass `CharacterWorkspaceController` |
| Ordering Note | A remote Gateway abstraction requires a second real backend first |

## Context

The repository has one concrete backend: the local `omni-host` companion process. Adding a generic
Gateway, backend Port, or RPC framework before a second backend exists would duplicate the stable
Host boundary without proving useful variation. The client must also hide the authentication Token
and coordinate two child processes without moving process responsibilities into Godot.

## Decision

Create a Godot 4.7.2 GDScript application at `apps/omni-game`. A concrete `AgentHostClient` connects
directly to WebSocket Protocol v1. It owns Socket polling, authentication, strict response parsing,
request correlation, and connection cancellation. It is not a domain Gateway and has no interface.

`CharacterWorkspaceController` owns character, Session, foreground Run, transcript, and screen
state. UI scenes call the Controller and never parse JSON or touch `WebSocketPeer`.

`GameBootstrap` in `apps/omni` owns the ephemeral Token and both child processes. It starts the Host
with the developer's original working directory, waits for its machine-readable ready record, then
starts Godot with the connection values in its environment. Godot consumes and removes those values.

```text
Godot UI
  -> CharacterWorkspaceController
  -> AgentHostClient
  -> WebSocket Protocol v1
  -> omni-host
  -> AgentServicePort
```

## Alternatives Considered

### Add a Gateway or backend Port now

Rejected because there is only one real backend and one protocol. A second remote backend may have
materially different authentication, Workspace, reconnect, and Session semantics; guessing that
interface now would increase coupling rather than reduce it.

### Start the Host from Godot

Rejected because Godot's process API is not the correct owner for per-child credentials and the
combined Host/game shutdown barrier. A Node parent already has direct access to the existing Host
entry and repository composition.

### Put Session switching in the Client

Rejected because close-then-open/create is game interaction state, not wire behavior. Keeping it in
the Controller prevents the protocol client from becoming a second Agent Service.

## Consequences

Positive:

- One concrete Client and one Agent execution path.
- Developers never create, copy, or pass the authentication Token.
- Host Workspace remains the directory from which `pnpm game` was run.
- Process, protocol, interaction, and presentation lifecycles have separate owners.
- Future visual work can replace graybox scenes without changing protocol handling.

Negative and accepted trade-offs:

- Protocol v1 shapes exist in TypeScript JSON Schema and strict GDScript parsing.
- v1 supports macOS development only and is not part of the distribution build.
- Real model streaming needs configured credentials and remains a manual Smoke test.
- Foreground interaction and consent are intentionally unavailable through this Host.

## Validation Criteria

- Godot 4.7.2 imports the project without script errors.
- The protocol harness rejects malformed and extra-field messages.
- The deterministic real-transport harness proves ordered Run delivery, Cancel, and Socket shutdown.
- The real harness authenticates, lists both built-in Agents, and opens, closes, and creates Sessions.
- Host-first and Godot-first child exit observations both converge without orphan processes.
- No production Godot script hardcodes a concrete Agent ID.
- No Gateway, backend Port, second Session queue, or alternate Run path exists.

## Related Decisions

- [`0001-agent-host-websocket.md`](0001-agent-host-websocket.md)
- [`../godot-agent-host-client.md`](../godot-agent-host-client.md)
- [`../agent-host.md`](../agent-host.md)
- [`../architecture.md`](../architecture.md)
