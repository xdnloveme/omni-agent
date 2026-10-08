import { digestStableValue } from "@omni-agent/core";
import type { ModelSelection } from "../models/model-service";
import { createAgentAssemblySnapshot } from "./assembly-digest";
import type { AgentAssemblyFacts, AgentAssemblySnapshot } from "./contracts";

/** Owns the current effective assembly evidence for an Agent instance. */
export class AgentAssemblyEvidence {
  private current: AgentAssemblySnapshot;

  constructor(facts: AgentAssemblyFacts) {
    this.current = createAgentAssemblySnapshot(facts);
  }

  snapshot(): AgentAssemblySnapshot {
    return this.current;
  }

  updateModel(selection: ModelSelection): void {
    this.replace({
      ...this.facts(),
      model: {
        vendorId: selection.vendorId,
        connectionId: selection.connectionId,
        modelId: selection.modelId,
      },
    });
  }

  updateSystemPrompt(systemPrompt: string): void {
    this.replace({
      ...this.facts(),
      systemPromptDigest: digestStableValue(systemPrompt),
    });
  }

  updateTools(toolNames: readonly string[]): void {
    this.replace({ ...this.facts(), toolNames: [...toolNames] });
  }

  private replace(facts: AgentAssemblyFacts): void {
    this.current = createAgentAssemblySnapshot(facts);
  }

  private facts(): AgentAssemblyFacts {
    const { digest: _digest, ...facts } = this.current;
    return facts;
  }
}
