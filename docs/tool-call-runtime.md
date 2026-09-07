# Tool Call Runtime, Access, and Sandbox

Runtime reporting uses the existing TokenUsage, Tool metrics, and Observation paths rather than
a separate cumulative Run counter. There is no Run budget configuration or cumulative-budget
termination path. Tool deadlines, cancellation, per-operation
size limits, prompt/catalog budgets, Hook recursion protection, and behavioral loop detection remain
independent protections. Repeated-action detection is not a guarantee of eventual termination for
all non-progressing workloads; users can cancel a Run.

This document is the authoritative contract for Tool validation, access control, execution,
cancellation, and the macOS process sandbox.

## Runtime Flow

```text
LLM Tool Call
-> ToolCallCoordinator
   -> prepareBatch
      -> resolve registered Tool
      -> validate JSON Schema
      -> bind input and domain preflight
      -> assess access facts once
   -> batch preparation policies (for example InstructionScopeGate)
   -> authorizeAndRun
   -> ToolAccessController
      -> load workspace execution settings
      -> assess ToolAccessIntent
      -> obtain controlled network or filesystem consent when required
      -> create access grant and base process policy
   -> NetworkRuntime (network grant only)
      -> bound in-process client and per-call authenticated proxy
   -> ProcessExecutionPlanner (Process Tools only)
      -> create ProcessInvocation
      -> resolve executable provenance and runtime closure
      -> create final ProcessExecutionPlan
   -> create AuthorizedToolCall
   -> lifecycle start
   -> ToolInvocationRunner
      -> middleware beforeExecute
      -> deadline and linked cancellation
      -> in-process execute or ProcessExecutionRouter
      -> middleware afterExecute
   -> lifecycle end
-> structured ToolResult
```

Schema, preflight, and preparation-policy failures never enter authorization, lifecycle, middleware,
or execution. A deferred batch does not count as executed Tool work.
Access denials never enter lifecycle, middleware, or execution. Deadline timing begins only after
access control completes.

## Responsibility Boundaries

| Owner                     | Responsibility                                                            |
| ------------------------- | ------------------------------------------------------------------------- |
| `ToolCallCoordinator`     | Two-stage preparation/authorization, ordering, events, lifecycle, metrics |
| `ToolAccessController`    | Mode evaluation, capability matching, consent, and access grant           |
| `ProcessExecutionPlanner` | Invocation creation, executable trust, runtime closure, and final plan    |
| Tool domain               | Path, shell, web, and other resource facts                                |
| `ToolInvocationRunner`    | Authorized execution, middleware, timeout, abort, and late settlement     |
| `ProcessExecutionRouter`  | Execute an already-final host or sandbox plan without adding capabilities |
| Rust `omni-sandbox`       | Validate protocol, compile Seatbelt policy, apply limits, and exec target |
| Network Gateway           | Exact targets, DNS/IP/redirect policy, body limits, and loopback proxy    |
| App settings              | Persist mode, network, and approved roots by workspace and Agent          |
| UI                        | Render mode management and access consent only                            |

Core never parses shell commands or paths. Tools never read settings or render UI. App never
interprets Tool inputs. The Rust binary knows nothing about Agents, prompts, Tool schemas, or UI.

## Tool Contract

Every Tool declares access, execution, and timeout explicitly. There is no metadata fallback.

```ts
type ToolAccessDescriptor =
  | { kind: "internal" }
  | { kind: "dynamic"; assess(input, context): ToolAccessIntent | Promise<ToolAccessIntent> };

type AgentToolDefinition = InProcessToolDefinition | ProcessToolDefinition;
```

In-process Tools implement `execute`. Process Tools implement `createProcessInvocation` and
`createToolResult`. Bash and grep are Process Tools. Filesystem, web, Skill, user interaction, and
pure computation Tools are in-process. In-process Tools are trusted local code and are not inside
Seatbelt; their declared resources are enforced by `ToolAccessController` before invocation.
`createProcessInvocation` runs during planning, before lifecycle and middleware. It must be a pure,
bounded mapping from validated input and execution context to process arguments; it must not start a
process, access the network, mutate the filesystem, or read mutable permission state.

Optional preflight validates domain readiness, such as file type or target existence. Execution
must revalidate mutable state because preflight and execution occur at different times.
`ToolAccessIntent.denial` reports an invalid or unsupported access request, while `hardStop`
is reserved for security facts that must override mode-specific access evaluation.

## Execution Modes

### Controlled

Processes run under Seatbelt with workspace and private-call-temp writes. An ordinary external
path may propose a canonical read or read/write capability for user approval. Approved subtree
capabilities cover descendants, are shared by file, search, and Bash Tools, and are persisted only
for the current workspace and Agent. Ordinary subtree capabilities never cover sensitive files;
sensitive reads require exact-file approval and sensitive writes remain denied. A network call asks
for its missing exact targets; at most 64 targets may be persisted per workspace and Agent. Web
Tools receive a bound client, while Process Tools can reach only their per-call proxy port.

### Autonomous

Processes still run under Seatbelt. Bash may declare per-call `sandbox_scope` resources:
`read_paths`, `write_paths`, and exact `network_targets`. Ordinary external resources are allowed only for that
call. Sensitive reads must be exact; protected paths and sensitive writes remain denied. No access
scope is persisted.

### Unrestricted

After explicit mode confirmation, Process Tools run directly through `HostProcessRunner`.
Access boundaries and shell hard-stops are skipped, but Schema validation, preflight, timeout,
abort, output limits, process-group cleanup, file type validation, and file consistency checks
remain active.

