# IM Gateway

The IM Gateway connects one or more Feishu/Lark bots to independently hosted Omni Agent sessions.
Phase one uses separate processes on the same machine and communicates only through loopback
WebSocket Protocol v1.

## Security model

Each bot binds one Agent id, one canonical workspace root, and one private state directory. The IM
Host resets execution settings to Controlled mode with Tool network disabled and no approved
filesystem roots before startup. It loads model and Agent configuration from the private state
directory rather than the writable workspace, and it disables local ESM extensions.

The gateway never copies Feishu credentials into the Agent Host environment. Model credentials must
be stored through Omni's credential store; environment-variable model credentials are not supported
for the IM Host.

## Configuration

Set `OMNI_IM_CONFIG` or create `~/.omni-agent/im/config.json`:

```json
{
  "version": 1,
  "stateFile": "/Users/example/.omni-agent/im/gateway-state.json",
  "bots": [
    {
      "id": "coding",
      "agentId": "coding",
      "projectDirectory": ".",
      "stateDirectory": "/Users/example/.omni-agent/im/bots/coding",
      "allowUsers": ["ou_example"],
      "concurrency": "concurrent",
      "lark": {
        "appId": "cli_0000000000000000",
        "appSecretEnv": "LARK_CODING_APP_SECRET"
      },
      "host": {
        "mode": "managed"
      }
    }
  ]
}
```

Secret values are forbidden in the JSON file. Only environment-variable names are accepted.
Paths are resolved relative to the configuration file; expand `~` before writing the JSON because
the loader does not perform shell expansion. The configuration file, gateway state file, and every
bot state directory must resolve outside every Agent-writable workspace; symbolic-link targets are
included in this check. The gateway state file must not overlap a bot state directory. Managed Host
entrypoints are selected by the trusted `apps/omni` composition root and are not configurable. A bot
with missing runtime credentials is disabled with a diagnostic while other valid bots continue to
start.

`projectDirectory` must equal the canonical workspace root resolved by Omni. If a configured
subdirectory belongs to a parent Git repository, the Host refuses to start rather than widening the
filesystem boundary.

## Lifecycle

Managed mode starts one trusted IM Agent Host process for each bot, reads its bounded ready record,
authenticates with an ephemeral token, verifies the configured Agent is available, and restarts the
Host with bounded backoff after a crash. Attached mode connects to a loopback Host started by an
external process manager.

Conversation records persist the actual Session UUID returned by `create_session`. Duplicate Lark
messages are persisted before dispatch. Tasks left accepted, queued, or running across a gateway
restart become `unknown` and are never replayed automatically. Recovery records retain enough
message-target information to notify the originating conversation. Deduplication events and terminal
task records expire together after seven days. Recovery notices remain pending and are retried after
restart until presentation succeeds.

## Interaction

Phase one accepts direct `text` and `post` messages. `/stop` cancels the active request in the current
conversation. Other natural language is passed unchanged to the configured Agent. Streaming output
is rendered through an updateable message card with bounded update frequency. The gateway reports
ready only after at least one bot establishes its Lark long connection and verifies its Agent.

## Running

```bash
pnpm dev:im
pnpm verify:im
```

The Lark application requires bot capability, `im.message.receive_v1`, message reply/send
permissions, and long-connection event delivery.
