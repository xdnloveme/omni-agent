# Clarification Routing Offline Evaluation

This corpus measures whether the production Coding Agent asks only for material decisions that
cannot be resolved through repository discovery or a safe, reversible, low-impact default. It is
an offline release evaluation: it does not run inside AgentLoop and does not add a production model
call.

## Workflow

Render 20 requests from the versioned corpus using the production Coding Prompt and
`request_user_input` definition:

```bash
pnpm eval:clarification -- render --output /tmp/clarification-requests.jsonl
```

Run every request against one model and record its normalized text and tool calls. For any response
that calls `request_user_input`, manually review the generated questions:

```json
{
  "id": "ask-public-api-rename",
  "evaluationContractDigest": "<from rendered request>",
  "corpusDigest": "<from rendered request>",
  "provider": "provider-id",
  "model": "requested-model-id",
  "responseModel": "actual-model-id",
  "text": "Optional assistant text",
  "toolCalls": [
    {
      "name": "request_user_input",
      "arguments": { "questions": [] }
    }
  ],
  "manualReview": {
    "decisionFocused": true,
    "optionsMutuallyExclusive": true,
    "recommendationAndTradeoffs": true,
    "customInputHandledCorrectly": true,
    "notes": "Optional reviewer notes"
  },
  "continuationReview": {
    "continuedAppropriately": true,
    "notes": "Required only for clarification_result cases; confirm the model actually continued instead of merely avoiding another clarification call"
  }
}
```

Evaluate the normalized responses:

```bash
pnpm eval:clarification -- evaluate \
  --responses /tmp/clarification-responses.jsonl \
  --output agents/coding/evals/clarificationRouting/reports/promptV1.<model>.json
```

The report tracks routing accuracy, ask recall and precision, unnecessary interruption rate,
request validity, question quality, correct `allowOther` usage, and manually verified continuation
after submitted or skipped clarification. A response does not pass a continuation case merely
because it avoids another `request_user_input` call.
Contract and corpus digests prevent results from a previous Prompt, tool definition, metric policy,
or corpus from being reported against the current version. Do not commit a baseline report unless
it was generated from real model responses and manually reviewed.
