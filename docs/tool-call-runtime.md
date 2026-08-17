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
  -> LoopProtection              run-scoped repeat/cycle policy and prompt guidance
  -> ToolCallCoordinator          resolve, validate, events, lifecycle, metrics
       -> ToolAuthorizationRouter choose trusted or permission-controlled route
            -> PermissionGate     assessment, policy, grants, approval
       -> ToolInvocationRunner    middleware, timeout, host/sandbox execution
```

Ownership by package:

```text
packages/core
  loop-protection/ repeat signatures, rule objects, batch-cycle decisions, prompt policy
  system-prompt/   stable runtime sections and one-shot prompt overlays
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
  preflight?: ToolPreflightDescriptor;
  timeout: ToolTimeoutPolicy;
  authorization: ToolAuthorizationDescriptor;
  execution: ToolExecutionStrategy;
  scheduling?: { batch: "normal" | "turn_barrier" };
  context?: { retention: "default" | "conversation" };
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

`preflight` is an optional domain validation step for facts that should be checked before
an approval prompt, such as whether a file exists and is a regular file. It returns either
`ready` or a structured domain error. It does not assess risk, query grants, render UI, or
replace the execution-time consistency check.

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

Scheduling and Context metadata are generic policies, never tool-name switches.
`turn_barrier` means the result may invalidate sibling calls and requires an immediate
model replan. `conversation` means the result carries durable conversational decisions:
Artifact projection must not externalize it, and Heavy compression must retain its key
choices, scope effects, skipped assumptions, and unresolved questions. `skill_read` and
`request_user_input` are the initial conversation-retention consumers.

## Call Sequence

The successful path is fixed:

```text
resolve registered tool
-> validate input with Ajv
-> emit sanitized tool_start
-> run optional domain preflight
-> authorize through ToolAuthorizationRouter
-> emit lifecycle start events
-> run beforeExecute middleware
-> start execution timeout
-> execute through host or SandboxRunnerPort
-> verify abort state
-> run afterExecute middleware
-> emit lifecycle end events
-> emit tool_end with structured result and metrics
-> let LoopProtection observe the raw result
-> complete the model-produced tool batch
-> append every tool result to the conversation
-> continue with runtime guidance or halt the run
```

Schema errors, preflight errors, and permission denials emit paired `tool_start` and `tool_end` events,
but do not invoke lifecycle adapters, execution middleware, or tool code. An abort is
different: it throws `AbortError`, does not create an ordinary denial/tool result, and
prevents the next model turn.

`ToolCallCoordinator` is the only component called by `AgentLoop`. Do not add a
default executor, direct tool invocation from the loop, or another host-specific
execution branch. Its authorizer, invocation runner, and input validator are required
constructor dependencies and must be supplied by the composition root.

### Turn barrier batches

Before any batch member reaches `ToolCallCoordinator`, the Agent loop scans registered
tool scheduling metadata. If no barrier exists, the normal sequence applies. If one or
more barriers exist, only the first barrier in model order reaches the Coordinator.
Every sibling receives a paired `tool_batch_deferred` result in original call order:

```text
scan complete batch
-> choose first turn_barrier
-> execute and await only that call
-> do not authorize, preflight, run middleware, lifecycle adapters, or tool code for siblings
-> append one retryable deferred result for every sibling
-> return to the model to replan
```

Deferred results are errors only in the tool-protocol sense; they report that no action
occurred and may be reissued if still relevant. This is stricter than an execution mutex:
it prevents permission prompts and side effects based on assumptions that the barrier
result may change. Core selects the policy from registered metadata and never checks a
concrete tool name.

### User clarification tool

`request_user_input` is a trusted host tool with no timeout, `turn_barrier` scheduling,
and `conversation` retention. Its JSON Schema accepts one to three single-select,
multi-select, or text questions. Domain preflight rejects duplicate or blank IDs,
invalid option combinations, and invalid Other usage before UI presentation. The tool
maps the response back to a normal `ToolResult`; Submit enforces required answers, while
Skip and Escape succeed with guidance to use the lowest-impact explicit assumptions.

Direct clarification answers are authoritative refinements of the current task. They
cannot broaden the original scope, grant permissions, or bypass `PermissionGate`.
Answers are persisted only through the standard assistant tool-call/tool-result pair.

## Tool Loop Protection And Runtime Guidance

`LoopProtection` is a run-scoped Core interceptor. It observes results only after they
have crossed resolution, validation, authorization, execution, and lifecycle handling.
It never invokes a tool, changes authorization, modifies a `ToolResult`, or creates an
alternate coordinator path.

The result signature is SHA-256 over stable JSON containing the registered
`toolIdentity`, recursively key-sorted arguments, and the complete LLM-facing result
content plus `isError`. Array order is preserved, result metadata is excluded, and raw
arguments/results are never exposed by diagnostics. Batch fingerprints hash sorted
result signatures, so tool completion order does not affect cycle detection.
Serialization failures skip loop observation instead of failing the Agent run.

The default rules are:

- an identical result signature in the last ten tool calls warns on occurrences two and
  three and halts on occurrence four;
