# Context Engineering

## Message contracts and ownership

The runtime uses two message families with deliberately different meanings:

| Contract              | Owner and purpose                                     | Metadata                                                                                                 |
| --------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `TranscriptMessage`   | Session and Working Conversation; complete run record | timestamps, usage, diagnostics, response IDs, errors, deferred data, tool-result details, routing fields |
| `ModelContextMessage` | Prepared model input; minimum model-visible history   | content, tool pairing, assistant routing and stop fields                                                 |

`MessageRole` and `ContentBlockType` provide runtime constants while the TypeScript
contracts remain discriminated unions. A system prompt is a separate Context field and
never becomes a transcript message.

The source migration is intentionally one-way and has no deprecated aliases:

| Removed                  | Replacement                   |
| ------------------------ | ----------------------------- |
| `AgentMessage`           | `TranscriptMessage`           |
| `UserAgentMessage`       | `UserTranscriptMessage`       |
| `AssistantAgentMessage`  | `AssistantTranscriptMessage`  |
| `ToolResultAgentMessage` | `ToolResultTranscriptMessage` |

All consumers import these contracts from the `@omni-agent/core` root.

## Preparation boundary

```text
SessionTranscriptSnapshot
  -> WorkingConversationSnapshot
  -> createContextPreparationRequest
  -> ContextConversationSource
  -> ContextDraft
  -> middleware
  -> strategy
  -> assembly / toContextMessages
  -> PreparedModelContext
  -> ModelRequest
  -> Provider mapper
```

`createContextPreparationRequest()` is the only Agent-to-Context adapter. It owns the
copy from Working Conversation and the projection from `RegisteredAgentTool` to
`ModelToolSpec`. The resulting Context request contains neither a Working Conversation
nor executable, authorization, timeout, or host-policy fields.

`toContextMessages(messages: readonly TranscriptMessage[]): ModelContextMessage[]` is
the only transcript-to-model projection. It preserves count, order, content, tool-call
pairing, assistant provider routing, stop reason, and deferred response data while
removing transcript-only metadata. Its output owns fresh content blocks, tool arguments,
deferred data, and tool-name arrays.

## Extension contract

Context middleware is declared separately from runtime lifecycle middleware:

```ts
const extension = {
  manifest: { id: "example", version: "1.0.0", apiVersion: 1 },
  contributions: {
    contextMiddleware: [
      {
        name: "example_context",
        version: 1,
        transform(draft, options) {
          return {
            ...draft,
            messages: [...draft.messages],
            tools: [...draft.tools],
            model: { ...draft.model },
          };
        },
      },
    ],
  },
};
```

Middleware runs serially in extension registration order. It receives only a detached,
deep-readonly `ContextDraft` and call identity options. It cannot receive a Session,
Repository, `WorkingConversation`, `AgentConfig`, Provider, or executable tool. It must
return a new Draft. Invalid output, cancellation, or an exception aborts context
preparation before the Provider is called.

Middleware and strategy may inspect the detached transcript messages, system prompt,
pure model tool definitions, and model limits. They cannot access a Session, Repository,
Working Conversation, Agent configuration, Provider implementation, or executable tool.

## Strategy capability

An Agent may provide one message-selection strategy:

```ts
capabilities: {
  context: {
    strategy: {
      name: "custom",
      version: 1,
      async apply(draft, options) {
        return {
          messages: [...draft.messages],
          decisions: [{ type: "preserve_all" }],
        };
      },
    },
  },
}
```

A strategy decides only which messages enter the current model context. It has no
Repository, persistence, Provider, or tool-execution access. When no capability is
provided, `FullHistoryContextStrategy` preserves every message in order.

## Provider and custom transport boundary

Provider mappers accept `ModelContextMessage[]` and build detached backend-library
messages. At that final transport boundary they add the fields required by the backend:

- user and tool-result messages receive `timestamp: 0`;
- assistant messages receive `timestamp: 0` and zero-valued usage/cost fields;
- content blocks, tool arguments, deferred data, added tool names, and tool schemas are
  copied before transport.

These are transport placeholders only; they are not members of `ModelContextMessage`.
A Provider mutating its backend Context therefore cannot mutate `PreparedModelContext`.

Custom transports migrate request typing directly:

```ts
const transport: ModelTransport = {
  async *stream(model, request) {
    // request.messages is readonly ModelContextMessage[]
    yield { type: "text_delta", delta: "..." };
    yield { type: "done", message: assistantTranscriptMessage };
  },
};
```

Completion events still carry `AssistantTranscriptMessage` because responses re-enter
the complete runtime transcript. Legacy message aliases, Context deep imports, a second
projection function, and parallel `ModelRequest` paths are forbidden and enforced by
architecture tests.

## Lifecycle migration

The former hook:

```ts
beforeModel(config, messages);
```

has been removed. Registration rejects it with a migration diagnostic. There is no
legacy model-middleware branch.

Transformations of model input move to `contextMiddleware`. Post-call observation uses:

```ts
afterModel({ request, response });
```

Both request and response are detached, deep-readonly values. Mutating them through an
unsafe cast cannot change the Provider response, Working Conversation, or later calls.
Tool `beforeExecute` and `afterExecute` middleware contracts are unchanged.

## Snapshot event

Every successful preparation emits `model_context_prepared`. Consumers may subscribe
with `StreamCallbacks.onModelContextPrepared`. The event carries only the manifest and
is ignored by the default TUI. It is neither accumulated as a conversation message nor
persisted to Session JSONL.

This phase intentionally does not implement compression, truncation, summarization,
retrieval, token budgets, checkpoints, snapshot persistence, or token-limit retries.
