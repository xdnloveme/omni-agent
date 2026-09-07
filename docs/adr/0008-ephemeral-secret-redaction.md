# ADR-SEC-001: Ephemeral secret redaction boundary

## Status

Accepted — 2026-09-03

## Decision

Core's shared sanitizer owns exact per-call secret redaction. Proxy credentials, authorization and
cookie values, OAuth codes/tokens/verifiers, and other runtime-marked secrets are passed as a
non-serializable `SensitiveValueSet` to process collection, results, observations, diagnostics,
Session, stream, and Host projections. Streaming redaction retains enough overlap to catch a value
split across chunks. The set is discarded when the call settles.

This boundary prevents accidental plaintext projection. It does not claim to stop a malicious
program from transforming a secret; target-scoped network capability remains the exfiltration
boundary.
