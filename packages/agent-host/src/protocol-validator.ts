import Ajv, { type ValidateFunction } from "ajv";
import {
  AGENT_HOST_MAX_PAYLOAD_BYTES,
  type AgentHostClientMessage,
  type AgentHostHelloMessage,
  type AgentHostRequest,
} from "./contracts";
import { AgentHostError } from "./host-error";
import { agentHostHelloSchema, agentHostRequestSchema } from "./protocol-schema";

export class AgentHostProtocolValidator {
  readonly #validateHello: ValidateFunction<AgentHostHelloMessage>;
  readonly #validateRequest: ValidateFunction<AgentHostRequest>;

  constructor() {
    const ajv = new Ajv({ allErrors: true, strict: true });
    this.#validateHello = ajv.compile<AgentHostHelloMessage>(agentHostHelloSchema);
    this.#validateRequest = ajv.compile<AgentHostRequest>(agentHostRequestSchema);
  }

  parse(raw: string): AgentHostClientMessage {
    if (Buffer.byteLength(raw, "utf8") > AGENT_HOST_MAX_PAYLOAD_BYTES) {
      throw new AgentHostError("payload_too_large", "Agent Host message is too large");
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new AgentHostError("invalid_message", "Agent Host message is invalid");
    }
    if (isRecord(value) && value.v !== 2) {
      throw new AgentHostError("unsupported_version", "Agent Host protocol version is unsupported");
    }
    if (this.#validateHello(value)) return value;
    if (this.#validateRequest(value)) return value;
    throw new AgentHostError("invalid_message", "Agent Host message is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
