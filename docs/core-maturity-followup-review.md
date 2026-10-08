# Core maturity follow-up review

Current update: cumulative Run limits and the unused RunUsage counters have been removed;
the earlier budget descriptions below are historical. Per-operation limits and loop detection
remain active. See `tool-call-runtime.md` for the current contract.

## Scope and implementation

This is an incremental follow-up to v6, not a replacement plan. Changes remain uncommitted on
`codex/omni-agent-core-maturity`, based on `5bfe4d69b8bbd946b744c548fb916d959b488d10`.
The original Godot checkout was not modified by this work.

| Area           | Result                                                                                                                                                             | Owner                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| MCP activation | `/mcp` list, on/off actions, retry, persisted workspace/Agent intent, catalog readiness                                                                            | App lifecycle; CLI command presentation                |
| MCP safety     | Coordinator authorization, post-cancellation registration rejection, aggregate catalog budget, distinct server ownership, explicit stdio environment authorization | App MCP                                                |
| Run time       | Removed total wall-clock enforcement; retained elapsed-time statistics and existing resource budgets                                                               | Core RunBudget                                         |
| Command Hooks  | Reuse Tool timeout and Coordinator; no separate Hook timer                                                                                                         | Core Hooks/Tool execution                              |
| Instructions   | Post-consent revalidation, transactional snapshot replacement, appended deferred results, checkpoint-triggered target reactivation                                 | Core generic preparation lifecycle; Coding scope owner |

No subagents, background orchestration, durable recovery, memory, compatibility shim, or Host
fallback was added. MCP activation changes only when the Agent is idle. Stdio retains its SDK
process until deactivation/disposal; HTTP transports remain scoped to the current authorized call.
`ready` refers to a valid catalog, not a remote-liveness guarantee.

## Verification on 2026-09-06

| Check                | Evidence                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting           | `pnpm run format:check` passed                                                                                                                    |
| Type checking        | `pnpm run typecheck` passed                                                                                                                       |
| Full test suite      | Final run: 129 files, 820 tests passed                                                                                                            |
| Build                | `pnpm run build` passed                                                                                                                           |
| Rust/macOS           | Four tests passed, including exact loopback proxy port isolation                                                                                  |
| Host                 | `verify:host` reported Protocol v2 verified                                                                                                       |
| Godot                | `verify:game` reported Protocol v2 verified                                                                                                       |
| Diff                 | `git diff --check` passed                                                                                                                         |
| CLI loading          | `node --import tsx apps/omni/src/index.ts --help` passed                                                                                          |
| Interactive smoke    | `pnpm dev` completed preparation/build but no usable TUI was observed in this PTY; interrupted. `/mcp` visual interaction is not claimed verified |
| Public network/OAuth | Not exercised; no real server login or public smoke claimed                                                                                       |

Focused behavior coverage includes persisted activation/disable/retry, denied HTTP consent,
late catalog settlement, server-origin collisions, SDK environment rejection, authorized-client
requirements, post-consent execution prevention, stable system-prompt prefixes, checkpoint
reactivation, and elapsed time without a Run deadline.

## Remaining decisions and risks

1. **OAuth is connected; live UX remains unverified.** CLI activation now reuses masked authentication
   input for manually pasted callbacks, with host and operation cancellation. Real SDK/synthetic
   Gateway tests cover PKCE exchange, state mismatch, cancellation, and secret redaction. A real
   provider login and interactive `/mcp` acceptance still need exercising; no browser launcher or
   automatic loopback callback listener is claimed.
2. **The reproduced file-lock race is repaired.** Core atomically publishes a fully initialized
   candidate directory and removes the owned reclamation marker exactly once. A reclaimer can no
   longer delete a successor's marker; final `rmdir` cannot delete a newly published non-empty lock.
   The original 100-iteration contention scenario is now a regression test, alongside empty-retired
   directory acquisition and protection of live/replacement owners. Unknown/corrupt non-empty locks
   and a process killed while holding the reclaim marker remain fail-closed; automatic crash repair
   is not claimed. A crash before publication may leave an unreferenced pending directory. Mixed
   old/new lock writers and non-POSIX filesystem semantics are not verified deployment contracts.
3. **SDK stdio constraint is explicit.** The official SDK unconditionally merges default environment
   variables. Omni rejects spawning unless those names are explicitly allowlisted, then overrides
   their values from the immutable host snapshot. No configuration is silently expanded.
4. **Cache and TOCTOU limits remain.** Stable prompt prefixes improve cache reuse but cannot guarantee
   provider cache hits. A final external filesystem race after revalidation remains. Compaction
   triggers target reactivation before subsequent affected execution, not a claim that a summary
   preserves every instruction exactly.

The reported repair scope is implemented, but complete v6/product acceptance should not be inferred
from synthetic tests alone. Real TUI switching and provider login remain acceptance evidence gaps.
No commit, merge, rebase, or push was performed.

## Quality re-review and corrections

