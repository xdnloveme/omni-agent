import Ajv, { type ValidateFunction } from "ajv";
import {
  AGENT_HOST_MAX_REQUEST_BYTES,
  AGENT_HOST_MAX_RESPONSE_BYTES,
  type AgentHostClientMessage,
  type AgentHostHelloMessage,
  type AgentHostRequest,
  type AgentHostServerMessage,
} from "./contracts";
import { AgentHostError } from "./host-error";
import {
  agentHostHelloSchema,
  agentHostRequestSchema,
  agentHostServerMessageSchema,
} from "./protocol-schema";

export class AgentHostProtocolValidator {
  readonly #validateHello: ValidateFunction<AgentHostHelloMessage>;
  readonly #validateRequest: ValidateFunction<AgentHostRequest>;
  readonly #validateServerMessage: ValidateFunction<AgentHostServerMessage>;

  constructor() {
    const ajv = new Ajv({ allErrors: true, strict: true });
    this.#validateHello = ajv.compile<AgentHostHelloMessage>(agentHostHelloSchema);
    this.#validateRequest = ajv.compile<AgentHostRequest>(agentHostRequestSchema);
    this.#validateServerMessage = ajv.compile<AgentHostServerMessage>(agentHostServerMessageSchema);
  }

  parse(raw: string): AgentHostClientMessage {
    const value = this.#parseJson(raw, AGENT_HOST_MAX_REQUEST_BYTES);
    if (this.#validateHello(value)) return value;
    if (this.#validateRequest(value)) return value;
    throw new AgentHostError("invalid_message", "Agent Host message is invalid");
  }

  parseServerMessage(raw: string): AgentHostServerMessage {
    const value = this.#parseJson(raw, AGENT_HOST_MAX_RESPONSE_BYTES);
    if (this.#validateServerMessage(value)) return value;
    throw new AgentHostError("invalid_message", "Agent Host server message is invalid");
  }

  #parseJson(raw: string, maxBytes: number): unknown {
    if (Buffer.byteLength(raw, "utf8") > maxBytes) {
      throw new AgentHostError("payload_too_large", "Agent Host message is too large");
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new AgentHostError("invalid_message", "Agent Host message is invalid");
    }
    if (isRecord(value) && value.v !== 1) {
      throw new AgentHostError("unsupported_version", "Agent Host protocol version is unsupported");
    }
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
