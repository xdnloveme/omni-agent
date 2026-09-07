# ADR-MCP-001: MCP 2026-07-28 baseline and ToolResult phasing

## Status

Accepted — 2026-09-03

## Decision

Omni Agent uses the official TypeScript Client v2 pinned by the lockfile and pins negotiation to
MCP revision `2026-07-28`. Streamable HTTP uses a bound Network Gateway client; configured stdio is
a trusted local integration with an environment allowlist. Each server catalog is validated and
atomically replaced, with hard limits for servers, tools, schemas, instructions, raw bytes, and
prompt tokens. MCP Tools are ordinary registered Tools and enter only through `ToolCallCoordinator`.

OAuth tokens, refresh tokens, PKCE verifiers, state, and registered-client records use the
Keychain-backed credential port. The host validates redirect origin/path and state before handing
callback parameters to the SDK. Server and OAuth endpoints are independent exact network targets.

The CLI reuses its existing masked authentication interaction for manually pasted callbacks;
interactive authorization occurs during activation only, never inside ordinary Tool calls.
Stdio retains the SDK process for the enabled server lifetime. HTTP keeps operation-scoped
transports to preserve per-call grants, accepting repeated discovery overhead. Application disposal
awaits MCP cleanup through the same resource-disposal aggregation as its other owned resources.

Tool results retain text, image, structured content, audio, resource links, embedded resources,
annotations, `isError`, and bounded metadata across Session, context, stream, Host, and providers.
Unknown content fails explicitly rather than being flattened or dropped.
