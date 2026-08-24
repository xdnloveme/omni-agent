# Runtime Observation and Local Trace

Omni Agent separates runtime observation from Trace processing and local storage:

```text
Runtime authoritative stages
  -> typed scoped Runtime Observation facts
  -> SpanRuntimeObserver + ReplayRuntimeObserver
  -> TracerPort / ReplaySinkPort
  -> App local store and TraceQueryPort
  -> CLI Preview
```

## Runtime Observation

Runtime Observation is a Core-to-Host composition SPI exposed only through
`@omni-agent/core/host`. The top-level port starts one Run and returns scoped handles for Turn,
Context, Model, Tool Batch, Tool Call, preflight, access, and execution. Each scope exposes
only facts owned by that runtime stage and one terminal transition.

Observation is not a control channel:

- methods are synchronous, fail-open, and perform no I/O;
- facts are readonly snapshots and cannot modify runtime input or output;
- `run()` only propagates observer context and preserves callback results and exceptions;
- iterator propagation preserves `next`, `throw`, `return`, and consumer early return;
- Composite isolates each consumer and replaces a failed child with its Noop equivalent;
- terminal transitions are idempotent in both Composite handles and Trace processors.
- Composite rejects child creation and event publication after a scope reaches its terminal state.

Runtime Observation remains separate from `StreamSession`, Session JSONL, runtime middleware,
tool lifecycle adapters, and access control. It is not exposed to Agent extensions.

## Trace processing

Trace processing is the sole owner of observation semantics:

- `SpanRuntimeObserver` maps scoped facts to span names, attributes, parentage, and status.
- `ReplayRuntimeObserver` maps facts to Replay kinds, payloads, correlation, and ordering.
- model request capture represents the actual prepared Core invocation context, not a provider
  HTTP request body.
- tool hidden input keys are supplied by the tool-owned access descriptor and sanitized by
  the shared Trace sanitizer before persistence.

Concrete Agent blueprints receive no Trace capability and cannot publish Runtime facts. Host Trace
control remains separate from Agent capabilities; domain diagnostics continue to use their owning
domain contracts rather than reaching into Runtime Observation.

## Capture and local inspection

`AgentApplication` depends only on `AgentRunObservationPort`. The local Trace runtime implements
that lifecycle port and owns begin, context propagation, terminal handling, and flush. App freezes
the capture decision when a Run starts. Stopping Trace prevents later Runs from being captured but
does not truncate an active Run. Local recorders use a bounded asynchronous write
queue, preserving lifecycle records ahead of streamed detail. If storage falls behind and the
queue fills, detail records degrade with one bounded diagnostic instead of backpressuring Runtime.
If any queued record is dropped, the completed Run manifest records the degraded capture and its
dropped-record count. Session summaries are reconciled from Run manifests, so the append-only
index remains an optimization rather than a source of truth. CLI Preview marks degraded Runs in
the Run list and shows the dropped-record count in the selected Run so incomplete evidence cannot
be mistaken for a complete capture.

`TraceQueryPort` is the viewer boundary. CLI Preview receives it from App's local query factory for
historical runs, active-run streaming, and payload parts. Clear uses a separate maintenance port;
neither command imports Runtime Observation or store internals.

The local disk schema, query DTOs, Preview HTTP/SSE contract, Session JSONL, and Context sidecars
are compatibility boundaries. Future exporters should attach below Trace processing rather than
adding a second runtime execution or observation path.

## Assembly evidence

After composition, extensions, prompt, and tools are resolved, App creates `AgentAssemblyEvidence`,
the sole owner of the current effective assembly facts. Evidence includes the selected Prompt
profile, ordered contributor IDs, Tool component IDs, and Capability IDs, but never the Manifest
source or executable implementations. Model and instruction configuration transitions
update that evidence. At Run start, App projects it into a frozen `AgentAssemblySnapshot`. Its digest
is computed from `AgentAssemblyFacts` before the digest field is attached, so it cannot be
self-referential. Arrays retain runtime order; paths, credentials, prompt text, environment values,
tool inputs, and Session data are excluded.

`AgentScopedTraceRuntime` receives a read-only Snapshot provider and reads it exactly once when a Run
starts. The same Snapshot is written to that Run's running and completed Manifests, so later
configuration changes cannot rewrite historical evidence. Trace never feeds the Snapshot back into
configuration, runtime decisions, or model-cache identity and policy. Historical Manifests without
the field remain readable and require no migration; Session JSONL and Context sidecars are unchanged.
