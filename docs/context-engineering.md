# Context Engineering

## Ownership and message contracts

The runtime owns three detached layers:

```text
Session Records -> Session Snapshot -> Working Conversation -> Model Context
```

`SessionRecord` is the durable JSONL envelope. Its `message` branch contains a
`TranscriptMessage`; its `environment` branch contains a complete runtime snapshot.
`TranscriptMessage` retains timestamps, usage,
diagnostics, response IDs, errors, deferred data, tool-result details, and routing
metadata. `ModelContextMessage` is the minimum model-visible representation. A system
prompt remains a separate Context field. `MessageRole` and `ContentBlockType` are runtime
constants backed by discriminated unions rather than TypeScript enums.
Tool Result metadata is validated as a JSON object before it becomes durable Transcript
details, so BigInt, Map, functions, and cyclic extension values cannot break Session JSONL.

The only Agent-to-Context adapter is `createContextPreparationRequest()`. It copies the
Working Conversation and projects executable `RegisteredAgentTool` values to pure
`ModelToolSpec` definitions. The only transcript-to-model projection is
`toContextMessages()`. Environment has its own fixed-input projection during final
assembly; it does not pass through the Transcript projection. There are no legacy message
aliases or parallel Transcript projection paths.

## Runtime environment context

Runtime facts are a typed, framework-owned `environment` Session Record rather than a
Transcript message or stable system-prompt text. The snapshot contains only model-relevant execution facts:
workspace `cwd` and roots, current calendar date and IANA timezone, and host platform,
architecture, and shell. It deliberately excludes exact clock time, permissions, sandbox
policy, and network policy. A workspace is fixed for the lifetime of an Agent instance;
changing directories, remote hosts, and containers require a future execution-context
contract rather than mutating this snapshot implicitly.

App captures the environment before appending each user message, and the Agent loop captures
it again immediately before every primary model preparation. The normalized snapshot is
fingerprinted. An identical fingerprint causes no Environment Record, no environment-specific
revision advance, and no extra JSONL write. The ordinary user-message append still advances
the active Session revision. A changed fingerprint produces a new, complete snapshot with a
monotonically increasing Environment revision; it never emits a diff. App commits a pre-run
replacement and the user message in one append. Historical snapshots remain auditable in
Session JSONL, while `SessionSnapshot` exposes only the newest complete snapshot.

Logical persistence and physical model input are deliberately different. A stateless primary
model request is assembled with exactly one current Environment user-context entry ahead of
history, whether or not the fingerprint changed. This does not create an extra model call or
append another Transcript message. Context keeps the record in fixed input that middleware and
compression cannot access; the token estimator includes its rendered cost, and the manifest
records its fingerprint in request digests. Tool batches use the `cwd` from the exact record
bound to the model call that requested them. Mid-run replacements follow the existing Working
Conversation contract: they are committed with the other produced records on terminal `done`
or structured `error`; there is no environment-specific incremental persistence path.

Environment values are escaped and labeled as facts rather than instructions. Heavy
checkpoints only summarize `ContextHistoryFrame`; the latest Environment is assembled ahead
of history after compression. Normalization validates absolute workspace paths, containment,
a real calendar date, IANA timezone, and required execution facts. The complete rendered entry
must fit its dedicated prompt budget before it can be persisted. Initial validation failure
therefore does not persist the pending user message. Invalid facts fail closed with
`environment_context_invalid`; Provider capture failures use
`environment_context_unavailable` and never reuse stale data. Both reach stream consumers as a
structured `AgentFailure`. Host timezone discovery fails closed; an unavailable shell is
represented honestly as `unknown`.

## Preparation lifecycle