- the same tool returning the same error three times consecutively produces strong
  guidance and resets that error streak, but does not itself halt;
- repeated multi-tool batches and alternating two-batch cycles warn after two and three
  complete cycles and halt after four; single-tool period-one repetition remains owned
  by the result-signature rule.

Once an alternating cycle is confirmed, its first and second phases are anchored in
run-scoped state. Generic repeated-result decisions from those member batches are deferred
until the cycle completes or breaks, so the fourth complete cycle owns the halt and its
diagnostic. A mismatching batch clears the active cycle and restores normal repeated-result
enforcement.

A halt is deferred until every tool call from the current assistant response has a
result. The Agent loop then emits `tool_loop_detected` with the complete `produced`
messages and skips the next model request. This preserves valid tool-call/result history
and lets the application persist completed work.

Warnings are not appended to tool output or durable messages. Tool-enabled Agents receive
a stable runtime loop-policy section, and warnings create a one-shot runtime prompt
overlay for the next model request. The effective prompt is composed without mutating the
Agent-owned base prompt and includes the overlay in request token estimation. Once the
model stream begins successfully, the overlay lease is consumed. Merely constructing an
async stream does not consume it, so a pre-dispatch cancellation or initialization failure
leaves the guidance pending.

`maxTurns` is an independent, optional safeguard. An omitted value means unlimited model
turns; an explicitly configured limit still emits `max_turns_reached` with `produced` and
usage. Targeted loop protection remains active in either case.

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
-> persisted Agent/tool/scope grant lookup when eligible
-> ApprovalBroker when required
-> AuthorizedToolCall or structured denial
```

Assessments explicitly separate risk from enforcement:

```ts
interface PermissionAssessment {
  risk: PermissionRisk;
  operationClass: "routine" | "sensitive";
  persistentApprovalRequirements?: readonly PersistentApprovalRequirement[];
  enforcement: "policy" | "hard_deny";
  reasons: readonly string[];
  ruleIds: readonly string[];
  presentation: PermissionPresentation;
}

