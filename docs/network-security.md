# Network security

Network authorization is an exact normalized `(scheme, ASCII host, explicit port)` capability.
Public, private, IP-literal, and localhost targets use the same authorization policy. Controlled
mode may persist at most 64 exact targets per workspace and Agent: approved targets do not prompt
again. Autonomous mode automatically grants declared targets for one call without consent or
persistence. Unrestricted mode bypasses target checks and consent; protocol, cancellation,
redirect-count, response-size, and Tool timeout checks remain. Userinfo and wildcard targets are
not supported. Known cloud credential metadata IPs require unrestricted mode; this is not a
general classifier for every possible cloud metadata endpoint.

Use `/permissions` to choose the mode and review/revoke saved targets. Configure several targets
once with `/permissions network add http://localhost:3000 http://192.168.1.10:8080 https://example.com`.
This reuses Execution Settings v6, including its atomic persistence and workspace/Agent boundary.
Changing the mode never silently grants another workspace or Agent access.

Controlled consent gathers all missing filesystem scopes and network targets for one Tool call
into a single approve-or-deny request. Approval saves both categories in one existing settings
transaction; rejection leaves existing grants unchanged. Subsequent tools in the same workspace
and Agent reuse those grants. Identical pending requests still share consent, but different Tool
calls are not aggregated into a batch-wide approval. TUI and Godot explicitly identify approval
as persistent, not one-shot. Autonomous and unrestricted calls do not open resource-consent UI.

In-process Tools receive only `AuthorizedNetworkClient`. Controlled and autonomous Process Tools
receive sanitized upper/lower-case proxy variables for a random authenticated `127.0.0.1` proxy.
Seatbelt permits only that loopback TCP port. The Gateway resolves DNS, checks every answer for
sensitive metadata addresses, pins the selected IP, and rejects cross-origin redirects in every
mode (credentials must not be forwarded to another origin). A hostname grant authorizes its current ordinary addresses, including local ones; it is not
an IP allowlist. HTTPS uses CONNECT without TLS interception.
There is no broad network rule or Host fallback.

The HTTP process proxy forwards GET, HEAD, POST, PUT, PATCH, DELETE, and OPTIONS through the
same Gateway. Uploads are buffered up to 8 MiB per request; larger uploads return 413 before
upstream dispatch. Non-GET redirects remain rejected, so mutation requests are not replayed.
`web_fetch` remains GET-only. These are per-operation bounds, not cumulative Run limits.

The bound client and any per-call proxy expire when the Tool call settles, is cancelled, or times
out. In-process calls do not open a proxy listener. Unrestricted mode skips target consent but does
not bypass Tool-owned hard stops or domain denials.

Buffered and streaming HTTP share one request/decompression pipeline. Stream failures and reader
cancellation tear down every stage. Decoded responses remove compressed framing headers. Proxy
revocation cancels active requests and connections, and rechecks cancellation after DNS resolution
before opening any new socket. OS DNS work may finish later but cannot create post-revocation traffic.

The deterministic harness uses local upstreams, including the production resolver for loopback.
Malformed gzip, body limits, consumer cancellation, pending-DNS revocation, and decoded proxy
framing are regression-tested. Public smoke tests are opt-in. No task-wide timeout is introduced.
