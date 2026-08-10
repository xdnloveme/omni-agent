export interface AgentDefinition<TContext = unknown> {
  id: string;
  description: string;
  instructions: string | ((context: TContext) => string | Promise<string>);
  maxTurns?: number;
}

export function defineAgent<TContext = unknown>(
  definition: AgentDefinition<TContext>,
): AgentDefinition<TContext> {
  return definition;
}
