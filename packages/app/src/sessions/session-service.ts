import { SessionManager, createUserMessage, type Message } from "@omni-agent/core";

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

  appendUserInput(input: string): Message {
    const message = createUserMessage(input);
    this.manager.append(message);
    return message;
  }

  appendProduced(messages: Message[]): void {
    this.manager.appendBatch(messages);
  }

  get messages(): readonly Message[] {
    return this.manager.messages;
  }

  get currentId(): string | null {
    return this.manager.currentId;
  }
}
