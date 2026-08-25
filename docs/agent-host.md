# Agent Host WebSocket Protocol v1

`@omni-agent/agent-host` is the local WebSocket adapter for `AgentServicePort`. Its only business
dependency is the injected Service Port. It does not create Agents, load packages, inspect Session
persistence, schedule Runs, execute Tools, configure models, or dispose Host-owned services.

## Ownership

```text
apps/omni owns Config, Model, Catalog, Factory, AgentService, and AgentHostServer
AgentHostServer owns HTTP/WebSocket, connection timers, writer, and AbortControllers
AgentService owns AgentInstance, Session lifecycle, FIFO, Run, and cancellation settlement
```

Shutdown order is Host, AgentService, ModelService. `AgentHostServer.close()` never disposes the
injected Service.

## Process contract

The standalone `omni-host` entry binds one Workspace from its process `cwd`. Its parent process
must inject `OMNI_AGENT_HOST_TOKEN`, an unpadded Base64URL encoding of 32 random bytes. This is a
process-to-process contract, not a developer configuration value. The optional
`OMNI_AGENT_HOST_PORT` is an integer from 0 to 65535 and defaults to 0.

Successful startup writes exactly one machine-readable stdout record:

```json
{ "type": "agent_host_ready", "version": 1, "host": "127.0.0.1", "port": 43127 }
```

Startup failure writes `agent_host_failed` without paths, credentials, or stack details; diagnostic
detail goes to stderr. The Host listens only on `127.0.0.1`, accepts one authenticated client, and
exits after that client disconnects.

## Protocol

The first message must be `{ "v": 1, "type": "hello", "token": "..." }`. Authentication has a
five-second deadline. Token comparison is fixed-length and constant-time. Tokens are never accepted
through URLs, headers, or cookies.

After authentication the client may send `list_agents`, `open_session`, `create_session`,
`close_session`, `run`, and `cancel`. A Run's protocol `id` is its Service `requestId`. The Host keeps
only connection-level active IDs and AbortControllers; it does not add business locking or Session
queues. Responses are `result`, `event`, or a safe `error` containing only `code`, `message`, and
`retryable`.

One bounded writer serializes Socket writes without combining or reordering Service events. Inbound
messages are limited to 64 KiB, text input to 32,768 characters, request IDs to 128 safe characters,
and outbound buffering to 1 MiB. Compression and binary messages are disabled. Backpressure,
disconnect, and explicit cancel stop consumption of the Service `AsyncIterable` and abort the
connection-owned signal.

### Wire messages

Every client message is a UTF-8 JSON object with `v: 1` and `additionalProperties: false` semantics.
Binary frames are rejected. Request IDs must match `[A-Za-z0-9._:-]+`, contain 1–128 characters,
and be unique while active on the connection.

Authentication is the first message:

```json
{ "v": 1, "type": "hello", "token": "<43-character Base64URL value>" }
```

Successful authentication returns:

```json
{ "v": 1, "type": "ready", "connectionId": "<UUID>" }
```

After `ready`, the client may send:

| Request type     | Required fields                      | Optional fields |
| ---------------- | ------------------------------------ | --------------- |
| `list_agents`    | `id`                                 | —               |
| `open_session`   | `id`, `agentId`                      | `sessionId`     |
| `create_session` | `id`, `agentId`                      | —               |
| `close_session`  | `id`, `agentId`, `sessionId`         | —               |
| `run`            | `id`, `agentId`, `sessionId`, `text` | —               |
| `cancel`         | `id`, `requestId`                    | —               |

Examples:

```json
{ "v": 1, "id": "agents-1", "type": "list_agents" }
{ "v": 1, "id": "open-1", "type": "open_session", "agentId": "coding" }
{ "v": 1, "id": "create-1", "type": "create_session", "agentId": "coding" }
{ "v": 1, "id": "close-1", "type": "close_session", "agentId": "coding", "sessionId": "session-1" }
{ "v": 1, "id": "run-1", "type": "run", "agentId": "coding", "sessionId": "session-1", "text": "Inspect this repository" }
{ "v": 1, "id": "cancel-1", "type": "cancel", "requestId": "run-1" }
```

Unary operations return one `result` or one `error` with the same `id`:

```json
{
  "v": 1,
  "type": "result",
  "id": "agents-1",
  "result": {
    "kind": "agents",
    "agents": [
      {
        "id": "coding",
        "displayName": "Coding Agent",
        "description": "...",
        "packageName": "@omni-agent/agent-coding",
        "packageVersion": "0.0.1"
      }
    ]
  }
}
```

Result payloads are:

| Result kind        | Payload                                   |
| ------------------ | ----------------------------------------- |
| `agents`           | `agents: AgentServiceAgent[]`             |
| `session`          | `session: { agentId, sessionId }`         |
| `closed`           | no additional fields                      |
| `cancel_requested` | `requestId`, identifying the targeted Run |

