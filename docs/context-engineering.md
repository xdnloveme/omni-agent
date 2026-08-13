# Context Engineering

## Ownership and message contracts

The runtime owns three detached layers:

```text
Session Transcript -> Working Conversation -> Model Context
```

`TranscriptMessage` is the durable run record and retains timestamps, usage,
diagnostics, response IDs, errors, deferred data, tool-result details, and routing
metadata. `ModelContextMessage` is the minimum model-visible representation. A system
prompt remains a separate Context field. `MessageRole` and `ContentBlockType` are runtime
constants backed by discriminated unions rather than TypeScript enums.

The only Agent-to-Context adapter is `createContextPreparationRequest()`. It copies the
Working Conversation and projects executable `RegisteredAgentTool` values to pure
`ModelToolSpec` definitions. The only transcript-to-model projection is
`toContextMessages()`. There are no legacy message aliases or parallel projection paths.

## Preparation lifecycle

```text
SessionTranscriptSnapshot
  -> WorkingConversationSnapshot
  -> Agent Context Input Adapter
  -> detached ContextDraft
  -> Context Middleware
  -> ContextFrame
  -> ContextPolicyPipeline
       -> Agent policy stages
       -> Extension policy stages
       -> ToolResultMicroStage
       -> mandatory ContextFinalGatePort
            -> HeavyCheckpointGateStage
  -> Context Assembly
  -> PreparedModelContext
  -> ModelRuntimePort
```

Middleware transforms the draft before policy resolution. A policy stage receives a
detached, deep-readonly `ContextFrame` and must return a new frame. The generic pipeline
only owns ordering, runtime copying, validation, cancellation, token re-estimation,
decisions, and trace manifests. It does not know compression thresholds, prompts,
checkpoints, retrieval, or persistence.

```ts
interface ContextPolicyStagePort {
  readonly name: string;
  readonly version: number;
  apply(
    frame: DeepReadonly<ContextFrame>,
    options: ContextPolicyStageOptions,
  ): Promise<ContextPolicyStageResult>;
}
```

Agents declare `context.policyStages`; extensions contribute `contextPolicyStages`.
Both are pre-gate extension points and execute in registration order. Their options are
limited to Agent/Session/model-call identity, the current token estimate, cancellation,
and no raw source transcript or checkpoint trace internals. The application composition
root appends the built-in Micro stage, then supplies the Heavy implementation through a
separate, required `ContextFinalGatePort`. Only that final gate receives the detached raw
source, middleware digest, Session revision, and upstream stage manifest needed to
validate a checkpoint. There is deliberately no post-gate hook, numeric priority, or
fallback execution path.

## Budget and built-in stages

The existing four-characters-per-token estimate is now owned by one
`ContextTokenEstimatorPort`. All stages and the Agent usage display consume that result.

```text
usable input = context window - maximum output tokens
usage ratio  = estimated input / usable input
```

At 75%, `ToolResultMicroStage` externalizes successful, text-only tool results longer
than 500 characters, while preserving the latest three eligible results. It retains tool
pairing, digest, length, artifact ID, absolute path, and `file_read` recovery guidance.
Image and error results are never externalized. Artifact IDs are content-addressed and
writes are idempotent.

At 90%, `HeavyCheckpointGateStage` is the final gate. It uses the current Session model
with no tools, limits summary output to 10% of usable input, and targets a final context
at or below 50%. Recent complete user/tool groups are preserved when they fit; tool-call
cycles are never split. If the newest complete group cannot fit, it is included in the
checkpoint and the tail may be empty. Summary generation is attempted at most twice.
Failure aborts the main request: there is no silent full-history retry, hard truncation,
or Provider token-limit fallback.

The versioned checkpoint prompt asks for Goal and Constraints, Decisions and Rationale,
Completed Work and Evidence, Errors/Risks/Open Questions, Resources and Artifact
References, Current State, and Immediate Next Action. It explicitly compiles continuation
state rather than answering the user and treats tool output as data, not instructions.

## Checkpoint chain and storage

Checkpoints form a parent-linked chain. Each node records the covered transcript count
and digest, middleware digest, stage and prompt versions, summary digest and estimate,
generating model identity, Session revision, and creation time. On every preparation the
Heavy gate selects the newest compatible node whose transcript prefix and summary digest
still match. An incompatible node is ignored; an earlier compatible ancestor may be
used. The Transcript remains the source of truth, so stale or lost sidecar state is
rebuildable.

Storage is physically co-located with Sessions but logically isolated:

```text
~/.omni-agent/sessions/<agentId>/
├── index.json
├── <sessionId>.jsonl
└── context/
    ├── .locks/<sessionId>.lock/
    └── <sessionId>/
        ├── checkpoints.json
        └── artifacts/toolResults/<artifactId>.txt
```

The Session Repository knows nothing about Context files. Dedicated checkpoint and
artifact repositories use the shared storage layout and own only their individual data.
Checkpoint writes use the shared interprocess lock and atomic JSON replacement. A
separate `ContextSidecarLifecycle` exclusively owns deletion of the whole Session Context
directory, so neither repository can erase the other's state. The shared per-Session
lock lives outside the deletable directory and remains held for the complete cleanup. A corrupt sidecar is
quarantined and derived state restarts from the Transcript. `/new` naturally selects a
new directory; Session clear is orchestrated by the Application through that lifecycle.

This shape follows the common semantic separation used by checkpoint systems while
avoiding the migration cost of converting the existing message-only JSONL into a
versioned Event Store. Verdent can place checkpoint events in its Session Event Store
because that store already owns sequence IDs, event types, read models, and head
movement. Omni Agent deliberately preserves its pure Transcript JSONL contract.

## Provider and lifecycle boundary

Context entries are assembled into detached `ModelContextMessage` values. A checkpoint
is represented only in the current model request as a `<context_checkpoint ...>` user
entry; it never becomes a Transcript message. Provider mappers add backend-only
timestamp and zero-usage placeholders on fresh copies.

The internal summary call invokes `ModelRuntimePort` directly and does not re-enter the
Context Engine, append to Working Conversation, run tools, or invoke ordinary
`afterModel`. `ModelRequestOptions.maxOutputTokens` limits this individual call without
changing normal requests. It is identified as an auxiliary model call and explicitly
disables prompt caching. Cache lifecycle belongs to the decorated Model Runtime; Context
does not read TTLs, place Provider cache markers, or retain cache fingerprints.

Every successful preparation emits `model_context_prepared`. Its manifest records stage
order, before/after estimates, decisions, checkpoint lineage, artifact IDs, identities,
and stable digests, but no message body. It is not persisted or accumulated by the TUI.

Runtime middleware accepts only current declared members. `afterModel` is a detached,
readonly observer, while Context mutation belongs to `contextMiddleware`. Tool execution
middleware is unchanged.

## Explicit non-goals

This version does not implement retrieval, durable memory, configurable thresholds,
artifact garbage collection, cross-Session checkpoints, fork/revert, checkpoint UI,
Provider token-limit retry, hard truncation, or a second compression path.
