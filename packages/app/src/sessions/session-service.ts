import { SessionManager, createUserMessage, type AgentMessage } from "@omni-agent/core";

export class SessionService {
  constructor(readonly manager = new SessionManager()) {}

  restoreLatest(): string {
    return this.manager.restoreLatest();
  }

  create(): string {
    return this.manager.create();
  }

  clear(): void {
    this.manager.clear();
  }

  appendUserInput(input: string): AgentMessage {
    const message = createUserMessage(input);
    this.manager.append(message);
    return message;
  }

  appendProduced(messages: AgentMessage[]): void {
    this.manager.appendBatch(messages);
  }

  get messages(): readonly AgentMessage[] {
    return this.manager.messages;
  }

  get currentId(): string | null {
    return this.manager.currentId;
  }
}
