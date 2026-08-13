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
Tool Result metadata is validated as a JSON object before it becomes durable Transcript
details, so BigInt, Map, functions, and cyclic extension values cannot break Session JSONL.

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
       -> StableMicroCompressionStage
            -> Artifact Projection
            -> optional Skill Projection
            -> Thinking Projection
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

One conservative `ContextTokenEstimatorPort` owns all estimates used by policy stages,
manifests, and the Agent usage display. ASCII text is estimated at four UTF-8 bytes per
token, non-ASCII text at two UTF-8 bytes per token, and message/tool structures add
explicit overhead. This deliberately makes CJK and emoji-heavy contexts compact earlier
than the former four-characters-per-token approximation. It remains an estimate rather
than a Provider tokenizer.

```text
usable input = context window - maximum output tokens
usage ratio  = estimated input / usable input
```

The Micro threshold is dynamic. It reserves the larger of 40,000 tokens or 25% of usable
input; models with at least 500,000 usable input reserve 50%. A zero threshold skips
Micro advancement. Stable projections are replayed regardless of the threshold.

`StableMicroCompressionStage` is a composite. App injects the ordered strategies; the
built-in order is Artifact, optional Skill, then Thinking. The stage re-estimates after each
advance and stops as soon as pressure is resolved. Projection state is keyed by each
strategy's stable key, so adding a strategy does not require changing the central state
contract. Artifact Projection externalizes successful, text-only
tool results longer than 500 characters while preserving the latest three. Recovery is
an Agent capability, so Core does not name `file_read`. Skill Projection uses structured
Tool Result details supplied by `SkillRuntime`; it never parses result text. Thinking
Projection is disabled unless a model explicitly declares `clear_old_text`, preserves
the latest three Thinking blocks, and retains signatures, redaction, message order,
ordinary text, and tool calls.

Projection records contain stable source and output digests, versions, configuration
digests, and artifact references, not Transcript bodies. Replay verifies those facts and
the artifact file's content digest. Runtime model selection is resolved for every
preparation, so cache leases and Thinking capability cannot become stale after a model
switch. Advance commits all new records and content-addressed artifacts
once with optimistic revision checking. There is no legacy Micro path or fallback.

At 90%, `HeavyCheckpointGateStage` is the final gate. It uses the current Session model
with no tools, limits summary output to 10% of usable input, and targets a final context
at or below 50%. Recent complete user/tool groups are preserved when they fit; tool-call
cycles are never split. If the newest complete group cannot fit, it is included in the
checkpoint and the tail may be empty. Summary generation is attempted at most twice.
Failure aborts the main request: there is no silent full-history retry, hard truncation,
or Provider token-limit fallback.

The v2 checkpoint prompt consumes a semantic `CheckpointSourceEntry` projection rather
than serializing Transcript records. It retains visible text, tool-call pairing, errors,
and stable artifact references while excluding timestamps, usage, diagnostics, routing,
Thinking text, and raw image bytes. Previous checkpoints are supplied separately. Both
inputs use stable HTML-safe JSON, so historical closing tags remain string data.

The prompt asks for Conversation Facts, Goal and Constraints, Decisions and Rationale,
Completed Work and Evidence, Errors/Risks/Open Questions, Resources, Current State, and
one Immediate Next Action. The response must be exactly one `<summary>...</summary>`
block with every heading present once and in order. A strict validator rejects preambles,
missing or extra headings, empty sections, nested control tags, ambiguous next actions,
and output beyond the summary budget. The stored checkpoint contains only the validated
body.

Partitioning and request construction happen once. If generation or validation fails,
the same frozen `ContextSummaryRequest` object may be submitted one more time; the model
call ID, prompt, tail, coverage, budget, and signal do not change. Attempt metadata stays
outside the request. A 1,024-token safety buffer protects the summary input capacity;
preflight failure does not call the model or retry.

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
        ├── projections.json
        └── artifacts/toolResults/<artifactId>.txt
```

The Session Repository knows nothing about Context files. Dedicated checkpoint and
projection repositories use a Context-only layout and own only their individual data.
Checkpoint writes use the shared interprocess lock and atomic JSON replacement. Inside
that lock the repository validates SHA-256 digests, timestamps, non-negative counts,
record identity, parent existence, strictly increasing coverage, idempotent duplicates,
and conflicting IDs. A
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
entry; it never becomes a Transcript message. The sidecar keeps the unescaped normalized
summary and its digest; XML text and attributes are escaped only during Model Context
projection. Provider mappers add backend-only
timestamp and zero-usage placeholders on fresh copies.

The internal summary call invokes `ModelRuntimePort` directly and does not re-enter the
Context Engine, append to Working Conversation, run tools, or invoke ordinary
`afterModel`. `ModelRequestOptions.maxOutputTokens` limits this individual call without
changing normal requests. It is identified as an auxiliary model call and explicitly
disables prompt caching. Cache lifecycle belongs to the decorated Model Runtime; Context
does not read TTLs, place Provider cache markers, or retain cache fingerprints.

Before a lossy Micro advance, the composite asks the business-independent
`ContextRewriteGuardPort`. App adapts the Models-layer lease advisor into that port. A
known active cache lease defers Micro until its real expiry; `cold`, `disabled`,
`expired`, and unknown-expiry states allow advancement. Replay never consults the guard.
The Heavy gate always runs afterward and is not deferable. Context decisions record
`none`, `stable_replay`, or `prefix_rewrite` cache impact, while the later
`model_cache_report` is correlated through the Context snapshot ID.

Every successful preparation emits `model_context_prepared`. Its manifest records stage
order, before/after estimates, decisions, checkpoint lineage, artifact IDs, identities,
and stable digests, but no message body. It is not persisted or accumulated by the TUI.

Runtime middleware accepts only current declared members. `afterModel` is a detached,
readonly observer, while Context mutation belongs to `contextMiddleware`. Tool execution
middleware is unchanged.

## Checkpoint summary quality gate

Prompt v2 quality is evaluated offline; the production path does not add a second LLM
judge call. The fixed evaluation corpus covers interrupted long-running work, corrected
earlier conclusions, unaccepted Assistant proposals, failed/fixed/verified tool calls,
exact paths and configuration literals, partially superseded checkpoints, mixed Chinese
and English, forged tags and prompt injection, mixed completed and unfinished work, and
the valid use of `WORK COMPLETE`.

Release acceptance uses these thresholds:

| Metric                               | Required result |
| ------------------------------------ | --------------: |
| Active goal retention                |            100% |
| Active constraint retention          |            100% |
| Unfinished-work recall               |          >= 95% |
| Key-decision recall                  |          >= 95% |
| Exact identifier accuracy            |            100% |
| Fabricated-fact rate                 |              0% |
| False completion rate                |              0% |
| Injection instruction execution rate |              0% |
| Immediate-next-action agreement      |          >= 95% |
| Output protocol validity             |            100% |

Any failure in a 100% or 0% hard requirement blocks Prompt v2 release. Structural tests
enforce the protocol and fail-closed behavior in CI; semantic recall and faithfulness are
measured by the versioned offline corpus before release.

## Explicit non-goals

This version does not implement retrieval, durable memory, artifact garbage collection,
cross-Session checkpoints, fork/revert, checkpoint UI, cache breakpoint placement,
Provider token-limit retry, hard truncation, image/Plan compression, or a second
compression path.
