import { randomUUID } from "node:crypto";
import {
  createAbortError,
  AgentSessionNotFoundError,
  isAbortError,
  type AgentFailure,
  type StreamCallbacks,
} from "@omni-agent/core";
import type { AgentFactory, AgentInstance } from "../agent-factory";
import type {
  AgentPackageCatalogPort,
  AgentPackageDescriptor,
} from "../../agent-packages/contracts";
import {
  AgentServiceDisposalError,
  AgentServiceError,
  type AgentServiceAgent,
  type AgentServiceEvent,
  type AgentServicePort,
  type AgentServiceResourceDisposalFailure,
  type AgentServiceRunRequest,
  type AgentServiceSession,
  type AgentServiceState,
} from "./contracts";
import { ServiceEventStream } from "./service-event-stream";
import { toAgentServiceFailure } from "./agent-service-failure";

export interface AgentServiceOptions {
  readonly catalog: AgentPackageCatalogPort;
  readonly factory: Pick<AgentFactory, "create">;
}

interface OpeningRecord {
  readonly key: string;
  closeRequested: boolean;
}

interface OpeningEntry {
  readonly record: OpeningRecord;
  readonly promise: Promise<AgentServiceSession>;
}

interface SessionRecord {
  readonly key: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly instance: AgentInstance;
  readonly requests: Set<RequestRecord>;
  state: "open" | "closing";
  queue: Promise<void>;
  closePromise?: Promise<void>;
}

interface RequestRecord {
  readonly requestId: string;
  readonly controller: AbortController;
  readonly stream: ServiceEventStream;
  promise?: Promise<void>;
}

export class AgentService implements AgentServicePort {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly openings = new Map<string, OpeningEntry>();
  private readonly requests = new Map<string, RequestRecord>();
  private serviceState: AgentServiceState = "ready";
  private disposePromise?: Promise<void>;

  constructor(private readonly options: AgentServiceOptions) {}

  async listAgents(): Promise<readonly AgentServiceAgent[]> {
    this.assertReady();
    return this.options.catalog.list();
  }

  openSession(input: {
    readonly agentId: string;
    readonly sessionId?: string;
  }): Promise<AgentServiceSession> {
    this.assertReady();
    const explicitKey = input.sessionId ? sessionKey(input.agentId, input.sessionId) : undefined;
    if (explicitKey) {
      const existing = this.sessions.get(explicitKey);
      if (existing?.state === "open") return Promise.resolve(toSession(existing));
      if (existing?.state === "closing") {
        return Promise.reject(
          new AgentServiceError("session_closing", `Agent session is closing: ${input.sessionId}`),
        );
      }
    }
    const openingKey = explicitKey ?? `${input.agentId}:latest`;
    const current = this.openings.get(openingKey);
    if (current) return current.promise;
    return this.startOpening(openingKey, input.agentId, input.sessionId, false);
  }

  createSession(input: { readonly agentId: string }): Promise<AgentServiceSession> {
    this.assertReady();
    const openingKey = `${input.agentId}:new:${randomUUID()}`;
    return this.startOpening(openingKey, input.agentId, undefined, true);
  }

  async closeSession(input: {
    readonly agentId: string;
    readonly sessionId: string;
  }): Promise<void> {
    this.assertReady();
    const key = sessionKey(input.agentId, input.sessionId);
    const session = this.sessions.get(key);
    if (session) return this.closeRecord(session);

    const opening = this.openings.get(key);
    if (!opening) {
      throw new AgentServiceError(
        "session_not_open",
        `Agent session is not open: ${input.sessionId}`,
      );
    }
    opening.record.closeRequested = true;
    try {
      await opening.promise;
    } catch (error) {
      if (error instanceof AgentServiceError && error.code === "session_closing") return;
      throw error;
    }
    const opened = this.sessions.get(key);
    if (opened) await this.closeRecord(opened);
  }

  run(
    request: AgentServiceRunRequest,
    externalSignal?: AbortSignal,
  ): AsyncIterable<AgentServiceEvent> {
    const controller = new AbortController();
    let started = false;
    const stream = new ServiceEventStream(
      () => {
        if (started) return;
        started = true;
        this.startRequest(request, controller, stream, externalSignal);
      },
      () => controller.abort(createAbortError()),
    );
    return stream;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    if (this.serviceState === "disposed") return Promise.resolve();
    this.serviceState = "disposing";
    this.disposePromise = this.disposeOwnedResources();
    return this.disposePromise;
  }

