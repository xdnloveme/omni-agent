export interface RuntimePromptSection {
  id: string;
  owner: "loop_protection" | "project_instructions";
  priority: number;
  lifetime: "run" | "next_model_request";
  content: string;
}

export interface RuntimePromptLease {
  id?: string;
  systemPrompt: string;
}

interface PendingLease {
  sectionIds: string[];
}

export class RuntimePromptComposer {
  private readonly pending = new Map<string, RuntimePromptSection>();
  private readonly leases = new Map<string, PendingLease>();
  private nextLeaseId = 1;

  enqueue(section: RuntimePromptSection): void {
    this.pending.set(section.id, section);
  }

  lease(basePrompt: string, stableSections: readonly RuntimePromptSection[]): RuntimePromptLease {
    const dynamicSections = [...this.pending.values()];
    const sections = deduplicateAndSort([...stableSections, ...dynamicSections]);
    const systemPrompt = composePrompt(basePrompt, sections);
    if (dynamicSections.length === 0) return { systemPrompt };

    const id = `runtime-prompt-${this.nextLeaseId++}`;
    this.leases.set(id, { sectionIds: dynamicSections.map((section) => section.id) });
    return { id, systemPrompt };
  }

  markDispatched(leaseId: string | undefined): void {
    if (!leaseId) return;
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    for (const sectionId of lease.sectionIds) {
      if (this.pending.get(sectionId)?.lifetime === "next_model_request") {
        this.pending.delete(sectionId);
      }
    }
    this.leases.delete(leaseId);
  }
}

function deduplicateAndSort(sections: RuntimePromptSection[]): RuntimePromptSection[] {
  const byId = new Map<string, RuntimePromptSection>();
  for (const section of sections) byId.set(section.id, section);
  return [...byId.values()].sort(
    (left, right) =>
      lifetimeRank(left.lifetime) - lifetimeRank(right.lifetime) ||
      right.priority - left.priority ||
      left.owner.localeCompare(right.owner) ||
      left.id.localeCompare(right.id),
  );
}

function lifetimeRank(lifetime: RuntimePromptSection["lifetime"]): number {
  return lifetime === "run" ? 0 : 1;
}

function composePrompt(basePrompt: string, sections: readonly RuntimePromptSection[]): string {
  if (sections.length === 0) return basePrompt;
  return [basePrompt.trimEnd(), ...sections.map((section) => section.content.trim())].join("\n\n");
}
