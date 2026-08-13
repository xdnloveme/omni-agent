export interface ModelCallIdentity {
  readonly agentId: string;
  readonly sessionId: string;
  readonly modelCallId: string;
  readonly contextSnapshotId?: string;
  readonly purpose: "primary" | "auxiliary";
}
