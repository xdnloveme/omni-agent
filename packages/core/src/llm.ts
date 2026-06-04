import {
  streamSimple,
  type Api,
  type AssistantMessageEvent,
  type Message,
  type Model,
  type Tool,
  type TSchema,
} from "@mariozechner/pi-ai";

import type { AgentConfig, AgentTool } from "./types.js";

/**
 * Resolve the pi-ai Api protocol based on the configured provider.
 */
function resolveApi(provider: AgentConfig["provider"]): Api {
  switch (provider) {
    case "anthropic":
      return "anthropic-messages" as Api;
    case "kimi":
    case "custom":
      return "openai-completions" as Api;
    default:
      return "anthropic-messages" as Api;
  }
}

/**
 * Build a pi-ai Model object from config, selecting the correct API protocol.
 */
export function buildModel(config: AgentConfig): Model<Api> {
  const api = resolveApi(config.provider);
  const defaultBaseUrl =
    config.provider === "anthropic" || !config.provider
      ? "https://api.anthropic.com"
      : undefined;

  return {
    id: config.model,
    name: config.model,
    api,
    provider: config.provider ?? "anthropic",
    baseUrl: config.endpoint ?? defaultBaseUrl ?? "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  };
}

/**
 * Convert AgentTool[] to pi-ai Tool[] for the LLM call.
 */
export function toolsToLlmTools(tools: AgentTool[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.schema as unknown as TSchema,
  }));
}

/**
 * Stream an LLM response. Returns an async iterable of AssistantMessageEvent.
 */
export function streamLLM(
  config: AgentConfig,
  messages: Message[],
  signal?: AbortSignal,
): AsyncIterable<AssistantMessageEvent> {
  const model = buildModel(config);
  const tools = toolsToLlmTools(config.tools);

  return streamSimple(
    model,
    {
      systemPrompt: config.systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    },
    {
      signal,
      apiKey: config.apiKey,
      maxTokens: 16384,
    },
  );
}
