import type { AgentMessage } from "../models/messages";
import type { TokenUsage } from "../types";

export interface AgentRunResult {
  messages: AgentMessage[];
  usage?: TokenUsage;
}
