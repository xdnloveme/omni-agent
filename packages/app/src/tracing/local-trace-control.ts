import type { TraceControlPort } from "@omni-agent/core";

export class LocalTraceControl implements TraceControlPort {
  private enabled = false;

  start(): void {
    this.enabled = true;
  }

  stop(): void {
    this.enabled = false;
  }

  status(): "off" | "on" {
    return this.enabled ? "on" : "off";
  }
}
