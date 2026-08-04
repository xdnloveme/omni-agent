import {
  AgentRunner,
  createStreamSession,
  type AgentConfig,
  type AgentEvent,
  type Message,
  type StreamCallbacks,
} from "@omni-agent/core";
import { ExtensionManager } from "../extensions/extension-manager";
import { SessionService } from "../sessions/session-service";

export class AgentApplication {
  readonly runner = new AgentRunner();

  constructor(
    readonly extensions: ExtensionManager,
    readonly sessions: SessionService,
    readonly agentConfig: AgentConfig,
    readonly agentId: string,
    readonly cwd: string,
  ) {}

  async run(input: string, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
    this.sessions.appendUserInput(input);
    const streamSession = createStreamSession(callbacks);
    const events = this.runner.run(
      this.agentConfig,
      [...this.sessions.messages] as Message[],
      signal,
      { session: streamSession },
    );
    for await (const event of events) {
      this.persistProduced(event);
    }
  }

  newSession(): string {
    return this.sessions.create();
  }

  clearSession(): void {
    this.sessions.clear();
  }

  async refreshInstructions(): Promise<void> {
    const contribution = this.extensions.agents.get(this.agentId);
    if (!contribution) throw new Error(`Agent not found: ${this.agentId}`);
    const instructions = contribution.definition.instructions;
    this.agentConfig.systemPrompt = typeof instructions === "function"
      ? await instructions({ cwd: this.cwd })
      : instructions;
  }

  async dispose(): Promise<void> {
    await this.extensions.dispose();
  }

  private persistProduced(event: AgentEvent): void {
    if (event.type === "done" && event.produced) {
      this.sessions.appendProduced(event.produced);
    }
  }
}
