import type { DeepReadonly } from "../../data";
import type { ContextEnvelope, ContextEntry, ContextTokenEstimate } from "../contracts/types";
import type { ContextTokenEstimatorPort } from "../contracts/ports";
import { serializeContextValue } from "../digest";
import { estimateContextTextTokens } from "../../tokenEstimate";
import { renderEnvironmentContext } from "../../environment";

import { renderRunDeadline } from "../run-deadline";
import { inputBudget } from "../request-budget";

const MESSAGE_OVERHEAD_TOKENS = 4;
const CONTENT_BLOCK_OVERHEAD_TOKENS = 2;
const TOOL_OVERHEAD_TOKENS = 8;
const CHECKPOINT_OVERHEAD_TOKENS = 40;
const ARTIFACT_OVERHEAD_TOKENS = 48;

export class ApproximateContextTokenEstimator implements ContextTokenEstimatorPort {
  estimate(envelope: DeepReadonly<ContextEnvelope>): ContextTokenEstimate {
    const { fixed, history } = envelope;
    const systemPromptTokens = estimateContextTextTokens(fixed.systemPrompt);
    const environmentTokens = fixed.environment
      ? MESSAGE_OVERHEAD_TOKENS +
        estimateContextTextTokens(renderEnvironmentContext(fixed.environment))
      : 0;
    const messageTokens =
      environmentTokens +
      (fixed.runDeadline
        ? MESSAGE_OVERHEAD_TOKENS + estimateContextTextTokens(renderRunDeadline(fixed.runDeadline))
        : 0) +
      history.entries.reduce((total, entry) => total + this.estimateEntry(entry), 0);
    const toolTokens = fixed.tools.reduce(
      (total, tool) =>
        total +
        TOOL_OVERHEAD_TOKENS +
        estimateContextTextTokens(tool.name) +
        estimateContextTextTokens(tool.description) +
        estimateContextTextTokens(serializeContextValue(tool.schema)) +
        (tool.inputConstraint === undefined ? 0 : 1),
      0,
    );
    const totalInputTokens = systemPromptTokens + messageTokens + toolTokens;
    // Keep compression admission independent of the shrinking per-request output budget.
    const usableInputBudget = inputBudget(fixed.model.contextWindow);
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
    if (entry.kind === "checkpoint") {
      return CHECKPOINT_OVERHEAD_TOKENS + estimateContextTextTokens(entry.summary);
    }
    if (entry.kind === "toolResultArtifact") {
      return (
        ARTIFACT_OVERHEAD_TOKENS +
        estimateContextTextTokens(entry.message.toolCallId) +
        estimateContextTextTokens(entry.message.toolName) +
        estimateContextTextTokens(entry.artifact.id) +
        estimateContextTextTokens(entry.artifact.path) +
        estimateContextTextTokens(entry.artifact.contentDigest) +
        estimateContextTextTokens(String(entry.artifact.originalLength)) +
        estimateContextTextTokens(entry.artifact.recoveryInstruction)
      );
    }
    const message = entry.message;
    let total = MESSAGE_OVERHEAD_TOKENS;
    if (message.role === "assistant") {
      total += estimateContextTextTokens(message.api);
      total += estimateContextTextTokens(message.provider);
      total += estimateContextTextTokens(message.model);
      total += estimateContextTextTokens(message.stopReason);
      if (message.responseModel) total += estimateContextTextTokens(message.responseModel);
      if (message.rawStopReason) total += estimateContextTextTokens(message.rawStopReason);
      if (message.deferred) {
        total += estimateContextTextTokens(serializeContextValue(message.deferred));
      }
    } else if (message.role === "toolResult") {
      total += estimateContextTextTokens(message.toolCallId);
      total += estimateContextTextTokens(message.toolName);
      if (message.structuredContent !== undefined) {
        total += estimateContextTextTokens(serializeContextValue(message.structuredContent));
      }
      total +=
        message.addedToolNames?.reduce((sum, name) => sum + estimateContextTextTokens(name), 0) ??
        0;
    }
    const content = message.content;
    if (typeof content === "string") return total + estimateContextTextTokens(content);
    for (const block of content) {
      total += CONTENT_BLOCK_OVERHEAD_TOKENS;
      if (block.type === "text") {
        total += estimateContextTextTokens(block.text);
        if ("textSignature" in block && block.textSignature)
          total += estimateContextTextTokens(block.textSignature);
      } else if (block.type === "thinking") {
        total += estimateContextTextTokens(block.thinking);
        if (block.thinkingSignature) {
          total += estimateContextTextTokens(block.thinkingSignature);
        }
      } else if (block.type === "toolCall") {
        total += estimateContextTextTokens(block.id);
        total += estimateContextTextTokens(block.name);
        total += estimateContextTextTokens(serializeContextValue(block.arguments));
        if (block.thoughtSignature) total += estimateContextTextTokens(block.thoughtSignature);
      } else if (block.type === "resource") {
        total += 256 + estimateContextTextTokens(block.resource.uri);
        if ("text" in block.resource) total += estimateContextTextTokens(block.resource.text);
        if (block.resource.mimeType) total += estimateContextTextTokens(block.resource.mimeType);
      } else if (block.type === "resource_link") {
        total += 256 + estimateContextTextTokens(block.uri) + estimateContextTextTokens(block.name);
        if (block.description) total += estimateContextTextTokens(block.description);
        if (block.mimeType) total += estimateContextTextTokens(block.mimeType);
      } else {
        total += 256;
      }
    }
    return total;
  }
}