  private startOpening(
    openingKey: string,
    agentId: string,
    sessionId: string | undefined,
    createNew: boolean,
  ): Promise<AgentServiceSession> {
    const record: OpeningRecord = { key: openingKey, closeRequested: false };
    const promise = this.createSessionInstance(record, agentId, sessionId, createNew);
    this.openings.set(openingKey, { record, promise });
    return promise;
  }

  private async createSessionInstance(
    opening: OpeningRecord,
    agentId: string,
    requestedSessionId: string | undefined,
    createNew: boolean,
  ): Promise<AgentServiceSession> {
    let instance: AgentInstance | undefined;
    try {
      await this.requireAvailableAgent(agentId);
      const agentPackage = await this.options.catalog.load(agentId);
      instance = await this.options.factory.create(agentPackage);
      let sessionId: string;
      if (createNew) sessionId = await instance.application.newSession();
      else if (requestedSessionId) {
        try {
          sessionId = (await instance.application.openSession(requestedSessionId)).sessionId;
        } catch (error) {
          if (error instanceof AgentSessionNotFoundError) {
            throw new AgentServiceError(
              "session_not_found",
              `Agent session was not found: ${requestedSessionId}`,
              false,
              { cause: error },
            );
          }
          throw error;
        }
      } else {
        sessionId = instance.application.currentSessionSnapshot().sessionId;
      }
      const key = sessionKey(agentId, sessionId);
      if (opening.closeRequested || this.serviceState !== "ready") {
        const closingInstance = instance;
        instance = undefined;
        try {
          await closingInstance.dispose();
        } catch (cleanupError) {
          throw new AgentServiceDisposalError([
            { resource: `opening:${agentId}:${sessionId}`, error: cleanupError },
          ]);
        }
        throw new AgentServiceError("session_closing", `Agent session is closing: ${sessionId}`);
      }
      const existing = this.sessions.get(key);
      if (existing) {
        const redundantInstance = instance;
        instance = undefined;
        try {
          await redundantInstance.dispose();
        } catch (cleanupError) {
          throw new AgentServiceDisposalError([
            { resource: `opening:${agentId}:${sessionId}`, error: cleanupError },
          ]);
        }
        if (existing.state === "closing") {
          throw new AgentServiceError("session_closing", `Agent session is closing: ${sessionId}`);
        }
        return toSession(existing);
      }
      const session: SessionRecord = {
        key,
        agentId,
        sessionId,
        instance,
        state: "open",
        queue: Promise.resolve(),
        requests: new Set(),
      };
      this.sessions.set(key, session);
      instance = undefined;
      return toSession(session);
    } catch (error) {
      if (instance) {
        try {
          await instance.dispose();
        } catch (cleanupError) {
          throw new AgentServiceDisposalError([
            {
              resource: `opening:${agentId}:${requestedSessionId ?? "latest"}`,
              error: new AggregateError(
                [error, cleanupError],
                "Agent session opening and cleanup failed",
              ),
            },
          ]);
        }
      }
      throw error;
    } finally {
      this.openings.delete(opening.key);
    }
  }

  private async requireAvailableAgent(agentId: string): Promise<AgentPackageDescriptor> {
    const descriptor = (await this.options.catalog.list()).find((agent) => agent.id === agentId);
    if (!descriptor) {
      throw new AgentServiceError(
        "agent_not_available",
        `Agent is not available through this service: ${agentId}`,
      );
    }
    return descriptor;
  }

  private startRequest(
    request: AgentServiceRunRequest,
    controller: AbortController,
    stream: ServiceEventStream,
    externalSignal?: AbortSignal,
  ): void {
    try {
      this.assertReady();
      if (this.requests.has(request.requestId)) {
        throw new AgentServiceError(
          "duplicate_request",
          `Agent service request is already active: ${request.requestId}`,
        );
      }
      const key = sessionKey(request.agentId, request.sessionId);
      const opening = this.openings.get(key);
      if (opening) {
        throw new AgentServiceError(
          opening.record.closeRequested ? "session_closing" : "session_opening",
          opening.record.closeRequested
            ? `Agent session is closing: ${request.sessionId}`
            : `Agent session is opening: ${request.sessionId}`,
        );
      }
      const session = this.sessions.get(key);
      if (!session) {
        throw new AgentServiceError(
          "session_not_open",
          `Agent session is not open: ${request.sessionId}`,
        );
      }
      if (session.state === "closing") {
        throw new AgentServiceError(
          "session_closing",
          `Agent session is closing: ${request.sessionId}`,
        );
      }
      const record: RequestRecord = { requestId: request.requestId, controller, stream };
      this.requests.set(request.requestId, record);
      session.requests.add(record);
      const preceding = session.queue.catch(() => undefined);
      record.promise = preceding.then(() =>
        this.executeRequest(session, record, request, externalSignal),
      );
      session.queue = record.promise.catch(() => undefined);
    } catch (error) {
      stream.push(toFailedEvent(error));
      stream.finish();
    }
  }