Controlled and autonomous never fall back to host execution. Sandbox protocol v4 represents only
`disabled` or an exact loopback proxy port. Missing binaries, protocol mismatch,
policy errors, and launch failures return structured sandbox errors.

## Process Sandbox

The formal Rust package lives under `sandbox/`. On macOS, the launcher:

```text
resolve direct and Shell-internal executables in Node
-> project bounded read-only runtime dependencies
-> validate protocol and absolute paths in Rust
-> apply RLIMIT_NOFILE and RLIMIT_FSIZE
-> compile a Seatbelt profile
-> install the Seatbelt profile in the Rust process
-> exec the target process directly
```

`pnpm dev` and `pnpm run build` compile the current-host release binary before the TypeScript
runtime starts or builds. `pnpm run build:cli` owns the separate arm64/x64 cross-build and copies
both binaries into the standalone distribution.

The wrapper preserves stdio and the process group. `HostProcessRunner` remains the single owner of
output collection, AbortSignal handling, SIGTERM/SIGKILL escalation, and close/error settlement.

Seatbelt permits required system/runtime reads, workspace/private-temp writes, projected approved
roots or per-call scopes, and at most one authenticated loopback proxy port. The Runtime projects only roots needed by the
current call, not the full approval history. Protocol v4 protects the workspace and projected
read/write subtree roots from deletion or rename while allowing real changes below those roots.
The runner verifies the binary's advertised protocol before each launch and fails closed on a
mismatch. Each launch also carries a random diagnostic token so target stderr cannot be mistaken
for a Rust startup failure.
Sensitive directory and filename denials are generated from the shared tools-layer policy
snapshot. Exact sensitive-read exceptions are represented in the same deny expression so they do
not rely on rule ordering.

The host PATH, platform, and HOME are captured once by the composition root. Shell analysis,
controlled/autonomous executable lookup, and the environment passed to Bash consume that immutable
snapshot. Shell executable requirements retain both their static token and effective cwd, so the
same relative token used after different `cd` operations is not collapsed. Relative PATH entries
must resolve to a canonical target already covered by the call's access policy; an in-workspace
symlink cannot turn them into an external trust source. The direct Process invocation is resolved
to a canonical executable; Bash source remains unchanged. The resolver follows bounded package or
installation roots, shebang interpreters, bounded shell shims, and macOS Mach-O dependencies. It
does not recognize installer or CLI names, open HOME, persist runtime scopes, retry after a deny,
or fall back to host execution. Lookup always honors the first executable in immutable PATH order;
it never substitutes a later same-name executable after a trust failure. Runtime-only plugins and other undiscoverable dependencies can
still fail inside the sandbox.

The first release supports macOS arm64 and x64 source builds. Platform-native dependency discovery
and Rust policy/exec are explicit adapter boundaries: future Linux support requires an ELF resolver
plus a complete Linux enforcement backend, and Windows requires PE/DLL lookup plus a complete
Windows backend. Partial backends return `sandbox_unsupported_platform`. The first release does not
claim overlay filesystems, fake deletion, rollback, cgroup isolation, strict memory isolation, or
process-count isolation.

## Filesystem Tools

Filesystem Tools share canonical path resolution, preflight, path/inode mutexes, snapshots, text
validation, streaming reads, and direct writes. `file_read` defaults to 500 lines, accepts 1-2000,
caps final text at 64 KiB, and returns versioned line or long-line continuation metadata in both
Tool metadata and model-visible text.

`file_edit` and `file_write` build complete content in memory before one `fs.writeFile` call. This
is deliberately not an atomic commit. An I/O failure can leave the target state unknown. There is
no temporary-file recovery, rollback, or automatic backup.

## Settings and Migration

`~/.omni-agent/execution-settings.json` uses version 6 and keys state by stable workspace ID and
Agent ID. Each entry stores mode, at most 64 exact approved network targets, and at most 64 approved
filesystem roots. New workspaces default to controlled mode with no network targets or extra roots.
Updates use the shared inter-process lock, atomic JSON replacement, and file mode `0600`.

The v5-to-v6 migration preserves mode and roots, deletes the coarse network boolean, initializes
targets empty regardless of its old value, and diagnoses discarded coarse grants. Earlier one-way
migrations remain isolated readers. Successful v6 persistence stops reading v5. Corruption or
migration failure fails closed.

## Cancellation and Timeouts

`OperationDeadlineSupervisor` owns linked cancellation, deadlines, bounded cooperative cleanup,
and late-settlement observation. Tool execution maps its deadline to `tool_timeout`; the separate,
fixed runtime-projection budget maps dependency inspection stalls to
`sandbox_runtime_projection_timeout` before lifecycle or middleware starts. User cancellation
propagates `AbortError` and does not create a normal Tool result. Late completion cannot run
after-middleware or enter the session, and late rejection is consumed.

## Residual Boundaries

- Local extensions are trusted in-process code and are not sandboxed.
- Autonomous scopes are requested by the Agent and remain bounded by Runtime validation.
- A proxy-unaware Process cannot use its network grant.
- Final instruction-manifest validation and OS execution retain a small external TOCTOU window.
- Allowed deletion is real and has no automatic recovery.
- Symlink TOCTOU and PATH executable replacement are not completely eliminated.
- Dynamic executable plugins and dependencies that cannot be discovered before launch are not
  automatically granted or retried.
- Direct file writes retain their documented truncation risk.
