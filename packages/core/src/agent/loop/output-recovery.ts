import type { AssistantTranscriptMessage } from "../../messages";
import type { AgentFailure } from "../../types";

const MAX_OUTPUT_RECOVERIES = 3;

/** Run-local recovery state. The enclosing loop retains ownership of cancellation and limits. */
export class OutputRecovery {
  private attempts = 0;
  private parentModelCallId?: string;
  private thinkingOnly = false;

  get context(): { attempt: number; parentModelCallId: string } | undefined {
    return this.parentModelCallId
      ? { attempt: this.attempts, parentModelCallId: this.parentModelCallId }
      : undefined;
  }

  get instruction(): string {
    if (!this.parentModelCallId) return "";
    return (
      "\n\n[Runtime output recovery]\nThe previous response reached its output limit and is incomplete. " +
      (this.thinkingOnly
        ? "No final answer was produced. Keep further reasoning concise and proceed to the next concrete action. "
        : "Continue the unfinished work using the available evidence. ") +
      "No tool calls from the truncated response were executed. Previously completed tool results remain valid; do not repeat their actions merely because this response was interrupted."
    );
  }

  recover(response: AssistantTranscriptMessage, modelCallId: string): AgentFailure | undefined {
    if (this.attempts >= MAX_OUTPUT_RECOVERIES)
      return {
        code: "model_output_recovery_exhausted",
        message: "Model output remained truncated after three recovery attempts.",
        retryable: false,
      };
    this.attempts++;
    this.parentModelCallId = modelCallId;
    this.thinkingOnly = !response.content.some(
      (block) => block.type === "text" && block.text.trim(),
    );
    return undefined;
  }

  reset(): void {
    this.attempts = 0;
    this.parentModelCallId = undefined;
    this.thinkingOnly = false;
  }
}
