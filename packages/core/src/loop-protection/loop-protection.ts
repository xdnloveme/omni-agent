import type { ToolCallContent } from "../models/messages";
import { RuntimePromptComposer, type RuntimePromptLease } from "../system-prompt";
import { reduceLoopDecisions } from "./decision-reducer";
import { LOOP_PROTECTION_STABLE_PROMPT, toLoopPromptSection } from "./prompt-policy";
import { buildBatchFingerprint, buildErrorSignature, buildToolResultSignature } from "./signatures";
import { BatchCycleRule, ConsecutiveErrorRule, RepeatedResultRule } from "./rules";
import type {
  LoopBatchDecision,
  LoopDecision,
  ToolLoopDiagnostic,
  ToolResultObservation,
} from "./types";

interface ActiveBatch {
  calls: readonly ToolCallContent[];
  signatures: Map<string, string>;
  decisions: LoopDecision[];
}

export interface LoopProtection {
  beginToolBatch(calls: readonly ToolCallContent[]): void;
  observeToolResult(input: ToolResultObservation): void;
  completeToolBatch(): LoopBatchDecision;
  leaseSystemPrompt(basePrompt: string, hasTools: boolean): RuntimePromptLease;
  markPromptDispatched(leaseId: string | undefined): void;
}

export function createLoopProtection(): LoopProtection {
  return new DefaultLoopProtection();
}

class DefaultLoopProtection implements LoopProtection {
  private readonly repeatedResultRule = new RepeatedResultRule();
  private readonly consecutiveErrorRule = new ConsecutiveErrorRule();
  private readonly batchCycleRule = new BatchCycleRule();
  private readonly promptComposer = new RuntimePromptComposer();
  private activeBatch: ActiveBatch | null = null;

  beginToolBatch(calls: readonly ToolCallContent[]): void {
    this.activeBatch = { calls, signatures: new Map(), decisions: [] };
  }

  observeToolResult(input: ToolResultObservation): void {
    const batch = this.activeBatch;
    if (!batch) return;

    const signature = buildToolResultSignature(input.call, input.toolIdentity, input.result);
    if (signature) {
      batch.signatures.set(input.call.id, signature);
      batch.decisions.push(this.repeatedResultRule.evaluate(signature, input.call.name));
    }

    const errorSignature = input.result.isError
      ? buildErrorSignature(input.toolIdentity, input.call.name, input.result)
      : null;
    batch.decisions.push(
      this.consecutiveErrorRule.evaluate({
        isError: input.result.isError,
        signature: errorSignature,
        toolName: input.call.name,
      }),
    );
  }

  completeToolBatch(): LoopBatchDecision {
    const batch = this.activeBatch;
    this.activeBatch = null;
    if (!batch) return { type: "continue" };

    const signatures = batch.calls.map((call) => batch.signatures.get(call.id));
    let batchEvaluation;
    if (signatures.every((signature): signature is string => typeof signature === "string")) {
      const fingerprint = buildBatchFingerprint(signatures);
      if (fingerprint) {
        batchEvaluation = this.batchCycleRule.evaluate({
          fingerprint,
          toolCount: batch.calls.length,
          toolNames: batch.calls.map((call) => call.name),
        });
      }
    }

    const decision = reduceLoopDecisions(batch.decisions, batchEvaluation);
    if (decision.type === "continue") return decision;
    if (decision.type === "warn") {
      const section = toLoopPromptSection(decision);
      if (section) this.promptComposer.enqueue(section);
      return { type: "warn" };
    }

    const diagnostic: ToolLoopDiagnostic = {
      kind: decision.source,
      count: decision.count,
      signature: decision.signature,
      toolNames: decision.toolNames,
      ...(decision.period ? { period: decision.period } : {}),
    };
    return {
      type: "halt",
      error: loopErrorMessage(diagnostic),
      diagnostic,
    };
  }

  leaseSystemPrompt(basePrompt: string, hasTools: boolean): RuntimePromptLease {
    return this.promptComposer.lease(basePrompt, hasTools ? [LOOP_PROTECTION_STABLE_PROMPT] : []);
  }

  markPromptDispatched(leaseId: string | undefined): void {
    this.promptComposer.markDispatched(leaseId);
  }
}

function loopErrorMessage(diagnostic: ToolLoopDiagnostic): string {
  if (diagnostic.kind === "alternating_batch") {
    return `Tool loop detected: the same two-step tool batch cycle repeated ${diagnostic.count} times.`;
  }
  if (diagnostic.kind === "repeated_batch") {
    return `Tool loop detected: the same tool batch repeated ${diagnostic.count} times.`;
  }
  return `Tool loop detected: the same tool action produced the same result ${diagnostic.count} times within the current run.`;
}
