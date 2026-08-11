# Tool Call Runtime and Permissions

This document is the authoritative architecture contract for tool registration,
input validation, authorization, permission assessment, execution, lifecycle events,
cancellation, and the future sandbox boundary.

## Design Goals

- One tool-call entry from `AgentLoop`.
- Authorization, execution, and UI remain independent responsibilities.
- Tool-domain knowledge stays with the owning tool package.
- Trusted internal capabilities do not produce unnecessary permission prompts.
- Permission decisions do not claim to provide an operating-system security boundary.
- Extensions cannot omit authorization, execution, or timeout metadata and fall into a legacy path.

## Runtime Components

```text
AgentLoop
  -> ToolCallCoordinator          resolve, validate, events, lifecycle, metrics
       -> ToolAuthorizationRouter choose trusted or permission-controlled route
            -> PermissionGate     assessment, policy, grants, approval
       -> ToolInvocationRunner    middleware, timeout, host/sandbox execution
```

Ownership by package:

```text
packages/core
  tool-calls/   coordinator, authorization router, schema validators, metrics
  permissions/  contracts, gate, ports, sanitizer
  execution/    authorized-call capability, runner, abort helpers, sandbox port
  persistence/  shared inter-process file lock

packages/tools
  security/path/         shared path facts
  filesystem/permission filesystem risk mapping
  search/permission     search-root risk mapping
  web/permission        external read and protocol validation
  shell/permission      parser, classifier chain, path analysis, Bash assessment

packages/app
  registry/             registration and stable tool identity
  permissions/          policy, grants, repository, migration, runtime composition

packages/cli
  permissions/          ApprovalBroker implementation
  interaction/tui/      modal selection and rendering
  commands/permissions  permission-management UI
```

Core never imports concrete tools, App, or CLI. App does not parse Bash commands or
tool-specific paths. CLI does not evaluate risk or access the grant repository directly.

## Tool Definition Contract

Every tool contribution uses the final definition API:

```ts
interface AgentToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  strict?: boolean;
  timeout: ToolTimeoutPolicy;
  authorization: ToolAuthorizationDescriptor;
  execution: ToolExecutionStrategy;
  execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>;
}

type ToolTimeoutPolicy =
  | { kind: "none" }
  | { kind: "fixed"; timeoutMs: number }
  | {
      kind: "input";
      parameter: string;
      defaultMs: number;
      minMs: number;
      maxMs: number;
    };
```

Authorization and execution are orthogonal strategies:

```ts
type ToolAuthorizationDescriptor =
  | { kind: "trusted"; reason: string; hiddenInputKeys?: readonly string[] }
  | {
      kind: "static";
      risk: "read" | "execute";
      reason: string;
      hiddenInputKeys?: readonly string[];
    }
  | {
      kind: "dynamic";
      assess(input, context): PermissionAssessment | Promise<PermissionAssessment>;
      hiddenInputKeys?: readonly string[];
    };

type ToolExecutionStrategy = { kind: "host" } | { kind: "sandbox_eligible"; profile: string };
```

`trusted` means that the capability is internal, deterministic or otherwise already
inside the host trust boundary. It bypasses `PermissionGate`, but it does not bypass
tool resolution, schema validation, lifecycle handling, middleware, cancellation, or
structured result handling.

`host` and `sandbox_eligible` say where an authorized call may execute. They do not
grant permission. A permission-controlled host tool still requires authorization; a
trusted host tool does not. There is currently no sandbox implementation. When no
`SandboxRunnerPort` is injected, a sandbox-eligible tool executes through its host
implementation after authorization.

Tools cannot provide `originId` or `toolIdentity`. `ToolRegistry` creates a
`RegisteredAgentTool` and assigns identity as `<originId>:<toolName>`:

- Coding built-ins: `builtin-coding:<toolName>`.
- Other Agent built-ins: `builtin-<agentId>:<toolName>`.
- Extensions: `<manifestId>:<toolName>`.

Missing or malformed authorization, execution, timeout, schema, or execute definitions
fail extension registration. For `input` timeout policies, the named schema property
must be an integer whose minimum and maximum exactly match the policy. Core never
injects that property into an extension schema. There is no `risk`, `approval`,
unscoped identity, missing descriptor, or timeout fallback.

