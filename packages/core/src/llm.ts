import {
  streamSimple,
  type Api,
  type AssistantMessageEvent,
  type Message,
  type Model,
  type Tool,
  type TSchema,
} from "@mariozechner/pi-ai";

import type { AgentConfig, AgentTool } from "./types";
import { toContextMessages } from "./llm-context";

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
 * Default maxTokens per provider when not explicitly configured.
 */
function getDefaultMaxTokens(provider: AgentConfig["provider"]): number {
  switch (provider) {
    case "anthropic":
      return 16384;
    case "kimi":
      return 8192;
    case "custom":
      return 4096;
    default:
      return 16384;
  }
}

/**
 * Default contextWindow per provider when not explicitly configured.
 */
export function getDefaultContextWindow(provider: AgentConfig["provider"]): number {
  switch (provider) {
    case "anthropic":
      return 200000;
    case "kimi":
      return 128000;
    case "custom":
      return 128000;
    default:
      return 200000;
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

  const maxTokens = config.maxTokens ?? getDefaultMaxTokens(config.provider);
  const contextWindow = config.contextWindow ?? getDefaultContextWindow(config.provider);

  return {
    id: config.model,
    name: config.model,
    api,
    provider: config.provider ?? "anthropic",
    baseUrl: config.endpoint ?? defaultBaseUrl ?? "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
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

  const maxTokens = config.maxTokens ?? getDefaultMaxTokens(config.provider);

  const contextMessages = toContextMessages(messages);

  return streamSimple(
    model,
    {
      systemPrompt: config.systemPrompt,
      messages: contextMessages,
      tools: tools.length > 0 ? tools : undefined,
    },
    {
      signal,
      apiKey: config.apiKey,
      maxTokens,
    },
  );
}