interface PersistentApprovalRequirement {
  approval: PersistentApprovalScope;
  satisfiedBy: readonly string[];
}
```

`ruleIds` are diagnostic and test data only. Policy must never infer authorization
semantics from their presence or spelling. `risk` describes operational impact, while
`operationClass` describes the operation independently from its approval scope. Tool-level
routine grants consume it, while Bash executable grants deliberately do not distinguish
subcommands. Security-relevant classifier output uses explicit fields such as
`enforcement`, `operationClass`, and shell `effects`.

The default policy is:

| Risk                                           | standard | supervised | Persistent grant |
| ---------------------------------------------- | -------- | ---------- | ---------------- |
| `read`                                         | allow    | allow      | unnecessary      |
| `write`                                        | allow    | ask        | allowed          |
| `execute`                                      | ask      | ask        | allowed          |
| `external_read` + routine                      | allow    | ask        | allowed          |
| `external` + routine                           | ask      | ask        | allowed          |
| `external` + explicit scope                    | ask      | ask        | allowed          |
| sensitive `external` without an explicit scope | ask      | ask        | forbidden        |
| `destructive`                                  | ask      | ask        | forbidden        |
| `privileged`                                   | ask      | ask        | forbidden        |
| `unknown` + executable scope                   | ask      | ask        | allowed          |
| other `unknown`                                | ask      | ask        | forbidden        |
| `enforcement: hard_deny`                       | deny     | deny       | forbidden        |

Persistent approval is scoped to Agent ID and an opaque scope. Most scopes retain the stable tool
identity boundary; filesystem capability scopes are shared by compatible tools. `approval` is the
only scope persisted after an Always choice; `satisfiedBy` lists typed scope references that may
satisfy that one requirement and is never stored. One matching reference satisfies a requirement,
while multiple independent requirements use all-of matching. Routine scopes answer eligible `write`, `execute`,
`external_read`, and routine `external` prompts. Bash instead uses one executable scope:
after approval, eligible calls to the same literal executable can consume it regardless of
subcommand classification. A compound command identifies each literal executable,
including through supported wrappers, nested substitutions, and ordinary redirection. Static
sensitive paths, generic destructive or privileged classifications, unresolved executables,
unsupported syntax, and hard-deny assessments remain outside that scope. Dynamic arguments do
not invalidate an otherwise known executable scope; constraining arguments inside an approved
CLI belongs to the future sandbox.

Compound Bash authorization uses all-of scope matching. The assessor returns one deduplicated
requirement per executable. `PermissionGate` loads all candidate grants in one call,
computes the missing set, and automatically approves only when every required scope is present.
An Always decision saves every missing scope in one repository update; partial persistence
never authorizes execution.

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
- target kinds including regular files, directories, special files, missing targets, and
  dangling symlinks.

`file_read` and `file_edit` preflight require an existing regular file. `file_write`
preflight accepts a regular file or an ordinary missing target. `glob` requires a directory,
while `grep` accepts a regular file or directory. Invalid targets return a domain error before
the permission gate; execution still rechecks the target because approval introduces a new
time boundary.

Filesystem and search tools use path-owned persistent scopes after canonicalization. An ordinary
path outside the workspace proposes one parent-directory read or write scope. A fresh assessment
matches that scope against the target's canonical ancestor directory keys. Sensitive files,
including credential files inside the workspace, propose only an exact-file scope and never
consume a parent-directory grant. A read-directory scope recursively covers descendants and is
shared across `file_read`, `glob`, and `grep`; a write-directory scope is shared across
`file_write` and `file_edit`. Read and write capabilities remain distinct and never authorize
Bash. Sensitive writes, virtual system paths, and devices never receive persistent approval. This
keeps `.env`, credential directories, system paths, and symlink targets subject to fresh
sensitive-path classification before any stored grant is considered.

Assessment and execution must use the same injected `cwd`. Tool implementations must
not resolve operation paths with their own `process.cwd()`.

Web assessors classify HTTP and HTTPS reads as `external_read`. Invalid URLs and
non-HTTP(S) protocols are hard denied. Bash `curl` and `wget` remain command execution
and are classified as `external`, not `external_read`.

Bash assessment is deterministic and local:

```text
ShellAnalysisInput
-> analyzeShellCommand
-> Tree-sitter Bash AST
-> one internal ShellProgram semantic IR
-> recursive hard-stop, wrapper, command, path, and executable analyzers
-> one ShellAnalysisResult
-> Bash PermissionAssessment
```

Tree-sitter owns Bash syntax. A tools-local adapter projects only permission-relevant commands,
pipelines, substitutions, assignments, redirections, heredocs, and source spans into
`ShellProgram`; it does not copy the complete parser AST. Domain analyzers consume this IR and
cannot reparse raw command text. A bounded analysis context tracks static cwd, literal variables,
and security effects carried by known variables. This is limited security-flow propagation, not
general stdout simulation. The result contains syntax, command, path, uncertainty, effect,
security, and approval facts; it never contains a policy decision, grant lookup, UI model, or
executable action.

Analysis is bounded to 4,096 semantic nodes, 16 nested execution levels, and 128 tracked literal
variables. Exceeding a bound yields a sensitive `unknown` assessment without persistent scopes;
it never silently skips the remaining syntax.

An eligible command may expose literal-name approval requirements after recursive parsing,
supported wrapper expansion, assignment handling, and redirection analysis. Sequences,
pipelines, command substitutions, and process substitutions require one requirement for each
known executable. The scope deliberately ignores subcommands and dynamic ordinary arguments:
approving `gh` covers later otherwise eligible `gh ...` calls. A substitution used as the
executable, static sensitive paths, generic destructive or privileged classifications, and
hard-stop assessments still take precedence.

Wrappers such as `env`, `command`, `exec`, `nohup`, `time`, `xargs`, and
`bash/sh/zsh -c` are recursively inspected. Partial parser output is still traversed so a
recoverable nested hard-stop cannot hide behind malformed outer syntax; incomplete execution
targets and unsupported expressions become `unknown` and cannot expose persistent scopes.
Classifier `effects` carry security semantics such as download, decode, interpreter, and
network transfer; effects consumed from tracked variables continue through compound and pipeline
aggregation. `ruleIds` remain observational. Command-local non-empty `BASH_ENV`, `ENV`, and
`BASH_FUNC_*` assignments are hard-denied, and Bash execution removes inherited values with those
names so startup injection cannot change the analyzed command graph.

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

Permission state lives at `~/.omni-agent/permissions.json` in version 3 format:

```json
{
  "version": 3,
  "agents": {
    "coding": {
      "mode": "standard",
      "persistentApprovals": [
        {
          "toolIdentity": "builtin-coding:bash",
          "toolName": "bash",
          "scopeKey": "bash:executable:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "scopeKind": "bash_executable",
          "label": "Always trust executable: mycli"
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
`supervised` with no grants. Legacy version 1 identities are normalized and version 1/2
tool approvals migrate once to the routine scope; unrecognized identities are dropped
with diagnostics. Runtime policy, service, and repository logic only understand version 3.

Scope keys are opaque to Core and App. The owning tool creates the scope to persist and the
transient keys that may satisfy its requirement; Core only performs generic any-of/all-of set matching. Bash
executable scopes hash the literal
executable name, not its resolved binary path. A later PATH replacement therefore inherits
the approval until it is revoked; this is a documented pre-sandbox tradeoff rather than a
binary-integrity guarantee. Stored labels never include argv or the full command.

## TUI and Application Facade

CLI implements `ApprovalBroker` through the shared `InteractionSurfacePort`, one foreground
interaction at a time. The TUI control runner owns focus, keyboard listeners, cleanup,
status transitions, and exactly-once Promise settlement. Permission choices are:

- Persist the current eligible scope, when policy permits it. This option is shown first
  and may represent routine tool operations, one literal Bash executable, an external read
  directory, or one exact sensitive file.
- Allow once.
- Deny.

`/permissions` accesses permission state through `AgentApplication` methods. The
command may change mode, list/revoke one scoped grant, or clear Agent grants, and changes take
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