A submitted Run produces `event` messages instead of a unary result:

```json
{
  "v": 1,
  "type": "event",
  "requestId": "run-1",
  "event": { "type": "text_delta", "text": "partial output" }
}
```

The event order is:

```text
started
→ text_delta*
→ final_response?
→ completed | failed | cancelled
```

`started` contains `requestId` and `sessionId`. `text_delta` and `final_response` contain `text`.
`failed` contains `code`, `message`, and `retryable`. A Run has exactly one terminal event. Failure
before Run submission returns a top-level `error` and produces no Run events.

Errors use a safe projection and never include stacks, causes, credentials, local paths, package
sources, or request text:

```json
{
  "v": 1,
  "type": "error",
  "id": "open-1",
  "error": {
    "code": "session_not_found",
    "message": "...",
    "retryable": false
  }
}
```

Host-owned error codes are:

| Code                  | Meaning                                        |
| --------------------- | ---------------------------------------------- |
| `invalid_message`     | JSON or message shape is invalid               |
| `unsupported_version` | `v` is not supported                           |
| `unauthorized`        | authentication failed                          |
| `host_busy`           | client or outbound transport is not keeping up |
| `duplicate_request`   | the connection already has an active `id`      |
| `request_not_active`  | a Cancel target is not active                  |
| `payload_too_large`   | the inbound message exceeds 64 KiB             |
| `host_closed`         | the transport is closing or closed             |

Service failures preserve the safe App-level code. Common codes include `agent_not_available`,
`session_not_found`, `session_not_open`, `session_opening`, `session_closing`, `duplicate_request`,
`agent_service_closed`, `agent_model_not_configured`, and `interaction_unavailable`. Unknown
internal errors become `agent_service_operation_failed`.

### Limits and connection lifecycle

| Limit                   | Value             |
| ----------------------- | ----------------- |
| Listen address          | `127.0.0.1`       |
| Authenticated clients   | 1                 |
| Authentication deadline | 5 seconds         |
| Inbound message         | 64 KiB            |
| Run text                | 32,768 characters |
| Request ID              | 128 characters    |
| Session ID              | 256 characters    |
| Outbound buffer         | 1 MiB             |
| Heartbeat interval      | 30 seconds        |
| WebSocket compression   | disabled          |

An active request ID is released after its unary result/error or Run terminal event and may then be
reused. Cancel acknowledges only that cancellation was requested; the targeted Run owns its final
terminal event. After the authenticated client disconnects, the v1 Host closes and does not wait
for reconnection. There is no replay or Run recovery.

Clients may observe close code `1002` for unsupported versions, `1003` for binary frames, `1008`
for authentication failure or timeout, `1011` for an unrecoverable transport failure, and `1013`
for outbound backpressure. Normal Host shutdown uses `1001`. Upgrade requests with an invalid Host
header or path are rejected before WebSocket establishment; additional clients are rejected while
the single connection slot is occupied.

## Data flow

```text
Godot / test client
→ WebSocket hello and Protocol v1 request
→ AgentHostConnection validates and correlates the request
→ AgentServicePort owns Agent availability, Session state, FIFO, and Run
→ AgentApplication / Core executes the Agent and Tools
→ AgentServiceEvent AsyncIterable
→ the single OutboundWriter serializes events
→ WebSocket client
```

For a Run, the protocol request `id` is passed unchanged as the Service `requestId`. The Host adds
only a connection-owned `AbortController`; it does not create another Run identifier or queue.
Cancel, disconnect, or outbound backpressure aborts that controller. AgentService remains
responsible for settling the queued or active Run and producing its single terminal event.

## Local verification

Developers do not need to create or copy authentication Tokens. From the repository root, run:

```bash
pnpm verify:host
```

The verification launcher generates a Token in memory, injects it only into the child Host process,
authenticates, calls `list_agents`, closes the client, and waits for clean process shutdown. A
successful result is:

```json
{ "type": "agent_host_verified", "version": 1, "agents": ["coding", "financial-analysis"] }
```

Once the Godot gateway exists, Godot will own Token generation and the child-process lifecycle
directly. The focused automated suite is:

```bash
pnpm exec vitest run packages/agent-host/src/__tests__ apps/omni/src/agent-host-process.test.ts
```

## V1 limitations

- Model configuration must already exist.
- Foreground Agent interaction is unavailable.
- Dynamic access consent is denied.
- There is no reconnect, replay, multi-client, multi-Workspace, HTTP API, or dynamic Agent source.
- `create_session` creates a conversation/task save, not a new Agent package.

See [`agent-service.md`](agent-service.md) for the business lifecycle and
[`adr/0001-agent-host-websocket.md`](adr/0001-agent-host-websocket.md) for the decision record.
