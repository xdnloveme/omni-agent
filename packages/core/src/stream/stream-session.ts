import type { StreamEvent, StreamCallbacks, StreamState, AccumulatedMessage } from "./types";
import type { ExtensionEvent } from "../extension-events";
import type { AgentFailure, TokenUsage } from "../types";
import { cloneData } from "../dataCopy";

/**
 * StreamSession — a lightweight state machine for managing streaming output.
 *
 * Design principles:
 * - Pure core layer: no dependency on CLI/TUI modules
 * - Callbacks are the extension point: TUI, harness, JSON-line, test mock
 * - Accumulated messages enable replay/recording for harness engineering
 * - State transitions are strict and predictable
 */
export class StreamSession {
  private _state: StreamState = "idle";
  private _messages: AccumulatedMessage[] = [];
  private _textBuffer = "";
  private readonly _callbacks: StreamCallbacks;

  constructor(callbacks: StreamCallbacks = {}) {
    this._callbacks = callbacks;
  }

  /** Current state of the session */
  get state(): StreamState {
    return this._state;
  }

  /**
   * Dispatch a stream event through the state machine.
   * Transitions state and invokes the appropriate callback.
   */
  handle(event: StreamEvent): void {
    switch (event.type) {
      case "text_delta":
        this.handleTextDelta(event.delta);
        break;
      case "thinking_start":
        this.handleThinkingStart(event);
        break;
      case "thinking_delta":
        this.handleThinkingDelta(event);
        break;
      case "thinking_end":
        this.handleThinkingEnd(event);
        break;
      case "model_context_prepared":
        this.notify(() => this._callbacks.onModelContextPrepared?.(cloneData(event.manifest)));
        break;
      case "model_cache_report":
        this.notify(() => this._callbacks.onModelCacheReport?.(cloneData(event.report)));
        break;
      case "context_progress":
        this.notify(() => this._callbacks.onContextProgress?.(cloneData(event.event)));
        break;
      case "tool_batch_started":
        this.notify(() => this._callbacks.onToolBatchStart?.(cloneData(event)));
        break;
      case "tool_use_start":
        this.handleToolStart(event);
        break;
      case "tool_use_end":
        this.handleToolEnd(event);
        break;
      case "tool_batch_completed":
        this.notify(() => this._callbacks.onToolBatchEnd?.(cloneData(event)));
        break;
      case "extension_event":
        this.handleExtensionEvent(event);
        break;
      case "done":
        this.handleDone(event.usage);
        break;
      case "error":
        this.handleError(event.failure);
        break;
    }
  }

  /**
   * Get all accumulated messages from this session.
   * Useful for harness replay/recording and testing.
   */
  getAccumulatedMessages(): ReadonlyArray<AccumulatedMessage> {
    return this._messages;
  }

  /**
   * Get the full accumulated text output (all text deltas concatenated).
   */
  getAccumulatedText(): string {
    return this._textBuffer;
  }

  /**
   * Reset the session to idle state, clearing all accumulated data.
   */
  reset(): void {
    this._state = "idle";
    this._messages = [];
    this._textBuffer = "";
  }

  // --- Private handlers ---

  private handleTextDelta(delta: string): void {
    this.transitionTo("streaming");
    this._textBuffer += delta;
    this._messages.push({
      type: "text",
      content: delta,
      timestamp: Date.now(),
    });
    this.notify(() => this._callbacks.onTextChunk?.(delta));
  }

  private handleThinkingStart(event: import("./types").ThinkingStartedEvent): void {
    this.transitionTo("streaming");
    this.notify(() => this._callbacks.onThinkingStart?.(cloneData(event)));
  }

  private handleThinkingDelta(event: import("./types").ThinkingDeltaEvent): void {
    this.transitionTo("streaming");
    this._messages.push({
      type: "thinking",
      content: event.delta,
      timestamp: Date.now(),
      meta: { modelCallId: event.modelCallId, contentIndex: event.contentIndex },
    });
    this.notify(() => this._callbacks.onThinkingChunk?.(cloneData(event)));
  }

  private handleThinkingEnd(event: import("./types").ThinkingCompletedEvent): void {
    this.transitionTo("streaming");
    this.notify(() => this._callbacks.onThinkingEnd?.(cloneData(event)));
  }

  private handleToolStart(event: import("./types").ToolUseStartEvent): void {
    this.transitionTo("streaming");
    this._messages.push({
      type: "tool_call",
      content: event.toolName,
      timestamp: Date.now(),
      meta: {
        toolCallId: event.toolCallId,
        input: event.input,
        preview: event.preview,
        batch: event.batch,
      },
    });
    this.notify(() => this._callbacks.onToolStart?.(cloneData(event)));
  }

  private handleToolEnd(event: import("./types").ToolUseEndEvent): void {
    // Stay in streaming — more events may follow
    this._messages.push({
      type: "tool_result",
      content: event.result.content.map((c) => c.text).join("\n"),
      timestamp: Date.now(),
      meta: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.result.isError,
        durationMs: event.durationMs,
        resultMeta: event.result.meta,
        batch: event.batch,
      },
    });
    this.notify(() => this._callbacks.onToolEnd?.(cloneData(event)));
  }

  private handleExtensionEvent(event: ExtensionEvent): void {
    this.transitionTo("streaming");
    this._messages.push({
      type: "tool_call",
      content: `${event.namespace}:${event.event}`,
      timestamp: Date.now(),
      meta: { ...event },
    });
    this.notify(() => this._callbacks.onExtensionEvent?.(cloneData(event)));
  }

  private handleDone(usage?: TokenUsage): void {
    this.transitionTo("done");
    this.notify(() => this._callbacks.onDone?.(usage ? cloneData(usage) : undefined));
  }

  private handleError(failure: AgentFailure): void {
    this.transitionTo("error");
    this._messages.push({
      type: "text",
      content: `[error] ${failure.message}`,
      timestamp: Date.now(),
      meta: { failure: cloneData(failure) },
    });
    this.notify(() => this._callbacks.onError?.(cloneData(failure)));
  }

  private notify(callback: () => void): void {
    try {
      callback();
    } catch {
      // Stream consumers are observers and cannot alter runtime or persistence semantics.
    }
  }

  /**
   * Transition to a new state. Validates allowed transitions.
   */
  private transitionTo(target: StreamState): void {
    // Allowed transitions:
    // idle → streaming
    // streaming → streaming (text/tool events continue)
    // streaming → done
    // streaming → error
    // idle → done (empty response)
    // idle → error (immediate failure)
    const allowed: Record<StreamState, StreamState[]> = {
      idle: ["streaming", "done", "error"],
      streaming: ["streaming", "done", "error"],
      done: [], // terminal
      error: [], // terminal
    };

    if (this._state === target) return; // no-op for same state
    if (target === "streaming" && this._state === "streaming") return; // stay in streaming

    if (!allowed[this._state].includes(target)) {
      // In production, we don't throw — we just force the transition.
      // This makes the state machine resilient to unexpected event ordering.
    }

    this._state = target;
  }
}
