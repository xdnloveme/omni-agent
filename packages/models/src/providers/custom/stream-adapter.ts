import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import {
  fromBackendContextMessages,
  toBackendAssistantMessage,
} from "../../runtime/message-mapper";
import type { ModelTransport, ModelTransportModel } from "./types";

function initialMessage(model: ModelTransportModel): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "omni-custom",
    provider: model.providerId,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function successfulReason(message: AssistantMessage): "stop" | "length" | "toolUse" | "deferred" {
  return ["length", "toolUse", "deferred"].includes(message.stopReason)
    ? (message.stopReason as "length" | "toolUse" | "deferred")
    : "stop";
}

export function createTransportStreams(transport: ModelTransport): ProviderStreams {
  const run: ProviderStreams["stream"] = (model, context, options = {}) => {
    const output = createAssistantMessageEventStream();
    const transportModel: ModelTransportModel = {
      id: model.id,
      providerId: model.provider,
      baseUrl: model.baseUrl,
      contextWindow: model.contextWindow,
      requestedOutputTokens: Math.min(model.maxTokens, options.maxTokens ?? model.maxTokens),
    };
    let partial = initialMessage(transportModel);
    output.push({ type: "start", partial });
    void (async () => {
      let text = "";
      let textStarted = false;
      try {
        if (options.cacheRetention === undefined) {
          throw new Error("Custom model transport requires resolved cache retention");
        }
        const events = transport.stream(
          transportModel,
          {
            systemPrompt: context.systemPrompt,
            messages: fromBackendContextMessages(context.messages),
            tools: (context.tools ?? []).map((tool) => ({
              name: tool.name,
              description: tool.description,
              schema: { ...tool.parameters },
            })),
          },
          {
            signal: options.signal,
            apiKey: options.apiKey,
            headers: options.headers,
            sessionId: options.sessionId,
            cacheRetention: options.cacheRetention,
          },
        );
        for await (const event of events) {
          if (event.type === "text_delta") {
            if (!textStarted) {
              textStarted = true;
              partial = { ...partial, content: [{ type: "text", text: "" }] };
              output.push({ type: "text_start", contentIndex: 0, partial });
            }
            text += event.delta;
            partial = { ...partial, content: [{ type: "text", text }] };
            output.push({ type: "text_delta", contentIndex: 0, delta: event.delta, partial });
            continue;
          }
          const finalMessage = toBackendAssistantMessage(
            event.type === "done" ? event.message : event.error,
          );
          if (textStarted)
            output.push({ type: "text_end", contentIndex: 0, content: text, partial });
          if (event.type === "done") {
            output.push({
              type: "done",
              reason: successfulReason(finalMessage),
              message: finalMessage,
            });
          } else {
            output.push({
              type: "error",
              reason: finalMessage.stopReason === "aborted" ? "aborted" : "error",
              error: finalMessage,
            });
          }
          return;
        }
        throw new Error("Model transport ended without a terminal event");
      } catch (error) {
        const reason = options.signal?.aborted ? "aborted" : "error";
        output.push({
          type: "error",
          reason,
          error: {
            ...partial,
            stopReason: reason,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
      }
    })();
    return output;
  };
  return { stream: run, streamSimple: run };
}
