export interface ContextSummaryRequest {
  readonly agentId: string;
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxOutputTokens: number;
  readonly modelCallId: string;
  readonly signal?: AbortSignal;
}

export interface ContextSummaryResult {
  readonly summary: string;
  readonly provider: string;
  readonly model: string;
  readonly responseModel?: string;
}

export interface ContextArtifactWriteRequest {
  readonly sessionId: string;
  readonly artifactId: string;
  readonly content: string;
}

export interface ContextArtifactStorePort {
  write(request: ContextArtifactWriteRequest): Promise<string>;
}

export interface ContextSummaryGeneratorPort {
  generate(request: ContextSummaryRequest): Promise<ContextSummaryResult>;
}
