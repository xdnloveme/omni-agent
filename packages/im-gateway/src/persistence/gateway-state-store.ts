import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { InterprocessFileLock } from "@omni-agent/core";
import type { ConversationRecord, InboundMessage, TaskRecord, TaskState } from "../contracts";
import { conversationStorageKey } from "../routing/conversation-key";

interface PersistedEvent {
  readonly requestId: string;
  readonly messageId: string;
  readonly eventId?: string;
  readonly acceptedAt: string;
}

interface PersistedGatewayState {
  readonly version: 1;
  readonly events: Readonly<Record<string, PersistedEvent>>;
  readonly conversations: Readonly<Record<string, ConversationRecord>>;
  readonly tasks: Readonly<Record<string, TaskRecord>>;
}

export interface AcceptedTask {
  readonly duplicate: boolean;
  readonly task: TaskRecord;
}

const EMPTY_STATE: PersistedGatewayState = {
  version: 1,
  events: {},
  conversations: {},
  tasks: {},
};

export class GatewayStateStore {
  readonly #lock: InterprocessFileLock;
  #writes: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly eventRetentionMs = 7 * 24 * 60 * 60 * 1_000,
  ) {
    this.#lock = new InterprocessFileLock(`${path}.lock`);
  }

  accept(message: InboundMessage): Promise<AcceptedTask> {
    return this.#update<AcceptedTask>((persisted) => {
      const current = this.#pruneState(persisted);
      const existingEvent = this.#eventKeys(message)
        .map((key) => current.events[key])
        .find((event) => event !== undefined);
      if (existingEvent) {
        const existingTask = current.tasks[existingEvent.requestId];
        if (!existingTask) {
          throw new Error(`Gateway event references a missing task: ${existingEvent.requestId}`);
        }
        return { state: current, result: { duplicate: true, task: existingTask } };
      }
      const now = new Date().toISOString();
      const requestId = randomUUID();
      const task: TaskRecord = {
        requestId,
        platformMessageId: message.messageId,
        botId: message.conversation.botId,
        conversationKey: conversationStorageKey(message.conversation),
        conversation: message.conversation,
        replyToMessageId: message.messageId,
        state: "accepted",
        createdAt: now,
        updatedAt: now,
      };
      const event: PersistedEvent = {
        requestId,
        messageId: message.messageId,
        ...(message.eventId ? { eventId: message.eventId } : {}),
        acceptedAt: now,
      };
      const state = {
        ...current,
        events: Object.fromEntries([
          ...Object.entries(current.events),
          ...this.#eventKeys(message).map((key) => [key, event] as const),
        ]),
        tasks: { ...current.tasks, [requestId]: task },
      };
      return { state, result: { duplicate: false, task } };
    });
  }

  getConversation(key: string): Promise<ConversationRecord | undefined> {
    return this.#read().then((state) => state.conversations[key]);
  }

  saveConversation(record: ConversationRecord): Promise<void> {
    return this.#update((current) => ({
      state: {
        ...current,
        conversations: { ...current.conversations, [record.key]: record },
      },
      result: undefined,
    }));
  }

  transitionTask(
    requestId: string,
    state: TaskState,
    details: { responseMessageId?: string; failureCode?: string } = {},
  ): Promise<TaskRecord> {
    return this.#update((current) => {
      const existing = current.tasks[requestId];
      if (!existing) throw new Error(`Gateway task not found: ${requestId}`);
      const task: TaskRecord = {
        ...existing,
        state,
        updatedAt: new Date().toISOString(),
        ...(details.responseMessageId
          ? { responseMessageId: details.responseMessageId }
          : existing.responseMessageId
            ? { responseMessageId: existing.responseMessageId }
            : {}),
        ...(details.failureCode ? { failureCode: details.failureCode } : {}),
      };
      return {
        state: { ...current, tasks: { ...current.tasks, [requestId]: task } },
        result: task,
      };
    });
  }

  recoverUnknown(): Promise<readonly TaskRecord[]> {
    return this.#update((current) => {
      const recovered: TaskRecord[] = [];
      const tasks = { ...current.tasks };
      for (const [requestId, task] of Object.entries(tasks)) {
        if (!["accepted", "queued", "running"].includes(task.state)) {
          if (task.state === "unknown" && task.recoveryNoticePending) recovered.push(task);
          continue;
        }
        const next: TaskRecord = {
          ...task,
          state: "unknown",
          updatedAt: new Date().toISOString(),
          recoveryNoticePending: true,
        };
        tasks[requestId] = next;
        recovered.push(next);
      }
      return { state: { ...current, tasks }, result: recovered };
    });
  }

  markRecoveryNoticePresented(requestId: string): Promise<void> {
    return this.#update((current) => {
      const existing = current.tasks[requestId];
      if (!existing) throw new Error(`Gateway task not found: ${requestId}`);
      const task = { ...existing };
      delete task.recoveryNoticePending;
      return {
        state: { ...current, tasks: { ...current.tasks, [requestId]: task } },
        result: undefined,
      };
    });
  }

  async #read(): Promise<PersistedGatewayState> {
    try {
      const parsed = JSON.parse(
        await readFile(this.path, "utf8"),
      ) as Partial<PersistedGatewayState>;
      if (
        parsed.version !== 1 ||
        !isRecord(parsed.events) ||
        !isRecord(parsed.conversations) ||
        !isRecord(parsed.tasks)
      ) {
        throw new Error("Gateway state file has an unsupported shape");
      }
      return parsed as PersistedGatewayState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
      throw error;
    }
  }

  #update<T>(
    update: (current: PersistedGatewayState) => {
      readonly state: PersistedGatewayState;
      readonly result: T;
    },
  ): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolvePromise, reject) => {
      resolveResult = resolvePromise;
      rejectResult = reject;
    });
    this.#writes = this.#writes
      .then(() =>
        this.#lock.runExclusive(async () => {
          const next = update(await this.#read());
          await this.#write(next.state);
          resolveResult(next.result);
        }),
      )
      .catch((error) => rejectResult(error));
    return result;
  }

  async #write(state: PersistedGatewayState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #eventKeys(message: InboundMessage): readonly string[] {
    return [
      `${message.conversation.botId}:message:${message.messageId}`,
      ...(message.eventId ? [`${message.conversation.botId}:event:${message.eventId}`] : []),
    ];
  }

  #pruneState(state: PersistedGatewayState): PersistedGatewayState {
    const cutoff = Date.now() - this.eventRetentionMs;
    const retainedTasks = Object.fromEntries(
      Object.entries(state.tasks).filter(
        ([, task]) =>
          !isTerminal(task.state) ||
          task.recoveryNoticePending === true ||
          Date.parse(task.updatedAt) >= cutoff,
      ),
    );
    return {
      ...state,
      events: Object.fromEntries(
        Object.entries(state.events).filter(
          ([, event]) => retainedTasks[event.requestId] !== undefined,
        ),
      ),
      tasks: retainedTasks,
    };
  }
}

function isTerminal(state: TaskState): boolean {
  return ["completed", "failed", "cancelled", "rejected", "unknown"].includes(state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
