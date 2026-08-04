import type { AgentContribution } from "../extensions/types";

export class AgentRegistry {
  private readonly agents = new Map<string, AgentContribution>();

  register(contribution: AgentContribution): void {
    const id = contribution.definition.id;
    if (this.agents.has(id)) throw new Error(`Agent already registered: ${id}`);
    this.agents.set(id, contribution);
  }

  unregister(id: string): void {
    this.agents.delete(id);
  }

  get(id: string): AgentContribution | undefined {
    return this.agents.get(id);
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  list(): AgentContribution[] {
    return [...this.agents.values()];
  }
}