## Call Sequence

The successful path is fixed:

```text
resolve registered tool
-> validate input with Ajv
-> emit sanitized tool_start
-> authorize through ToolAuthorizationRouter
-> emit lifecycle start events
-> run beforeExecute middleware
-> start execution timeout
-> execute through host or SandboxRunnerPort
-> verify abort state
-> run afterExecute middleware
-> emit lifecycle end events
-> emit tool_end with structured result and metrics
-> append tool result to the conversation
```

Schema errors and permission denials emit paired `tool_start` and `tool_end` events,
but do not invoke lifecycle adapters, execution middleware, or tool code. An abort is
different: it throws `AbortError`, does not create an ordinary denial/tool result, and
prevents the next model turn.

`ToolCallCoordinator` is the only component called by `AgentLoop`. Do not add a
default executor, direct tool invocation from the loop, or another host-specific
execution branch. Its authorizer, invocation runner, and input validator are required
constructor dependencies and must be supplied by the composition root.

## Schema Validation

`ToolInputValidator` is the only host-side tool JSON Schema validator. `AgentFactory`
creates one instance and shares it between `ToolRegistry` definition admission and
`ToolCallCoordinator` runtime validation, so the Ajv validator is compiled once per
schema object.

- Every tool call is validated, regardless of `strict`.
- `strict` only controls model-provider strict schema output.
- Ajv does not mutate tool input.
- Invalid schemas reject the complete extension registration transaction.
- Permission-sensitive built-ins should use bounded strings and
  `additionalProperties: false`.
- Extension schemas are validated but not silently rewritten by Core.

## Authorization Routing

`ToolAuthorizationRouter` dispatches from the descriptor kind rather than tool name:

```text
authorization.kind == trusted
  -> create AuthorizedToolCall directly

authorization.kind == static or dynamic
  -> PermissionGate
```

`AuthorizedToolCall` is a Core-branded immutable snapshot. The invocation runner only
accepts this type; ordinary model input cannot be passed to it. Dynamic assessors
receive an isolated clone so they cannot mutate the execution snapshot.

Current first-party routing:

| Tools                                         | Authorization                    | Execution                         |
| --------------------------------------------- | -------------------------------- | --------------------------------- |
| `skill_read`                                  | trusted                          | host                              |
| deterministic financial indicator computation | trusted                          | host                              |
| `file_read`, `file_write`, `file_edit`        | dynamic path assessment          | host                              |
| `glob`, `grep`                                | dynamic search-path assessment   | host                              |
| `web_search`, `web_fetch`                     | dynamic external-read assessment | host                              |
| `bash`                                        | dynamic shell assessment         | sandbox eligible, `shell` profile |

Do not make all tools trusted merely because local extensions are trusted code.
`trusted` is for capabilities whose operation itself should not ask permission. Tool
code from local extensions still runs in the host process and therefore remains part
of the local trust boundary.

## Permission Gate

The controlled route is:

```text
static/dynamic descriptor
-> assessment validation
-> recursive presentation sanitization
-> hard-deny enforcement
-> PermissionPolicy
-> persisted Agent/tool grant lookup when eligible
-> ApprovalBroker when required
-> AuthorizedToolCall or structured denial
```

Assessments explicitly separate risk from enforcement:

```ts
interface PermissionAssessment {
  risk: PermissionRisk;
  operationClass: "routine" | "sensitive";
  enforcement: "policy" | "hard_deny";
  reasons: readonly string[];
  ruleIds: readonly string[];
  presentation: PermissionPresentation;
}
```

`ruleIds` are diagnostic and test data only. Policy must never infer authorization
semantics from their presence or spelling. `risk` describes operational impact, while
`operationClass` explicitly distinguishes routine calls that may use a persistent tool grant
from sensitive calls that require a fresh decision. Security-relevant classifier output
uses explicit fields such as `enforcement`, `operationClass`, and shell `effects`.

The default policy is:

