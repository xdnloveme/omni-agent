export interface ContextCheckpoint {
  readonly id: string;
  readonly parentId?: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly coveredMessageCount: number;
  readonly coveredTranscriptDigest: string;
  readonly sourceMiddlewareDigest: string;
  readonly sourcePolicyDigest: string;
  readonly gateName: string;
  readonly gateVersion: number;
  readonly promptVersion: number;
  readonly summary: string;
  readonly summaryDigest: string;
  readonly estimatedSummaryTokens: number;
  readonly summaryModelCallId: string;
  readonly generatedBy: {
    readonly provider: string;
    readonly model: string;
    readonly responseModel?: string;
  };
  readonly createdAt: string;
}
