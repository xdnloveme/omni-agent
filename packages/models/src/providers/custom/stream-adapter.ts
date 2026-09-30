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
      let textContentIndex: number | undefined;
      const thinking = new Map<number, string>();
      const thinkingStarted = new Set<number>();
      const replaceContent = (
        contentIndex: number,
        content: AssistantMessage["content"][number],
      ) => {
        const contents = [...partial.content];
        contents[contentIndex] = content;
        partial = { ...partial, content: contents };
      };
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
              inputConstraint:
                tool.constrainedSampling && tool.constrainedSampling.type === "json_schema"
                  ? "require"
                  : "off",
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
              textContentIndex = partial.content.length;
              replaceContent(textContentIndex, { type: "text", text: "" });
              output.push({ type: "text_start", contentIndex: textContentIndex, partial });
            }
            text += event.delta;
            replaceContent(textContentIndex!, { type: "text", text });
            output.push({
              type: "text_delta",
              contentIndex: textContentIndex!,
              delta: event.delta,
              partial,
            });
            continue;
          }
          if (event.type === "thinking_start") {
            thinkingStarted.add(event.contentIndex);
            thinking.set(event.contentIndex, "");
            replaceContent(event.contentIndex, { type: "thinking", thinking: "" });
            output.push({ type: "thinking_start", contentIndex: event.contentIndex, partial });
            continue;
          }
          if (event.type === "thinking_delta") {
            if (!thinkingStarted.has(event.contentIndex)) {
              thinkingStarted.add(event.contentIndex);
              thinking.set(event.contentIndex, "");
              replaceContent(event.contentIndex, { type: "thinking", thinking: "" });
              output.push({ type: "thinking_start", contentIndex: event.contentIndex, partial });
            }
            const content = `${thinking.get(event.contentIndex) ?? ""}${event.delta}`;
            thinking.set(event.contentIndex, content);
            replaceContent(event.contentIndex, { type: "thinking", thinking: content });
            output.push({
              type: "thinking_delta",
              contentIndex: event.contentIndex,
              delta: event.delta,
              partial,
            });
            continue;
          }
          if (event.type === "thinking_end") {
            if (!thinkingStarted.has(event.contentIndex)) {
              replaceContent(event.contentIndex, { type: "thinking", thinking: "" });
              output.push({ type: "thinking_start", contentIndex: event.contentIndex, partial });
            }
            thinkingStarted.delete(event.contentIndex);
            thinking.set(event.contentIndex, event.content);
            replaceContent(event.contentIndex, {
              type: "thinking",
              thinking: event.content,
            });
            output.push({
              type: "thinking_end",
              contentIndex: event.contentIndex,
              content: event.content,
              partial,
            });
            continue;
          }
          const finalMessage = toBackendAssistantMessage(
            event.type === "done" ? event.message : event.error,
          );
          if (textStarted)
            output.push({
              type: "text_end",
              contentIndex: textContentIndex!,
              content: text,
              partial,
            });
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