| Risk                     | standard | supervised | Persistent grant |
| ------------------------ | -------- | ---------- | ---------------- |
| `read`                   | allow    | allow      | unnecessary      |
| `write`                  | allow    | ask        | allowed          |
| `execute`                | ask      | ask        | allowed          |
| `external_read`          | allow    | ask        | forbidden        |
| `external` + routine     | ask      | ask        | allowed          |
| `external` + sensitive   | ask      | ask        | forbidden        |
| `destructive`            | ask      | ask        | forbidden        |
| `privileged`             | ask      | ask        | forbidden        |
| `unknown`                | ask      | ask        | forbidden        |
| `enforcement: hard_deny` | deny     | deny       | forbidden        |

Persistent approval is scoped to Agent ID and stable tool identity. It answers routine
`write`, `execute`, and explicitly classified routine `external` prompts. Bash examples
include package installation and non-destructive Git fetch, pull, and push. Publish,
force-push, destructive, privileged, unknown, sensitive-path, and hard-deny assessments
are evaluated again and are not covered by the grant.

`ApprovalBroker` receives only the sanitized `ApprovalRequest`. It never receives raw
tool input. Escape maps to Deny. Ctrl+C, SIGTERM, shutdown, and an aborted signal map
to `AbortError`, not Deny. A non-interactive host that does not inject a broker uses
`DenyApprovalBroker`, so requests that require interaction fail closed.

## Domain Assessment

Risk analysis belongs to the tool domain and is attached to the tool definition. Do
not add a central `switch(toolName)`.

Filesystem and search assessors share `security/path` primitives for:

- absolute normalization using the injected workspace `cwd`;
- workspace boundary checks and `..` traversal;
- real paths for existing targets;
- nearest existing parent resolution for new targets;
- symlink-aware boundary checks;
- credential directories and credential filenames;
- `.env` template exceptions;
- system paths such as `/etc`, `/proc`, `/sys`, `/dev`, and `/root`.

Assessment and execution must use the same injected `cwd`. Tool implementations must
not resolve operation paths with their own `process.cwd()`.

Web assessors classify HTTP and HTTPS reads as `external_read`. Invalid URLs and
non-HTTP(S) protocols are hard denied. Bash `curl` and `wget` remain command execution
and are classified as `external`, not `external_read`.

Bash assessment is deterministic and local:

```text
ShellParser
-> whole-command hard stops
-> wrapper expansion
-> prioritized command classifiers
-> redirection and shell-path analysis
-> highest-risk aggregation
```

Wrappers such as `env`, `command`, `exec`, `nohup`, `time`, `xargs`, and
`bash/sh/zsh -c` are recursively inspected. Incomplete parsing, dynamic executables,
and unsupported shell expressions become `unknown`. Classifier `effects` carry
security semantics such as network transfer; `ruleIds` remain observational.

## Execution Boundary

`ToolInvocationRunner` only receives `AuthorizedToolCall` and owns:

- abort checks around middleware and execution;
- `beforeExecute` and `afterExecute` middleware;
- execution-only timeout accounting;
- host versus sandbox-eligible dispatch;
- conversion of non-abort execution failures into `ToolResult` errors.

It does not know permission mode, risk, grants, Agent identity, TUI, or persistence.
Execution context contains only `cwd` and `signal`; permission context is not exposed
to tool code.

Middleware runs only after authorization. It must not be moved into `AgentLoop` or
before schema/permission checks. Lifecycle adapters also wrap only actual execution.
Each supporting adapter receives an isolated input clone; unsupported adapters do not
cause unnecessary cloning.

The tool timeout begins after `beforeExecute` middleware and immediately before tool
invocation, after any user approval wait. `executionMs` still covers both middleware
and tool execution. `ToolCallMetrics` has stable ownership:

- `authorizationMs`: authorization router/gate.
- `executionMs`: invocation runner, including execution middleware.
- `totalMs`: coordinator.
- `ToolEndEvent.durationMs`: `executionMs`, or zero when execution never started.

Timeout policies distinguish runtime supervision from domain-specific request budgets:

- `none` has no Runner deadline but still responds to user cancellation and shutdown.
- `fixed` applies a runtime-owned deadline that model input cannot change.
- `input` lets the model request a bounded budget through a validated schema property.
- Bash uses `input` with a 120-second default and a 10-minute maximum.
- File, search, trusted computation, and web tools use `none`. Web tools retain their
  own HTTP request timeout and report it as a domain error.

