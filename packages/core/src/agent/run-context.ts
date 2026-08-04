export interface AgentRunContext<T = unknown> {
  cwd: string;
  sessionId?: string;
  data: T;
}
