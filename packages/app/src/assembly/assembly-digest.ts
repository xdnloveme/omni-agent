import { digestStableValue, sanitizeSensitiveValue } from "@omni-agent/core";
import type { AgentAssemblyFacts, AgentAssemblySnapshot } from "./contracts";
import { deepFreeze } from "./deep-freeze";

export function createAgentAssemblySnapshot(facts: AgentAssemblyFacts): AgentAssemblySnapshot {
  const projected = normalizeFacts(facts);
  const sanitized = sanitizeSensitiveValue(projected, {
    maxStringLength: Number.POSITIVE_INFINITY,
    maxDepth: 16,
    maxFields: 10_000,
  }) as AgentAssemblyFacts;
  const normalized = normalizeFacts(sanitized);
  return deepFreeze({
    ...normalized,
    digest: `sha256:${digestStableValue(normalized)}`,
  });
}

function normalizeFacts(facts: AgentAssemblyFacts): AgentAssemblyFacts {
  return {
    agentId: facts.agentId,
    packageName: facts.packageName,
    packageVersion: facts.packageVersion,
    manifestApiVersion: facts.manifestApiVersion,
    blueprintApiVersion: facts.blueprintApiVersion,
    workspaceId: facts.workspaceId,
    model: {
      vendorId: facts.model.vendorId,
      connectionId: facts.model.connectionId,
      modelId: facts.model.modelId,
    },
    extensions: facts.extensions.map((extension) => ({
      id: extension.id,
      version: extension.version,
      sourceOriginId: extension.sourceOriginId,
      requirement: extension.requirement,
    })),
    composition: {
      promptProfileId: facts.composition.promptProfileId,
      promptContributorIds: [...facts.composition.promptContributorIds],
      toolComponentIds: [...facts.composition.toolComponentIds],
      capabilityIds: [...facts.composition.capabilityIds],
    },
    toolNames: [...facts.toolNames],
    systemPromptDigest: facts.systemPromptDigest,
  };
}