At a Runner deadline, the linked execution signal is aborted. The Runner allows up to
two seconds for cooperative cleanup, then returns `tool_timeout` and observes any
unsettled Promise in the background. A late success or failure cannot run
`afterExecute`, emit another result, or enter the conversation. Late rejections are
consumed and may be sent to an optional diagnostic observer. This observation creates
no additional keep-alive handle.

The internal `ExecutionDeadlineSupervisor` owns linked cancellation, deadline and
cleanup timers, and late settlement observation. `ToolInvocationRunner` owns only
middleware ordering, backend dispatch, execution metrics, and result conversion.
Cleanup timers are cancelled when a tool settles cooperatively, and asynchronous
diagnostic observer failures are isolated.

## Cancellation

Core's abort helpers define the single cancellation meaning. Abort is checked at
coordinator entry, after assessment and policy work, after approval, around middleware,
after tool completion, and before results enter the next model turn.

Blocking tools must observe `ToolExecutionContext.signal`. Bash passes the injected
`cwd` and signal to the spawned process, terminates it when aborted, and propagates
`AbortError`. Do not turn cancellation into a successful result or a permission denial.

Bash and grep share the tools-layer `HostProcessRunner`. On POSIX it starts a detached
process group, sends `SIGTERM` on cancellation, escalates to `SIGKILL` after 500 ms,
waits for close, and bounds captured stdout/stderr by bytes. Windows uses the child
process termination capabilities available through Node and does not claim POSIX
process-group behavior. This process runner has no knowledge of permissions, schemas,
the TUI, or sandbox policy. It preserves both numeric exit code and signal termination;
an unexpected signal exit is an execution error rather than a successful null code.

Web tools keep external cancellation separate from their HTTP timeout signal. User
cancellation and shutdown propagate `AbortError`; an HTTP budget expiry becomes a
normal domain timeout result; a future Runner deadline becomes `tool_timeout`.

## Filesystem I/O Contract

`file_read` uses a bounded streaming reader. It defaults to 500 lines, accepts explicit
limits from 1 through 2,000, and caps the final UTF-8 tool text at 64 KiB including line prefixes and
the continuation footer. It scans to the requested offset without retaining preceding
text and does not scan beyond the requested page to calculate a total line count.
Total lines are known only at EOF.

Every page returns an opaque snapshot version in both `ToolResult.meta.pagination` and
the LLM-visible footer. Continuations carry that version. A version is a stable SHA-256
digest of device, inode, size, mtime, and ctime metadata; it is a consistency token,
not authorization or a signature. The reader compares the open handle and current
canonical path after reading and discards a page when either changed.

Physical lines larger than the remaining output budget use `line_byte_offset`
continuations. Offsets are relative to line content bytes, exclude CRLF terminators,
and must be returned by the tool rather than calculated by the model. Chunks stop on a
valid UTF-8 boundary and are explicitly marked partial. Grep can locate a line, but
only `file_read` continuation retrieves its complete oversized content.

Glob and grep provide optional navigation facts rather than hidden prerequisites.
Glob returns stable sorted paths with file sizes for at most 200 visible results. Grep
parses `rg --json`, enforces a global matching-line limit, and groups bounded line and
column previews under each matching file and its size. File metadata is loaded only for
visible results with bounded concurrency. Required navigation data appears in both
`ToolResult.meta` and LLM-visible text because result metadata is not part of the model
message. Search tools never calculate or invoke file-read ranges; the Agent chooses a
range for the current task, and direct file reads safely use the 500-line default.

`file_edit` reads and validates at most 8 MiB, performs one exact non-overlapping
replacement in memory, and preserves BOM and existing newline bytes. `file_write`
also validates and prepares its complete bytes before submission. Both use the shared
`DirectFileWriter`, which verifies an expected snapshot, performs a final abort check,
and invokes `fs.writeFile` once. New targets use `wx`; existing targets use direct
overwrite semantics, preserving inode metadata and hard-link relationships.

