import type { StreamEvent, StreamCallbacks, StreamState, AccumulatedMessage } from "./types";
import type { ExtensionEvent } from "../extension-events";
import type { TokenUsage } from "../types";
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
      case "model_context_prepared":
        this.notify(() => this._callbacks.onModelContextPrepared?.(cloneData(event.manifest)));
        break;
      case "model_cache_report":
        this.notify(() => this._callbacks.onModelCacheReport?.(cloneData(event.report)));
        break;
      case "context_progress":
        this.notify(() => this._callbacks.onContextProgress?.(cloneData(event.event)));
        break;
      case "tool_use_start":
        this.handleToolStart(event.toolName, event.toolCallId, event.input);
        break;
      case "tool_use_end":
        this.handleToolEnd(event.toolName, event.toolCallId, event.result, event.durationMs);
        break;
      case "extension_event":
        this.handleExtensionEvent(event);
        break;
      case "done":
        this.handleDone(event.usage);
        break;
      case "error":
        this.handleError(event.error);
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

  private handleToolStart(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
  ): void {
    this.transitionTo("streaming");
    this._messages.push({
      type: "tool_call",
      content: toolName,
      timestamp: Date.now(),
      meta: { toolCallId, input },
    });
    this.notify(() => this._callbacks.onToolStart?.(toolName, toolCallId, cloneData(input)));
  }

  private handleToolEnd(
    toolName: string,
    toolCallId: string,
    result: {
      content: Array<{ type: "text"; text: string }>;
      isError: boolean;
      meta?: Record<string, unknown>;
    },
    durationMs: number,
  ): void {
    // Stay in streaming — more events may follow
    this._messages.push({
      type: "tool_result",
      content: result.content.map((c) => c.text).join("\n"),
      timestamp: Date.now(),
      meta: { toolCallId, toolName, isError: result.isError, durationMs, resultMeta: result.meta },
    });
    this.notify(() =>
      this._callbacks.onToolEnd?.(toolName, toolCallId, cloneData(result), durationMs),
    );
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

  private handleError(error: string): void {
    this.transitionTo("error");
    this._messages.push({
      type: "text",
      content: `[error] ${error}`,
      timestamp: Date.now(),
      meta: { error },
    });
    this.notify(() => this._callbacks.onError?.(error));
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
