# ADR-HOST-001: Agent Host Protocol v2 atomic migration

## Status

Accepted — 2026-09-03

## Decision

Protocol v2 directly replaces v1 in the TypeScript Host and Godot client. There is no dual stack.
It adds correlated, expiring `permission.requested` and `permission.resolved` events plus an explicit
permission-resolution request. Presentation data is bounded and sanitized; credentials, proxy
tokens, raw sensitive environments, and unsanitized Tool input are never projected.

The App-owned consent broker owns pending permission lifecycle. Agent Host remains a transport-only
adapter over `AgentServicePort`; Godot owns only strict wire parsing and presentation state.
Disconnect, close, denial, approval, cancellation, and expiry all settle deterministically.
