import {
  throwIfAborted,
  type ContextSummaryGeneratorPort,
  type ContextSummaryRequest,
  type ContextSummaryResult,
  type ModelRuntimePort,
  type RuntimeModelSelection,
} from "@omni-agent/core";

export class RuntimeContextSummaryGenerator implements ContextSummaryGeneratorPort {
  constructor(
    private readonly runtime: ModelRuntimePort,
    private readonly currentModel: () => RuntimeModelSelection,
  ) {}

  async generate(request: ContextSummaryRequest): Promise<ContextSummaryResult> {
    let completed: ContextSummaryResult | undefined;
    for await (const event of this.runtime.stream(
      this.currentModel(),
      {
        systemPrompt: request.systemPrompt,
        messages: [{ role: "user", content: request.userPrompt }],
        tools: [],
      },
      {
        identity: {
          agentId: request.agentId,
          sessionId: request.sessionId,
          modelCallId: request.modelCallId,
          purpose: "auxiliary",
        },
        cache: { retention: "none" },
        signal: request.signal,
        maxOutputTokens: request.maxOutputTokens,
      },
    )) {
      if (event.type === "error") {
        throwIfAborted(request.signal);
        throw new Error(event.error.errorMessage ?? "Context summary model call failed");
      }
      if (event.type === "done") {
        if (event.message.stopReason !== "stop")
          throw new Error(`Context summary did not finish: ${event.message.stopReason}`);
        const summary = event.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
        completed = {
          summary,
          provider: event.message.provider,
          model: event.message.model,
          responseModel: event.message.responseModel,
        };
      }
    }
    if (!completed) throw new Error("Context summary model call returned no completion");
    return completed;
  }
}
