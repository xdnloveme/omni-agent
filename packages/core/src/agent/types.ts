import type { ProviderId } from "../models";

export interface AgentModelSettings {
  model?: string;
  provider?: ProviderId;
  endpoint?: string;
  maxTokens?: number;
  contextWindow?: number;
}

export interface AgentDefinition<TContext = unknown> {
  id: string;
  description: string;
  instructions: string | ((context: TContext) => string | Promise<string>);
  model?: AgentModelSettings;
  maxTurns?: number;
}

export function defineAgent<TContext = unknown>(
  definition: AgentDefinition<TContext>,
): AgentDefinition<TContext> {
  return definition;
}
