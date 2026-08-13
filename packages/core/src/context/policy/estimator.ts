import type { DeepReadonly } from "../../data";
import type { ContextEntry, ContextFrame, ContextTokenEstimate } from "../contracts/types";
import type { ContextTokenEstimatorPort } from "../contracts/ports";

const APPROX_CHARS_PER_TOKEN = 4;

export class ApproximateContextTokenEstimator implements ContextTokenEstimatorPort {
  estimate(frame: DeepReadonly<ContextFrame>): ContextTokenEstimate {
    const systemPromptCharacters = frame.systemPrompt.length;
    const messageCharacters = frame.entries.reduce((total, entry) => total + entryLength(entry), 0);
    const toolCharacters = JSON.stringify(
      frame.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.schema,
      })),
    ).length;
    const systemPromptTokens = tokens(systemPromptCharacters);
    const messageTokens = tokens(messageCharacters);
    const toolTokens = tokens(toolCharacters);
    const totalInputTokens = tokens(systemPromptCharacters + messageCharacters + toolCharacters);
    const usableInputBudget = Math.max(1, frame.model.contextWindow - frame.model.maxOutputTokens);
    return {
      systemPromptTokens,
      messageTokens,
      toolTokens,
      totalInputTokens,
      usableInputBudget,
      usageRatio: totalInputTokens / usableInputBudget,
    };
  }

  estimateEntry(entry: DeepReadonly<ContextEntry>): number {
    return tokens(entryLength(entry));
  }
}

function tokens(characters: number): number {
  return Math.ceil(characters / APPROX_CHARS_PER_TOKEN);
}

function entryLength(entry: DeepReadonly<ContextEntry>): number {
  if (entry.kind === "checkpoint") return entry.summary.length + 160;
  if (entry.kind === "toolResultArtifact") {
    return entry.message.toolName.length + entry.artifact.path.length + 220;
  }
  const content = entry.message.content;
  if (typeof content === "string") return content.length;
  return content.reduce((total, block) => {
    if (block.type === "text") return total + block.text.length;
    if (block.type === "thinking") return total + block.thinking.length;
    if (block.type === "toolCall") {
      return total + block.name.length + JSON.stringify(block.arguments).length;
    }
    return total + 256;
  }, 0);
}