Direct writing intentionally does not use a temporary file, rename, fsync, backup, or
automatic rollback. `fs.writeFile` is not an atomic commit: disk errors, process death,
or power loss may leave an existing target truncated or partially changed. A rejected
write reports `write_failed` with `targetState: "unknown"`; callers must read the file
again. Snapshot checks and the canonical-path/inode mutex reduce cooperative races but
do not eliminate external-process or symlink TOCTOU races. The permission layer is not
an OS sandbox, and network filesystems may provide weaker semantics.

The in-process file mutex always acquires a canonical path key and additionally
acquires an inode key for an existing target. The stable path key preserves exclusion
while a missing target becomes a file; the inode key serializes hard-link aliases.
Cancellation only releases keys actually acquired by that operation.

## Events and Safe Presentation

The coordinator owns `tool_start`/`tool_end` ordering. Permission observers own
requested/resolved diagnostics. Lifecycle adapters own domain event conversion. CLI
only renders events and approval requests.

Permission observer events contain Agent ID, tool identity/name, risk, rule IDs,
decision/source, and timestamp only. Observer failures are isolated and cannot change
an authorization result. The first implementation is diagnostic only and does not
persist an audit log.

Raw input must not cross presentation or observation boundaries. Core's recursive
sanitizer is the single implementation used for tool previews and permission
presentations. It handles nested objects and arrays, ANSI/control characters,
credential-like keys and values, URL query parameters, depth/field/length limits, and
descriptor-specific hidden fields such as `file_write.content`.

Do not add a second CLI redaction regex or serialize raw tool input in observers,
permission storage, or permission errors.

## Permission Persistence

Permission state lives at `~/.omni-agent/permissions.json` in version 2 format:

```json
{
  "version": 2,
  "agents": {
    "coding": {
      "mode": "standard",
      "alwaysApproveTools": [
        {
          "toolIdentity": "builtin-coding:bash",
          "toolName": "bash"
        }
      ]
    }
  }
}
```

The repository uses the App package's atomic JSON writer and Core's shared
`InterprocessFileLock`. The lock records PID, UUID owner, and creation time. Stale
reclamation requires a dead owner and an exclusive reclaim claim, preventing multiple
reclaimers from deleting a newly acquired lock. Release verifies owner identity.

Writes are serialized in-process, re-read and merged under the inter-process lock,
written atomically, and kept at mode `0600`. Invalid configuration fails closed to
`supervised` with no grants. Version 1 migration is isolated and one-way: recognized
`coding:<tool>` identities become `builtin-coding:<tool>` and unrecognized identities
are dropped with diagnostics. Runtime policy and repository logic only understand
version 2.

## TUI and Application Facade

CLI implements `ApprovalBroker` through one modal at a time. The modal owns focus,
keyboard listeners, overlay cleanup, status restoration, and Promise completion in a
`finally` path. Permission choices are:

- Allow once.
- Always approve routine operations for this tool, only when policy marks the request
  persistable.
- Deny.

`/permissions` accesses permission state through `AgentApplication` methods. The
command may change mode, list/revoke one grant, or clear Agent grants, and changes take
effect in the current runtime. CLI must not import the permission repository or
re-evaluate policy.

## Sandbox Boundary

Permissions answer whether a call may proceed. A future sandbox answers how an
eligible process is constrained by the operating system.

`SandboxRunnerPort` is intentionally in the execution layer. It receives an already
authorized tool, immutable input, execution context, and profile. It must not own
permission modes, grants, approval UI, or persistent policy. Host tools are never sent
to it. This release provides the port but no OS sandbox, so child processes, trusted
extension code, and symlink time-of-check/time-of-use races remain residual risks.

## Change Checklist

When adding or changing a tool:

1. Choose an explicit authorization descriptor and execution strategy.
2. Keep domain assessment beside the tool and reuse shared security facts.
3. Use injected `cwd` and `AbortSignal` in assessment and execution.
4. Bound the schema and declare hidden presentation fields.
5. Add focused tests for schema failure, routing, risk boundaries, abort, and secrets.
6. Verify denials do not run lifecycle adapters, middleware, or tool code.
7. Do not introduce another executor, permission switch, sanitizer, or lock.

Before merging runtime changes, run formatting, type checking, tests, build, and a TUI
smoke test when approval or command interaction changed.
