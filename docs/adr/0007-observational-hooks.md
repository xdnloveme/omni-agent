# ADR-HOOK-001: Post-event observational Hooks

## Status

Accepted — 2026-09-03

## Decision

The first Hook surface contains only `run.completed`, `run.failed`, `tool.completed`, and
`permission.resolved`. Typed Hooks receive detached deeply immutable snapshots. Command Hooks enter
the existing Tool coordinator with `origin=hook`, complete access/planning/timeout/audit, discard
bounded output, do not enter Session or model context, do not retry, and do not recursively emit
Hooks. Failures produce diagnostics and cannot revise the completed operation.

Blocking before-model or before-tool Hooks are intentionally absent.

The Run owner dispatches terminal Hooks once, before delivering the terminal Agent event.
Iteration phases do not dispatch Run Hooks. Structured failures and thrown failures use the same
terminal path; cancellation does not emit a failure Hook.

Command Hooks reuse the referenced Tool's declared timeout through OperationDeadlineSupervisor;
there is no additional Hook timer. Runs record elapsed time but impose no total wall-clock deadline.
Typed Hooks remain trusted in-process callbacks; this change does not invent a separate timeout
contract for them.
