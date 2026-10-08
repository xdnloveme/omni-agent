# ADR-INS-001: Batch-level project instruction ScopeGate

## Status

Accepted — 2026-09-03

## Context

Loading only root or current-directory `AGENTS.md` misses rules for target files, while loading rules
after a Tool starts is too late. Bash may address multiple sibling scopes or an unbounded dynamic
write target.

## Decision

The coding Agent owns discovery and a batch preparation policy. Core exposes only the generic
two-stage `ToolCallCoordinator` and policy port. The policy derives targets from prepared access
facts, loads every applicable root-to-target lineage, labels sibling contributions with `appliesTo`,
and defers the entire ready portion of a batch when a new digest is activated. It revalidates file
identity, size, mtime, and digest before authorization and again after consent, before execution. Unbounded dynamic mutation
fails closed; external approved roots are not scanned.

## Consequences

No Tool executes under newly discovered rules in the same model turn. Deferrals consume their own
budget but not executed-Tool budget. A residual race between final revalidation and OS execution is
documented and not disguised by a compatibility path.

Policies share one Core evaluation path for Agent and Hook origins. A command Hook cannot activate
rules on behalf of the model: changed rules reject that Hook without committing the discovery
snapshot. The next Agent call still defers and receives the rules. Removed sources are explicitly
revoked by a complete active-rule snapshot. Policy exceptions produce failed ToolResults so the
Assistant/tool-result transcript remains paired.
