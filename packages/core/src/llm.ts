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
import { getDefaultPresetForProvider } from "./models";

/**
 * Default maxTokens per provider when not explicitly configured.
 */
function getDefaultMaxTokens(provider: AgentConfig["provider"]): number {
  return getDefaultPresetForProvider(provider).maxTokens;
}

/**
 * Default contextWindow per provider when not explicitly configured.
 */
export function getDefaultContextWindow(provider: AgentConfig["provider"]): number {
  return getDefaultPresetForProvider(provider).contextWindow;
}

/**
 * Build a pi-ai Model object from config, selecting the correct API protocol.
 */
export function buildModel(config: AgentConfig): Model<Api> {
  const preset = getDefaultPresetForProvider(config.provider);

  const maxTokens = config.maxTokens ?? preset.maxTokens;
  const contextWindow = config.contextWindow ?? preset.contextWindow;

  return {
    id: config.model,
    name: config.model,
    api: preset.api,
    provider: config.provider ?? preset.provider,
    baseUrl: config.endpoint ?? preset.endpoint,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    headers: preset.headers?.(),
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
