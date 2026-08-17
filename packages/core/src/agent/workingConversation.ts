import { cloneTranscriptMessage, cloneTranscriptMessages } from "../messages";
import { cloneData } from "../dataCopy";
import type { EnvironmentContextRecord } from "../environment";
import type { TranscriptMessage } from "../messages";
import type { SessionRecord, SessionSnapshot } from "../session/types";

export interface WorkingConversationSnapshot {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly messages: readonly TranscriptMessage[];
  readonly environment?: EnvironmentContextRecord;
}

export class WorkingConversation {
  private readonly messages: TranscriptMessage[];
  private environment: EnvironmentContextRecord | undefined;
  private readonly producedRecords: SessionRecord[] = [];

  private constructor(
    private readonly sessionId: string,
    private readonly sessionRevision: number,
    messages: readonly TranscriptMessage[],
    environment?: EnvironmentContextRecord,
  ) {
    this.messages = cloneTranscriptMessages(messages);
    this.environment = environment
      ? (cloneData(environment) as EnvironmentContextRecord)
      : undefined;
  }

  static from(snapshot: SessionSnapshot): WorkingConversation {
    return new WorkingConversation(
      snapshot.sessionId,
      snapshot.revision,
      snapshot.messages,
      snapshot.environment,
    );
  }

  append(message: TranscriptMessage): void {
    const owned = cloneTranscriptMessage(message);
    this.messages.push(owned);
    this.producedRecords.push({ kind: "message", message: cloneTranscriptMessage(owned) });
  }

  updateEnvironment(context: EnvironmentContextRecord): void {
    const owned = cloneData(context) as EnvironmentContextRecord;
    this.environment = owned;
    this.producedRecords.push({
      kind: "environment",
      context: cloneData(owned) as EnvironmentContextRecord,
    });
  }

  snapshot(): WorkingConversationSnapshot {
    return {
      sessionId: this.sessionId,
      sessionRevision: this.sessionRevision,
      messages: cloneTranscriptMessages(this.messages),
      ...(this.environment
        ? { environment: cloneData(this.environment) as EnvironmentContextRecord }
        : {}),
    };
  }

  produced(): readonly SessionRecord[] {
    return this.producedRecords.map((record) =>
      record.kind === "message"
        ? { kind: "message", message: cloneTranscriptMessage(record.message) }
        : {
            kind: "environment",
            context: cloneData(record.context) as EnvironmentContextRecord,
          },
    );
  }
}
