import WebSocket from "ws";
import { AGENT_HOST_MAX_BUFFERED_BYTES, type AgentHostServerMessage } from "./contracts";
import { AgentHostError } from "./host-error";

export class OutboundWriter {
  #tail = Promise.resolve();
  #accepting = true;

  constructor(private readonly socket: WebSocket) {}

  send(message: AgentHostServerMessage): Promise<void> {
    if (!this.#accepting) {
      return Promise.reject(new AgentHostError("host_closed", "Agent Host connection is closed"));
    }
    let payload: string;
    try {
      payload = JSON.stringify(message);
    } catch {
      return Promise.reject(new AgentHostError("invalid_message", "Host response is invalid"));
    }
    const operation = this.#tail.then(() => this.#sendPayload(payload));
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (!this.#accepting) return this.#tail;
    this.#accepting = false;
    await this.#tail;
  }

  #sendPayload(payload: string): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new AgentHostError("host_closed", "Agent Host connection is closed");
    }
    if (
      this.socket.bufferedAmount + Buffer.byteLength(payload, "utf8") >
      AGENT_HOST_MAX_BUFFERED_BYTES
    ) {
      throw new AgentHostError("host_busy", "Agent Host client is not consuming events", true);
    }
    return new Promise<void>((resolve, reject) => {
      this.socket.send(payload, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