  private async executeRequest(
    session: SessionRecord,
    record: RequestRecord,
    request: AgentServiceRunRequest,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const signal = externalSignal
      ? AbortSignal.any([record.controller.signal, externalSignal])
      : record.controller.signal;
    let terminal = false;
    let accumulatedText = "";
    const terminate = (event: AgentServiceEvent) => {
      if (terminal) return;
      terminal = true;
      record.stream.push(event);
    };
    const callbacks: StreamCallbacks = {
      onTextChunk: (event) => {
        if (terminal) return;
        accumulatedText += event.delta;
        record.stream.push({ type: "text_delta", text: event.delta });
      },
      onFinalResponse: () => {
        if (!terminal) {
          record.stream.push({ type: "final_response", text: accumulatedText });
        }
      },
      onDone: () => terminate({ type: "completed" }),
      onError: (failure) =>
        signal.aborted ? terminate({ type: "cancelled" }) : terminate(toFailureEvent(failure)),
    };
    try {
      if (signal.aborted) throw createAbortError(signal);
      if (session.state !== "open") {
        throw new AgentServiceError(
          "session_closing",
          `Agent session is closing: ${session.sessionId}`,
        );
      }
      record.stream.push({
        type: "started",
        requestId: request.requestId,
        sessionId: request.sessionId,
      });
      await session.instance.application.run(request.input.text, callbacks, signal);
      if (!terminal) terminate(signal.aborted ? { type: "cancelled" } : { type: "completed" });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) terminate({ type: "cancelled" });
      else terminate(toFailedEvent(error));
    } finally {
      record.stream.finish();
      session.requests.delete(record);
      this.requests.delete(record.requestId);
    }
  }

  private closeRecord(session: SessionRecord): Promise<void> {
    if (session.closePromise) return session.closePromise;
    session.state = "closing";
    session.closePromise = (async () => {
      for (const request of session.requests) request.controller.abort(createAbortError());
      await Promise.allSettled([...session.requests].map((request) => request.promise));
      try {
        await session.instance.dispose();
      } finally {
        this.sessions.delete(session.key);
      }
    })();
    return session.closePromise;
  }

  private async disposeOwnedResources(): Promise<void> {
    for (const opening of this.openings.values()) opening.record.closeRequested = true;
    const failures: AgentServiceResourceDisposalFailure[] = [];
    const openingEntries = [...this.openings.values()];
    const openingResults = await Promise.allSettled(openingEntries.map(({ promise }) => promise));
    for (const [index, result] of openingResults.entries()) {
      if (result.status === "rejected" && result.reason instanceof AgentServiceDisposalError) {
        failures.push({
          resource: `opening:${openingEntries[index]!.record.key}`,
          error: result.reason,
        });
      }
    }
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        try {
          await this.closeRecord(session);
        } catch (error) {
          failures.push({ resource: `session:${session.agentId}:${session.sessionId}`, error });
        }
      }),
    );
    this.serviceState = "disposed";
    this.disposePromise = undefined;
    if (failures.length > 0) throw new AgentServiceDisposalError(failures);
  }

  private assertReady(): void {
    if (this.serviceState !== "ready") {
      throw new AgentServiceError("agent_service_closed", "Agent service is closed");
    }
  }
}

function sessionKey(agentId: string, sessionId: string): string {
  return `${agentId}:${sessionId}`;
}

function toSession(record: SessionRecord): AgentServiceSession {
  return { agentId: record.agentId, sessionId: record.sessionId };
}

function toFailureEvent(failure: AgentFailure): AgentServiceEvent {
  return {
    type: "failed",
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
}

function toFailedEvent(error: unknown): AgentServiceEvent {
  return { type: "failed", ...toAgentServiceFailure(error) };
}
