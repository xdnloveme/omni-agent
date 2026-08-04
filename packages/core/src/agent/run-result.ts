import type { Message, TokenUsage } from "../types";

export interface AgentRunResult {
  messages: Message[];
  usage?: TokenUsage;
}
