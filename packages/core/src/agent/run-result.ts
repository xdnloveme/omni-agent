import type { TranscriptMessage } from "../messages";
import type { TokenUsage } from "../types";

export interface AgentRunResult {
  messages: TranscriptMessage[];
  usage?: TokenUsage;
}
