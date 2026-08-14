# Checkpoint Summary Offline Evaluation

This directory evaluates the semantic quality of Heavy Checkpoint Prompt v2. It is not
imported by production code, does not run inside AgentLoop, and never adds a production
LLM judge call.

## Workflow

1. Render one deterministic request per versioned corpus case:

   ```bash
   pnpm eval:checkpoint -- render --output /tmp/checkpoint-requests.jsonl
   ```

2. Run every request against one selected summary model. Store one JSON object per line:

   ```json
   {
     "id": "interrupted-work-zh",
     "evaluationContractDigest": "<copy from the rendered request>",
     "corpusDigest": "<copy from the rendered request>",
     "response": "<summary>...</summary>",
     "provider": "provider-id",
     "model": "requested-model-id",
     "responseModel": "actual-model-id",
     "manualReview": {
       "fabricatedFacts": [],
       "injectionFollowed": false,
       "semanticFailures": [],
       "notes": "Optional reviewer notes"
     }
   }
   ```

   A report is deliberately ineligible for release until every response has a manual
   hallucination and injection review. This prevents substring checks from being reported
   as proof of a zero-fabrication rate.

3. Evaluate and write a versioned report:

   ```bash
   pnpm eval:checkpoint -- evaluate \
     --responses /tmp/checkpoint-responses.jsonl \
     --output packages/core/evals/checkpointSummary/reports/promptV2.<model>.json
   ```

The command exits non-zero when any release threshold fails. Every response must carry the
Evaluation Contract and Corpus digests from its rendered request; mismatches are rejected before
scoring. The contract digest binds the Prompt template, production source projection, prompt
encoding, strict summary protocol, evaluator schema, and metric definition. Reports also bind the
result to Prompt version, provider, requested model, and actual response model. Never combine
multiple model identities in one report.

## Scoring

The evaluator checks required goal, constraint, unfinished-work, decision, exact-literal,
current-state, and next-action signals. State and next action are scored from their exact fields,
not from their shared section. It also checks forbidden claims, injection canaries, false
`WORK COMPLETE` declarations, the strict output protocol, and manual review results.
Declared recall thresholds are applied across the corpus; forbidden claims, missing current
state, incomplete manual review, and hard 100%/0% metrics remain fail-closed.

Rendered requests also carry the production summary-call constraints: no tools,
`purpose: auxiliary`, and `cache.retention: none`.

Corpus fixtures are hydrated into Transcript entries and passed through the production
`createCheckpointSourceEntries()` projection before Prompt rendering. High-pressure cases include
60-80 distractor messages, repeated facts, a previous checkpoint, tool arguments, Thinking,
image data, Artifact references, and injected tags. The corpus intentionally does not contain a
complete golden summary. Full-text equality is
brittle and rewards wording rather than continuity. Each case instead defines auditable
fact-level requirements and forbidden semantic outcomes.

## Release policy

Structural unit tests remain part of ordinary CI. Real-model evaluation is an explicit,
cost-bearing release activity whenever Prompt v2, its source projection, the summary model,
or compression semantics change. Manual review must record fabricated facts, followed injection,
and any other semantic failure; any non-empty semantic failure list blocks release. Do not commit a
baseline report unless it was produced from real model responses and manually reviewed.
