export interface AgentFactoryContext {
  readonly cwd: string;
}

export interface AgentFactory<TResult> {
  create(context: AgentFactoryContext): TResult | Promise<TResult>;
}
