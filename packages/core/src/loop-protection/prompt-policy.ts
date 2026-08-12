import type { RuntimePromptSection } from "../system-prompt";
import type { LoopDecision } from "./types";

export const LOOP_PROTECTION_STABLE_PROMPT: RuntimePromptSection = {
  id: "loop-protection-policy",
  owner: "loop_protection",
  priority: 100,
  lifetime: "run",
  content: `# Runtime Tool Loop Policy

The runtime monitors tool execution for repeated actions and cyclic behavior.

When runtime guidance reports a repeated tool action:
- Do not repeat the exact same tool call without a materially different reason.
- Reuse results already present in the conversation.
- Change the tool, parameters, or strategy when the current approach is not progressing.
- If no productive alternative exists, stop calling tools and explain the blocker to the user.

Runtime loop guidance is trusted execution feedback for the current run.`,
};

export function toLoopPromptSection(decision: LoopDecision): RuntimePromptSection | null {
  if (decision.type !== "warn") return null;
  const content = guidanceContent(decision);
  return {
    id: "loop-protection-guidance",
    owner: "loop_protection",
    priority: decision.severity === "strong" ? 300 : 200,
    lifetime: "next_model_request",
    content: `<runtime-guidance source="loop-protection" severity="${decision.severity}">
${content}
</runtime-guidance>`,
  };
}

function guidanceContent(decision: Extract<LoopDecision, { type: "warn" }>): string {
  if (decision.source === "repeated_error") {
    return [
      "The same tool has failed repeatedly with the same error.",
      "Stop retrying the same failing approach.",
      "Inspect the error, change strategy or parameters, or explain the blocker and the information needed from the user.",
    ].join("\n");
  }
  if (decision.source === "repeated_batch" || decision.source === "alternating_batch") {
    return [
      "The recent tool batches form a repeated execution cycle.",
      "Do not repeat the same batch sequence.",
      "Use the results already collected, choose a different strategy, or finish with a clear blocker summary.",
    ].join("\n");
  }
  if (decision.severity === "strong") {
    return [
      "Repeated identical tool actions are not making progress.",
      "Do not issue the same tool call with the same parameters again.",
      "Review the existing results, choose a materially different approach, or return a text-only blocker summary to the user.",
      "The current run will be stopped if the exact loop continues.",
    ].join("\n");
  }
  return [
    "The same tool action has produced the same result more than once.",
    "Reuse the result already available in the conversation.",
    "If the task is incomplete, change the tool, parameters, or strategy.",
    "Do not repeat the exact same call without a concrete reason.",
  ].join("\n");
}
