# ADR-0003: Proxy-only sandbox egress

## Status

Accepted

## Date

2026-09-03; revised 2026-09-07 after user alignment

## Context

Controlled and autonomous Process Tools currently receive either no network access or the broad
Seatbelt rule `(allow network*)`. A boolean permission cannot express which remote service was
authorized, and broad network access would let a sandboxed command bypass URL, DNS, redirect, and
destination policy enforced by in-process web Tools.

## Decision

Process Tools may reach the network only through a capability-bound HTTP CONNECT proxy. Seatbelt
allows outbound TCP to one `localhost:<port>` endpoint and denies every other network operation.
The proxy authenticates each call with an ephemeral token, resolves DNS outside the sandbox, and
enforces the exact normalized `scheme + host + port` targets authorized for that Tool Call.

The proxy environment is rebuilt for each call, includes both upper- and lower-case proxy variable
names for client compatibility, and is treated as sensitive output. Controlled and autonomous
execution never falls back to host execution. HTTPS remains end-to-end encrypted; the proxy does
not terminate TLS.

Public, private, and localhost services are ordinary targets rather than separate permission
classes. Controlled mode reuses persisted targets per workspace and Agent; autonomous mode
automatically grants declared per-call targets; unrestricted mode skips target checks and uses
host process execution. Known cloud credential metadata addresses remain sensitive in sandboxed
modes. This replaces the original unconditional private/loopback denial, which blocked local
development services. It does not broaden the Seatbelt rule or add a second authorization system.

Gateway's buffered and streaming APIs share one transport and bounded decompression pipeline.
Proxy remains only the process adapter. DNS resolution, address checks, and HTTP framing are
internal implementation concerns, not separate service layers.

## Feasibility evidence

On macOS 26.2, a deny-default profile using
`(allow network-outbound (remote tcp "localhost:<port>"))` allowed the selected loopback TCP port
while denying another loopback port, direct public IP access, external DNS, and UDP. Sandboxed
`curl`, `git`, `npm`, and `pnpm` completed HTTPS requests through an authenticated CONNECT proxy.
Git required both standard proxy configuration and a valid `Proxy-Authenticate` challenge; the
environment projection therefore cannot rely on upper-case variables alone.

## Consequences

- The Rust sandbox protocol must represent a disabled route or one loopback proxy port.
- The Network Gateway, not the sandbox profile, owns destination and SSRF policy.
- Proxy-unaware clients fail closed.
- The Seatbelt rule names `localhost`, so proxy authentication remains mandatory even though the
  listener binds the selected port.
- Production supports authorized local upstreams. Exact target authorization no longer guarantees
  that an approved hostname resolves to a public IP; this is an intentional trade-off for local
  development. Cloud metadata address checks are bounded known-address protection, not exhaustive
  cloud-provider discovery.

## Validation

- Exact-port allow and adjacent-port deny tests run on macOS.
- Direct IP, DNS, and UDP remain denied.
- Token reuse after call settlement is rejected.
- Pending DNS cannot initiate new traffic after revocation; stream failure and cancellation close
  upstream resources; decoded proxy responses carry consistent framing.
- Process output, diagnostics, and traces redact proxy credentials.
- No `(allow network*)` rule remains in the production policy compiler.
