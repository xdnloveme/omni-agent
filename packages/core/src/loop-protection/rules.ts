import { buildSequenceFingerprint } from "./signatures";
import type { BatchCycleEvaluation, LoopDecision } from "./types";

const RESULT_WINDOW_SIZE = 10;
const BATCH_HISTORY_SIZE = 8;

export class RepeatedResultRule {
  private readonly history: string[] = [];
  private readonly counts = new Map<string, number>();

  evaluate(signature: string, toolName: string): LoopDecision {
    this.history.push(signature);
    this.counts.set(signature, (this.counts.get(signature) ?? 0) + 1);
    this.trimHistory();

    const count = this.counts.get(signature) ?? 0;
    if (count >= 4) {
      return {
        type: "halt",
        source: "repeated_result",
        count,
        signature,
        toolNames: [toolName],
      };
    }
    if (count >= 3) {
      return {
        type: "warn",
        severity: "strong",
        source: "repeated_result",
        count,
        signature,
        toolNames: [toolName],
      };
    }
    if (count >= 2) {
      return {
        type: "warn",
        severity: "soft",
        source: "repeated_result",
        count,
        signature,
        toolNames: [toolName],
      };
    }
    return { type: "continue" };
  }

  private trimHistory(): void {
    while (this.history.length > RESULT_WINDOW_SIZE) {
      const removed = this.history.shift();
      if (!removed) return;
      const next = (this.counts.get(removed) ?? 0) - 1;
      if (next <= 0) this.counts.delete(removed);
      else this.counts.set(removed, next);
    }
  }
}

export class ConsecutiveErrorRule {
  private lastSignature: string | null = null;
  private streak = 0;

  evaluate(input: { isError: boolean; signature: string | null; toolName: string }): LoopDecision {
    if (!input.isError || input.signature === null) {
      this.reset();
      return { type: "continue" };
    }

    if (input.signature === this.lastSignature) this.streak += 1;
    else {
      this.lastSignature = input.signature;
      this.streak = 1;
    }

    if (this.streak < 3) return { type: "continue" };
    const decision: LoopDecision = {
      type: "warn",
      severity: "strong",
      source: "repeated_error",
      count: this.streak,
      signature: input.signature,
      toolNames: [input.toolName],
    };
    this.reset();
    return decision;
  }

  private reset(): void {
    this.lastSignature = null;
    this.streak = 0;
  }
}

interface BatchHistoryEntry {
  fingerprint: string;
  toolCount: number;
  toolNames: string[];
}

interface ActivePeriodTwoCycle {
  firstFingerprint: string;
  secondFingerprint: string;
  completedCycles: number;
  phase: "expect_first" | "expect_second";
}

export class BatchCycleRule {
  private readonly history: BatchHistoryEntry[] = [];
  private activePeriodTwo: ActivePeriodTwoCycle | null = null;

  evaluate(entry: BatchHistoryEntry): BatchCycleEvaluation {
    this.history.push(entry);
    if (this.history.length > BATCH_HISTORY_SIZE) this.history.shift();

    const periodOne = this.countTrailingPeriodOne();
    if (periodOne && entry.toolCount !== 1) {
      this.activePeriodTwo = null;
      return {
        decision: this.toDecision(periodOne, 1, entry.fingerprint, entry.toolNames),
      };
    }

    const activeEvaluation = this.advanceActivePeriodTwo(entry);
    if (activeEvaluation) return activeEvaluation;

    const detected = this.detectPeriodTwo();
    if (detected) return detected;
    return { decision: { type: "continue" } };
  }

  private advanceActivePeriodTwo(entry: BatchHistoryEntry): BatchCycleEvaluation | null {
    const active = this.activePeriodTwo;
    if (!active) return null;

    const expectsFirst = active.phase === "expect_first";
    const expected = expectsFirst ? active.firstFingerprint : active.secondFingerprint;
    if (entry.fingerprint !== expected) {
      this.activePeriodTwo = null;
      return null;
    }

    if (expectsFirst) {
      active.phase = "expect_second";
      return {
        decision: { type: "continue" },
        activeCycle: {
          kind: "alternating_batch",
          phase: "partial",
          completedCycles: active.completedCycles,
        },
      };
    }

    active.completedCycles += 1;
    active.phase = "expect_first";
    return {
      decision: this.periodTwoDecision(active),
      activeCycle: {
        kind: "alternating_batch",
        phase: "complete",
        completedCycles: active.completedCycles,
      },
    };
  }

  private detectPeriodTwo(): BatchCycleEvaluation | null {
    if (this.history.length < 4) return null;
    const pattern = this.history.slice(-4);
    const first = pattern[0];
    const second = pattern[1];
    const third = pattern[2];
    const fourth = pattern[3];
    if (!first || !second || !third || !fourth) return null;
    if (
      first.fingerprint === second.fingerprint ||
      first.fingerprint !== third.fingerprint ||
      second.fingerprint !== fourth.fingerprint
    ) {
      return null;
    }

    this.activePeriodTwo = {
      firstFingerprint: first.fingerprint,
      secondFingerprint: second.fingerprint,
      completedCycles: 2,
      phase: "expect_first",
    };
    return {
      decision: this.periodTwoDecision(this.activePeriodTwo),
      activeCycle: {
        kind: "alternating_batch",
        phase: "complete",
        completedCycles: 2,
      },
    };
  }

  private periodTwoDecision(active: ActivePeriodTwoCycle): LoopDecision {
    const signature = buildSequenceFingerprint([active.firstFingerprint, active.secondFingerprint]);
    if (!signature) return { type: "continue" };
    const toolNames = [...new Set(this.history.slice(-2).flatMap((item) => item.toolNames))];
    return this.toDecision(active.completedCycles, 2, signature, toolNames);
  }

  private countTrailingPeriodOne(): number | null {
    if (this.history.length < 2) return null;
    const fingerprint = this.history.at(-1)?.fingerprint;
    if (!fingerprint) return null;
    let count = 1;
    for (let index = this.history.length - 2; index >= 0; index--) {
      if (this.history[index]?.fingerprint !== fingerprint) break;
      count += 1;
    }
    return count >= 2 ? count : null;
  }

  private toDecision(
    count: number,
    period: 1 | 2,
    signature: string,
    toolNames: string[],
  ): LoopDecision {
    const source = period === 1 ? "repeated_batch" : "alternating_batch";
    if (count >= 4) {
      return { type: "halt", source, count, signature, toolNames, period };
    }
    return {
      type: "warn",
      severity: count >= 3 ? "strong" : "soft",
      source,
      count,
      signature,
      toolNames,
      period,
    };
  }
}
