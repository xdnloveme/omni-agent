import type {
  AgentServiceAgent,
  AgentServiceEvent,
  AgentServiceFailure,
  AgentServicePort,
  AgentServiceSession,
} from "@omni-agent/app";

export const AGENT_HOST_PROTOCOL_VERSION = 1 as const;
export const AGENT_HOST_LISTEN_ADDRESS = "127.0.0.1" as const;
export const AGENT_HOST_MAX_PAYLOAD_BYTES = 64 * 1024;
export const AGENT_HOST_MAX_BUFFERED_BYTES = 1024 * 1024;

export interface AgentHostOptions {
  readonly service: AgentServicePort;
  readonly token: string;
  readonly port?: number;
}

export type AgentHostTermination =
  { readonly reason: "client_disconnected" } | { readonly reason: "closed" };

export interface AgentHostServer {
  readonly address: {
    readonly host: typeof AGENT_HOST_LISTEN_ADDRESS;
    readonly port: number;
  };
  readonly termination: Promise<AgentHostTermination>;
  close(): Promise<void>;
}

export interface AgentHostHelloMessage {
  readonly v: typeof AGENT_HOST_PROTOCOL_VERSION;
  readonly type: "hello";
  readonly token: string;
}

export interface AgentHostReadyMessage {
  readonly v: typeof AGENT_HOST_PROTOCOL_VERSION;
  readonly type: "ready";
  readonly connectionId: string;
}

export type AgentHostRequest =
  | { readonly v: 1; readonly id: string; readonly type: "list_agents" }
  | {
      readonly v: 1;
      readonly id: string;
      readonly type: "open_session";
      readonly agentId: string;
      readonly sessionId?: string;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly type: "create_session";
      readonly agentId: string;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly type: "close_session";
      readonly agentId: string;
      readonly sessionId: string;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly type: "run";
      readonly agentId: string;
      readonly sessionId: string;
      readonly text: string;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly type: "cancel";
      readonly requestId: string;
    };

export type AgentHostResult =
  | { readonly kind: "agents"; readonly agents: readonly AgentServiceAgent[] }
  | { readonly kind: "session"; readonly session: AgentServiceSession }
  | { readonly kind: "closed" }
  | { readonly kind: "cancel_requested"; readonly requestId: string };

export type AgentHostResponse =
  | {
      readonly v: 1;
      readonly type: "result";
      readonly id: string;
      readonly result: AgentHostResult;
    }
  | {
      readonly v: 1;
      readonly type: "event";
      readonly requestId: string;
      readonly event: AgentServiceEvent;
    }
  | {
      readonly v: 1;
      readonly type: "error";
      readonly id?: string;
      readonly error: AgentServiceFailure;
    };

export type AgentHostServerMessage = AgentHostReadyMessage | AgentHostResponse;
export type AgentHostClientMessage = AgentHostHelloMessage | AgentHostRequest;
