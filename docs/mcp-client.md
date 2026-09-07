# MCP client

The App layer owns MCP configuration, lifecycle, catalog, credentials, OAuth, instructions, and
diagnostics. The official TypeScript Client v2 is lockfile-pinned and protocol negotiation is pinned
to `2026-07-28`; incompatible servers fail with `mcp_protocol_mismatch`.

Streamable HTTP is granted the configured server URL plus separately declared issuer,
authorization, and token endpoint targets. It uses NetworkGateway for GET/POST. Stdio is explicit
trusted local code, receives only allowlisted environment variables, and is not described as
Seatbelt-isolated. OAuth redirect state, PKCE verifier, client registration, access token, refresh
token, and discovery state use the Keychain-backed credential port and never enter config, Session,
Tool results, logs, Host events, or CLI output.

Activation validates the whole server catalog before `ToolRegistry.replaceOrigin`. Limits are 16
servers, 128 tools per server, 64 KiB per schema, 64 KiB instructions, 2 MiB raw catalog, and 32,000
estimated prompt tokens. Nothing is silently truncated. Names use
`mcp__<normalized-server-id>__<normalized-tool-name>` and collisions fail closed.

Configure connection definitions under `mcp.servers` in `omni.config.json`. In the TUI, `/mcp`
opens the server list; select a server to turn its switch on/off or retry catalog discovery.
The App owns persisted activation intent in `mcp-activation.json` under the workspace/Agent storage
directory, using a file lock, atomic replacement, and mode `0600`. Configuration does not contain
an `enabled` switch. Disabled servers are not contacted. Enabled servers are restored at startup,
after terminal input starts so network-consent requests can be answered. Switching is rejected
while the Agent is running. Disabling removes that server's tools and instructions.

Activation goes through ToolCallCoordinator, including network consent and the management Tool's
120-second timeout. A failed refresh preserves the previous valid catalog; cancellation is checked
immediately before atomic registration. The 32,000-token catalog budget also applies across active
servers. `ready` means catalog-ready, not an assertion of remote liveness. Stdio retains the SDK
client/process across discovery and calls until disable or application disposal; unexpected
disconnects require explicit `/mcp` retry. Failed initial activation closes its process, while a
failed catalog refresh preserves the previous valid catalog. Raw stdio stderr is ignored (including
the SDK's discovery sibling), avoiding secret-bearing logs and unread-pipe backpressure.

HTTP transports remain operation-scoped because each owns a different authorized network client.
They close in `finally`, never retaining a grant across calls. This deliberately trades repeated
discovery overhead for a simple authorization boundary; it is not the stateful stdio lifecycle.

OAuth activation uses the host interaction port. The CLI pauses the TUI and reuses the existing
authentication component to display the authorization URL and collect a masked, manually pasted
callback URL. It resumes the TUI in `finally`. Callback input never goes through the conversation
editor or Session. App validates origin/path and state; the official SDK owns PKCE, issuer checking
and token exchange, all through the activation's bound Gateway client. Settled authorization
attempts clear temporary state and verifier, including cancellation; round-trip secrets remain in
the call-local sanitizer until settlement. Ordinary
Tool calls never open interactive login: they report `mcp_authorization_required` and ask the user
to retry through `/mcp`. Hosts without this interaction report an explicit unavailable error.

The existing activation Tool deadline and linked host/operation cancellation apply; there is no
additional task-wide timer. Tests exercise the real SDK against a synthetic OAuth Gateway, including
state rejection, cancellation and redaction. Real provider login and interactive terminal use are
not claimed verified. Automatic browser launch and a loopback callback listener are not implemented.

The pinned SDK merges platform-default environment variables into stdio process environments.
Before spawning, Omni requires all SDK-default names to appear explicitly in `inheritEnvironment`;
otherwise activation fails with `mcp_stdio_environment_not_authorized`. On macOS these are `HOME`,
`LOGNAME`, `PATH`, `SHELL`, `TERM`, and `USER`. Omni does not add them to configuration automatically.
Allowlisted values come from the captured host environment, and stdio cwd is resolved against the
Agent workspace rather than the host process cwd.

Tool results preserve audio, resource links, embedded resources, annotations, and structured
content through Session and Context. The model adapter emits only its supported text/image blocks,
keeps the original rich content in internal message details, projects structured JSON as model-visible
text, and omits user-only annotated content (including text/image) from model and checkpoint input.
Checkpoint projection versions invalidate summaries generated under the previous projection contract.
MCP `_meta` is accepted only as JSON up to 64 KiB and remains result
metadata rather than model content. Known bearer, OAuth, verifier, state, and authorization-code
values are exact-redacted from MCP results and errors at the App boundary.