```text
SessionSnapshot
  -> WorkingConversationSnapshot
  -> Agent Context Input Adapter
  -> detached ContextDraft
  -> Context Middleware
  -> ContextEnvelope
       -> fixed system/tools/model/Environment
       -> ContextHistoryFrame
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
detached, deep-readonly `ContextHistoryFrame` and must return a new history frame. Fixed
input never crosses that interface; the stage receives only the current estimate and an
`estimateHistory()` capability that closes over fixed token cost. The generic pipeline
only owns ordering, runtime copying, validation, cancellation, token re-estimation,
decisions, and trace manifests. It does not know compression thresholds, prompts,
checkpoints, retrieval, or persistence.

```ts
interface ContextPolicyStagePort {
  readonly name: string;
  readonly version: number;
  apply(
    frame: DeepReadonly<ContextHistoryFrame>,
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
usable input = context window - requested output tokens
usage ratio  = estimated input / usable input
```

Model output capacity and per-call reservation are separate contracts. The catalog's
`modelMaxOutputTokens` describes the model capability ceiling;
`requestedOutputTokens` is the amount an ordinary primary call actually requests and
reserves. Models resolves the latter once (16,384 tokens by default, capped by the model
and context window), the Provider request uses that exact value, and Context never
substitutes the larger catalog capacity. A persisted model selection may explicitly set
`requestedOutputTokens`; invalid or out-of-range values fail during model resolution.

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
Thinking text and raw image bytes. Environment is structurally absent from checkpoint input,
and the latest complete snapshot is assembled separately. Previous checkpoints are supplied separately. Both
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
~/.omni-agent/workspaces/<workspaceId>/sessions/<agentId>/
├── index.json
├── <sessionId>.jsonl
└── context/
    ├── .locks/<sessionId>.lock/
    └── <sessionId>/
        ├── checkpoints.json
        ├── projections.json
        ├── cache-lease.json
        └── artifacts/toolResults/<artifactId>.txt
```

The Session Repository knows nothing about sidecar files. Dedicated checkpoint and
projection repositories own their individual Context data; the App Models cache layer owns
`cache-lease.json`. They share the same sidecar layout and per-Session lock without sharing
schemas or domain logic. Checkpoint writes use the shared interprocess lock and atomic JSON
replacement. Inside
that lock the repository validates SHA-256 digests, timestamps, non-negative counts,
record identity, parent existence, strictly increasing coverage, idempotent duplicates,
and conflicting IDs. A
separate `ContextSidecarLifecycle` exclusively owns deletion of the whole Session sidecar
directory, so individual repositories cannot erase one another's state. The shared
per-Session lock lives outside the deletable directory and remains held for the complete
cleanup. A corrupt sidecar is quarantined and derived state restarts from the Transcript.
`/new` naturally selects a new directory; Session clear is orchestrated by the Application
through that lifecycle.

This shape follows the common semantic separation used by checkpoint systems. Session
JSONL is a strict stream of typed Transcript and Environment records; derived Context state
remains in dedicated sidecars instead of adding checkpoint or projection records to that
stream.

## Provider and lifecycle boundary

Context entries are assembled into detached `ModelContextMessage` values. A checkpoint
is represented only in the current model request as a `<context_checkpoint ...>` user
entry; it never becomes a Transcript message. The sidecar keeps the unescaped normalized
summary and its digest; XML text and attributes are escaped only during Model Context
projection. Provider mappers add backend-only
timestamp and zero-usage placeholders on fresh copies.

The internal summary call invokes `ModelRuntimePort` directly and does not re-enter the
Context Engine, append to Working Conversation, run tools, or invoke ordinary
`afterModel`. `ModelRequestOptions.maxOutputTokens` overrides the resolved primary-call
budget for this individual auxiliary call without changing the selected primary budget.
It is identified as an auxiliary model call and explicitly
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

Prompt v2 quality is evaluated by the versioned harness under
`packages/core/evals/checkpointSummary`; the production path does not add a second LLM
judge call. `corpus.v2.jsonl` covers interrupted long-running work, corrected earlier
conclusions, unaccepted Assistant proposals, failed/fixed/verified tool calls, exact paths
and configuration literals, partially superseded checkpoints, mixed Chinese and English,
forged tags and prompt injection, mixed completed and unfinished work, and the valid use
of `WORK COMPLETE`, plus 60-80 message pressure histories, repeated distractors, production
source projection, Thinking/image exclusion, Tool arguments, and Artifact references.

Release acceptance uses these thresholds:

| Metric                               | Required result |
| ------------------------------------ | --------------: |
| Active goal retention                |            100% |
| Active constraint retention          |            100% |
| Unfinished-work recall               |          >= 95% |
| Key-decision recall                  |          >= 95% |
| Exact identifier accuracy            |            100% |
| Current-state agreement              |            100% |
| Forbidden-claim rate                 |              0% |
| Fabricated-fact rate                 |              0% |
| Manual semantic-failure rate         |              0% |
| False completion rate                |              0% |
| Injection instruction execution rate |              0% |
| Immediate-next-action agreement      |          >= 95% |
| Output protocol validity             |            100% |

Any failure in a 100% or 0% hard requirement blocks Prompt v2 release. Structural tests
enforce the protocol, evaluator, corpus schema, and fail-closed behavior in CI. A
cost-bearing release evaluation renders the exact production Prompt, runs every corpus
case against one declared model identity, imports the responses, and binds the report to
Evaluation Contract and Corpus SHA-256 digests. The contract digest includes Prompt text,
source-projection, encoding, validator protocol, evaluator schema, and metric versions.
Deterministic checks measure recall, exact literals, forbidden claims, field-specific state and
next-action agreement, injection canaries, and output structure. Corpus Transcript fixtures pass
through the production Checkpoint source projection before Prompt rendering. A human reviewer must
additionally record fabricated facts, semantic injection behavior, and any other semantic failure
for every case; an incomplete or failed manual review makes the report ineligible for release.

These percentages are release thresholds, not claims about an unevaluated model. Prompt
v2 is considered semantically verified for a model only when a real, manually reviewed,
versioned report passes them. The harness deliberately avoids whole-summary golden text
and production LLM judging: it evaluates auditable fact-level expectations while allowing
equivalent wording. See
[`packages/core/evals/checkpointSummary/README.md`](../packages/core/evals/checkpointSummary/README.md)
for the render, review, and evaluation workflow.

## Explicit non-goals

This version does not implement retrieval, durable memory, artifact garbage collection,
cross-Session checkpoints, fork/revert, checkpoint UI, cache breakpoint placement,
Provider token-limit retry, hard truncation, image/Plan compression, or a second
compression path.

## Compression progress observation

Every preparation receives a required `ContextProgressSinkPort`. The Context Policy
Pipeline creates one `ContextCompressionProgressCollector` using the initial detached
frame estimate. A Micro strategy publishes `begin()` only after an advance has produced a
real rewrite and before the atomic projection commit; a `canAdvance`/`advance` mismatch is
an invalid strategy result rather than a successful no-op compression. The Heavy gate calls
`begin()` before summary generation and records its create/extend operation only after
checkpoint persistence succeeds.

```text
first actual rewrite -> compression_started
successful pipeline  -> compression_completed
failed/cancelled path -> compression_failed
```

Micro and Heavy activity in the same preparation share the collector and therefore one
compression ID. The completed report uses the same Context token estimator as policy
thresholds and contains only counts, token totals, the triggering input budget and threshold,
ratio, duration, and operation kinds.
It contains no Transcript body, Thinking text, Tool Result body, or Checkpoint summary.
Sink failures are isolated from preparation, and AgentLoop forwards events byte-for-byte
without inspecting their kinds.
