import { AGENT_HOST_PROTOCOL_VERSION } from "@omni-agent/agent-host";
import type { AgentConversationHandle, AgentLinkPort } from "./agent-link-port";
import type { AgentLinkEvent } from "./agent-link-events";
import { HostProcessSupervisor } from "./host-process-supervisor";

export class HostProcessLink implements AgentLinkPort {
  constructor(private readonly supervisor: HostProcessSupervisor) {}

  async listAgents() {
    const client = await this.supervisor.getClient();
    const result = await client.request({
      v: AGENT_HOST_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      type: "list_agents",
    });
    if (result.kind !== "agents") throw new Error("Agent Host returned an invalid agents result");
    return result.agents;
  }

  async createConversation(agentId: string): Promise<AgentConversationHandle> {
    const client = await this.supervisor.getClient();
    const result = await client.request({
      v: AGENT_HOST_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      type: "create_session",
      agentId,
    });
    if (result.kind !== "session") throw new Error("Agent Host returned an invalid session result");
    return result.session;
  }

  async openConversation(agentId: string, sessionId: string): Promise<AgentConversationHandle> {
    const client = await this.supervisor.getClient();
    const result = await client.request({
      v: AGENT_HOST_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      type: "open_session",
      agentId,
      sessionId,
    });
    if (result.kind !== "session") throw new Error("Agent Host returned an invalid session result");
    return result.session;
  }

  async *run(
    handle: AgentConversationHandle,
    requestId: string,
    text: string,
    signal?: AbortSignal,
  ): AsyncIterable<AgentLinkEvent> {
    const client = await this.supervisor.getClient();
    yield* client.stream(
      {
        v: AGENT_HOST_PROTOCOL_VERSION,
        id: requestId,
        type: "run",
        agentId: handle.agentId,
        sessionId: handle.sessionId,
        text,
      },
      signal,
    );
  }

  async cancel(requestId: string): Promise<void> {
    const client = await this.supervisor.getClient();
    await client.cancel(requestId);
  }

  async closeConversation(handle: AgentConversationHandle): Promise<void> {
    const client = await this.supervisor.getClient();
    const result = await client.request({
      v: AGENT_HOST_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      type: "close_session",
      agentId: handle.agentId,
      sessionId: handle.sessionId,
    });
    if (result.kind !== "closed") throw new Error("Agent Host returned an invalid close result");
  }

  dispose(): Promise<void> {
    return this.supervisor.dispose();
  }
}
