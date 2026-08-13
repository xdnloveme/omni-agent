import { cloneTranscriptMessage, cloneTranscriptMessages } from "../messages";
import type { TranscriptMessage } from "../messages";
import type { SessionTranscriptSnapshot } from "../session/types";

export interface WorkingConversationSnapshot {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly messages: readonly TranscriptMessage[];
}

export class WorkingConversation {
  private readonly messages: TranscriptMessage[];
  private readonly producedMessages: TranscriptMessage[] = [];

  private constructor(
    private readonly sessionId: string,
    private readonly sessionRevision: number,
    messages: readonly TranscriptMessage[],
  ) {
    this.messages = cloneTranscriptMessages(messages);
  }

  static from(snapshot: SessionTranscriptSnapshot): WorkingConversation {
    return new WorkingConversation(snapshot.sessionId, snapshot.revision, snapshot.messages);
  }

  append(message: TranscriptMessage): void {
    const owned = cloneTranscriptMessage(message);
    this.messages.push(owned);
    this.producedMessages.push(cloneTranscriptMessage(owned));
  }

  snapshot(): WorkingConversationSnapshot {
    return {
      sessionId: this.sessionId,
      sessionRevision: this.sessionRevision,
      messages: cloneTranscriptMessages(this.messages),
    };
  }

  produced(): readonly TranscriptMessage[] {
    return cloneTranscriptMessages(this.producedMessages);
  }
}
