# Agent Service Host boundary

`AgentService` is the process-local application boundary for Hosts that need to discover and run
the built-in Agents without depending on CLI orchestration, terminal presentation, a network
protocol, or a concrete Agent package.

## Ownership and dependency direction

```text
Host composition root
  -> AgentPackageCatalogPort
  -> AgentFactory
  -> AgentServicePort
       -> AgentApplication
            -> AgentRunner
```

- `AgentPackageCatalog` owns Node package resolution, Manifest-first validation, package identity,
  version, and Blueprint validation.
- The CLI default Catalog factory owns the concrete built-in registrations and bundler variables.
- `AgentService` owns only the `AgentInstance` values it creates, their Session lifecycle, Run
  scheduling, cancellation, and event delivery.
- `AgentApplication` owns the invariant that one instance cannot Run while its Session is changing.
- Core owns Session persistence, Agent execution, Tool coordination, and structured Session errors.
- A Host owns injected Catalog, Factory dependencies, model/configuration services, process
  resources, transport validation, and shutdown order.

`packages/app` does not import the CLI, UI, transport, or a concrete Agent.
`packages/agent-host` is the concrete WebSocket Protocol v2 adapter and calls only
`AgentServicePort`; it does not add another package loader, Factory, Runner, Tool, or Session path.

## Availability and loading

Availability and loading are intentionally separate:

```text
Catalog.list()              explicitly registered and Service-eligible Agents
Catalog.load(agentId)       exact validated package loading
AgentService.openSession()  list-gated Agent execution
```

The default v1 Catalog lists only `coding` and `financial-analysis`. An installed external Agent
remains loadable by exact ID for the existing CLI, but is not listed and cannot be opened through
the v1 Service. Unknown Agents fail explicitly; there is no default-Agent fallback.

The Catalog validates `agent.yaml` before importing executable package code. Package name, package
version, requested Agent ID, Manifest ID, Blueprint descriptor, and contributed Agent identity must
agree. Legacy packages without a Manifest export and Manifest v1 packages fail closed.

## Session and instance lifecycle

One open `(agentId, sessionId)` owns one `AgentInstance`:

```text
absent -> opening -> open -> closing -> absent
```

- Concurrent explicit opens for the same key share one opening operation.
- A session-less latest open and an explicit open can resolve to the same persisted Session only
  after assembly. V1 keeps one instance and immediately disposes the redundant one.
- Opening and Session activation failures roll back the newly created instance.
- Closing rejects new Runs, cancels queued and active Runs, waits for settlement, disposes the
  instance, and removes the record.
- Concurrent closes share one Promise. Service disposal covers opening, open, and closing records
  and continues cleanup after individual failures.
- The Service does not dispose Host-owned Catalog, Model, configuration, or process resources.

## Run contract

`run()` returns a lazy, single-consumer `AsyncIterable<AgentServiceEvent>`:

- the request is submitted on the first iteration;
- one Session runs requests in FIFO order;
- different Sessions may run concurrently;
- active and queued `requestId` values are unique within one Service;
- returning from the iterator cancels queued or active work;
- a second iterator fails explicitly instead of splitting the stream;
- each consumed Run emits at most one terminal event: `completed`, `failed`, or `cancelled`;
- a failed Run does not block later requests in the same Session.

A Host that needs UI rendering, logging, and metrics consumes the Service stream once and performs
its own downstream fan-out.

## Error and transport boundary

Process-local errors retain their concrete type, diagnostic fields, cleanup details, and `cause`.
They are not transport objects. Every Host must call `toAgentServiceFailure(error)` and serialize
only the returned stable shape:

```ts
interface AgentServiceFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}
```

The same projection is used for failed Run events. It preserves actionable codes while replacing
paths and internal diagnostics with bounded messages. Hosts must not serialize an `Error`, its
`cause`, Catalog `source`, or Service cleanup failure records directly.

## Trace boundary

Service Runs call the same `AgentApplication.run()` path as other in-process callers. When Trace is
enabled for the instance, existing Run, model, context, Tool, access, execution, cancellation, and
result observations are therefore captured automatically. The Service does not duplicate those
facts.

Queue wait, Session open/close, consumer abandonment, and cancellation origin are Service
orchestration facts and are not part of v1 Trace. If a real Host requires them, add an optional
App-owned Service observation port and explicit request-to-Run correlation; do not make the Service
depend on the local Trace store or concrete tracer.

## Service exclusions

The Service itself does not include a transport, Godot integration, IM integration, dynamic Agent
registration, package scanning, hot reload, instance LRU, multi-process Session ownership, or CLI
migration. WebSocket v1 lives in `packages/agent-host`; those exclusions can extend the Host or
Catalog boundary without changing the current Agent, Tool, Session, or execution chains.

### Model output truncation

A Provider output-limit stop is not a completed Run. Core may recover up to three consecutive
truncations within the same Run and cancellation scope. Exhaustion is projected through the
existing failed outcome (`model_output_recovery_exhausted`); unsafe signed recovery and
unsupported stop reasons also fail explicitly. Hosts do not infer success from process exit
or Trace completeness, and do not add their own truncation retries.

## Explicit Run deadlines

`AgentServiceRunRequest.deadlineAtMs` is an optional safe-integer UTC millisecond timestamp. Omission adds no default Run limit. Invalid values return `invalid_run_deadline`; expired queued requests are cancelled before activation and do not create a runtime Trace. Queue waiting counts toward the absolute deadline; cancellation of an expired queued request is observed when the queue reaches it, not by a second queue timer.

AgentApplication owns Run supervision for Service and direct callers. It converts the deadline once into monotonic elapsed time and reuses OperationDeadlineSupervisor for cancellation. Context preparation, model calls, tools and output recovery share the original signal and deadline. Deadline exhaustion is cancelled; runtime Trace records `run_deadline_exceeded`. Output persistence finishes before completion is published.

The application retains active ownership until its execution promise settles, including after the supervisor's cleanup grace. This protects Session writes and late model results; a non-cooperative runtime may therefore keep the Session busy. An external process owner may force termination. This does not strengthen trusted in-process tools into OS isolation or guarantee that arbitrary plugin side effects stop; existing ToolInvocationRunner cleanup and late-settlement boundaries still apply.

The headless entry accepts `--deadline-at-ms`. It returns exit 130 for cancellation, preserving the existing outcome mapping. The existing WebSocket protocol does not yet expose this optional request field. No Session storage migration is required.