The subsequent code-review pass focused on reuse, lifecycle correctness, and P0–P2 defects in the
incremental MCP/Hook/instruction/context changes. It was not an exhaustive security audit of every
historical file. No P0 was confirmed within this scope.

| Priority | Finding                                                                        | Resolution                                                                           |
| -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| P1       | Hook inherited `onPermissionResolved`, allowing recursive Hook dispatch        | Remove the inherited callback at the Hook execution owner                            |
| P1       | Hook discovery could mark unseen rules active for the Agent                    | Explicit preparation origin; Hook cannot commit a changed instruction snapshot       |
| P1       | text/image annotations were lost before provider projection                    | Preserve annotations and enforce audience in primary-model and checkpoint projection |
| P1       | structuredContent was absent from actual provider/checkpoint input             | Project JSON visibly while retaining the original structured payload                 |
| P2       | Policy exceptions could leave Assistant calls without corresponding results    | Shared fail-closed policy evaluation returns structured failed ToolResults           |
| P2       | Deleted instruction sources were not explicitly revoked in the model's history | Deliver complete replacement snapshots, including an explicit empty snapshot         |
| P2       | An observational diagnostic sink could throw into the completed operation      | Reuse existing runtime-observation diagnostic containment and sanitizer              |

Reuse cleanup removed the duplicated Core deep-freeze implementation, four independently maintained
policy-evaluation loops, redundant MCP registration collision scanning, and the unused unbounded
MCP diagnostic array. Registration validation remains in ToolRegistry; persisted switches reuse
AtomicJsonFile/InterprocessFileLock and the existing MCP ID/limit definitions. No replacement
process runner, timeout supervisor, schema validator, or protocol implementation was introduced.

Findings at that review: the confirmed existing lock-reclamation race was P1; incomplete OAuth host
interaction and per-operation (rather than server-session) MCP transport lifecycle are P2 gaps
against full v6 maturity. Persistent transport support must preserve per-call network grants and
cancellation; it should not be patched by keeping a previous call's authorized client alive.
Real `/mcp` TUI switching remains an unverified acceptance item, not a proven UI defect.

Engineering judgment at that review: **8.0/10**, with **Changes required** for full v6 acceptance. Cohesion and
reuse improved, but known P1/P2 issues and incomplete live integration evidence prevent a higher
readiness score. Passing unit tests alone is not grounds for declaring the plan fully complete.

After these corrections, the full suite passed again: **129 files / 824 tests**, along with
type checking, formatting, build, Host v2 and Godot v2 verification. `git diff --check` passed and
HEAD remained `5bfe4d69b8bbd946b744c548fb916d959b488d10`; no commit was created. No additional
interactive TUI or public OAuth smoke was performed in this re-review.

## Repair follow-up: current result

The user subsequently authorized repairing the remaining findings. The implementation reuses the
Core lock and sanitizer, official MCP SDK, existing authentication prompts, Coordinator deadlines,
and App resource-disposal aggregation. No dependency, alternate execution path, or task-wide timer
was introduced. The code-review pass additionally caught disable-state inconsistency on transport
cleanup failure; disabled intent and catalog removal now stay committed, and App composition is
refreshed even while the cleanup error is propagated.

| Finding                               | Current resolution                                                                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 concurrent stale-lock reclamation  | Atomic initialized-directory publication; single marker removal; 100-round regression and independent 4-process/160-operation experiment passed                                   |
| P2 OAuth activation entry             | CLI host callback wired through masked authentication input; real SDK exercises authorization, PKCE exchange, rejection, cancellation, redaction and temporary credential cleanup |
| P2 stateful stdio reset per operation | SDK process retained across discovery, concurrent calls and cancellation; deactivation/disposal awaits close; disconnect requires explicit reactivation                           |
| HTTP lifecycle trade-off              | Still operation-scoped to preserve independent network grants; repeated discovery overhead remains, rather than keeping expired authorization alive                               |

Final verification: **131 test files / 830 tests passed**, typecheck, format check, full build,
four Rust tests, Host v2 and Godot v2 harnesses, and `pnpm dev --help` startup smoke passed.
The synthetic peers were corrected against the installed SDK's actual 2026-07-28 wire schemas;
production protocol validation was not relaxed to accommodate test data. `git diff --check` passed.

Engineering assessment: **8.8/10 — Ready with trade-offs for this repair scope**. The reproduced
defects are resolved and ownership/reuse remain clear. This is not full v6 acceptance: live TUI and
real-provider OAuth remain unverified, HTTP has the documented lifecycle trade-off, and the lock
does not claim automatic recovery after its reclaimer is killed while holding the marker. Such
unknown non-empty lock states remain fail-closed. No new P0 defect was confirmed in this focused
review; no claim is made that the entire repository is free of P0–P2 defects.

HEAD remains `5bfe4d69b8bbd946b744c548fb916d959b488d10`. All work is uncommitted in the dedicated
worktree; the original Godot checkout was only inspected, not edited.
