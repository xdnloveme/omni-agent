# ADR-0001: Agent Service WebSocket Host

## Status

Accepted

## Date

2026-08-25

## Engine Compatibility

| Field                 | Value                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------- |
| Engine                | Not applicable in v1; no Godot code or API is implemented                               |
| Domain                | Networking / process composition                                                        |
| Knowledge Risk        | Low; Node.js and `ws` contracts are verified by build and integration tests             |
| References Consulted  | Repository architecture, `AgentServicePort`, `ws` package contract                      |
| Post-Cutoff APIs Used | None                                                                                    |
| Verification Required | Real WebSocket authentication, streaming cancellation, shutdown, and distribution build |

## ADR Dependencies

| Field         | Value                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| Depends On    | The accepted Agent Service boundary documented in `docs/agent-service.md` |
| Enables       | Godot Agent Host client and game UI vertical slice                        |
| Blocks        | Godot client integration should not begin before Protocol v1 is stable    |
| Ordering Note | Interaction and consent adapters remain separate follow-up decisions      |

## Context

`AgentServicePort` provides the process-local discovery, Session, Run, cancellation, and safe
failure boundary needed by non-terminal Hosts. A game client needs bidirectional streaming and
cancellation without importing App internals or creating another Agent execution path.

The first consumer is a local Godot companion process. The implementation must remain loopback-only,
authenticated, bounded, and independent of any game engine API.

## Decision

Create `@omni-agent/agent-host` as a concrete WebSocket Protocol v1 adapter. It depends on
`@omni-agent/app` as its only workspace package and receives `AgentServicePort` as its only business
collaborator. Node's HTTP server owns the upgrade boundary, `ws` owns WebSocket framing, and Ajv
validates a closed JSON schema.

`apps/omni` remains the process Composition Root and ships a separate `omni-host` entry. It creates
Catalog, Factory, Service, model, process, and Host resources and disposes them in ownership order.
The existing `omni` CLI entry remains unchanged.

```text
Godot -> WebSocket Protocol v1 -> packages/agent-host -> AgentServicePort
                                               apps/omni owns composition
```

The Host owns only connection state, request correlation, outbound serialization, heartbeat,
backpressure, and connection-created AbortControllers. Agent availability, Session state, FIFO,
Run terminal state, and AgentInstance ownership remain in `AgentService`.

## Alternatives Considered

### Implement WebSocket framing directly

Rejected because handshake, framing, close, heartbeat, payload, and backpressure behavior are
security-sensitive protocol mechanics already implemented by `ws`.

### Add Fastify, Hono, or Socket.IO

Rejected because v1 has no HTTP application, routing, rooms, fallback transports, or middleware
requirements. These frameworks would add unrelated lifecycle and protocol behavior.

### Keep the adapter inside `apps/omni`

Rejected because the wire contract and transport lifecycle need focused tests and reuse by the
Godot client harness without moving process composition into the transport owner.

### Create a generic Transport framework

Rejected because there is only one real Adapter. Shared dispatch abstractions will be considered
only after a second concrete Adapter demonstrates meaningful duplication.

## Consequences

Positive:

- One network entry and one Agent execution path.
- `packages/app` remains unaware of WebSocket and Godot.
- Transport security, cancellation, and compatibility are independently testable.
- Existing CLI behavior remains unchanged.

Negative and accepted trade-offs:

- Protocol v1 becomes a compatibility boundary once consumed by Godot.
- The Host Composition temporarily reuses the CLI-owned default Catalog factory.
- v1 rejects foreground interaction and access consent rather than transporting them.
- One authenticated client and one Workspace are supported per process.

## Performance Implications

- CPU: JSON validation and serialization per message.
- Memory: 64 KiB inbound messages and a 1 MiB outbound-buffer ceiling.
- Network: loopback-only WebSocket, no compression, ordered writes per connection.

## Validation Criteria

- Architecture guards prove `agent-host -> app` is the only workspace dependency.
- Contract tests prove each message calls at most one `AgentServicePort` method.
- Disconnect, cancel, and backpressure stop Service stream consumption.
- Host close does not dispose AgentService.
- The distribution contains both `omni` and `omni-host` launchers.

## Related Decisions

- [`../agent-service.md`](../agent-service.md)
- [`../architecture.md`](../architecture.md)
- [`../tracing.md`](../tracing.md)
