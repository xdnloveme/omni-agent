import chalk from "chalk";
import { SkillReadStatus, type SkillSource } from "@omni-agent/core";

export interface SkillRenderSink {
  line(text?: string): void;
  spacer(): void;
}

export interface ExplicitSkillReadRenderEvent {
  skillName: string;
  status: "loaded" | "cached" | "failed";
  source?: SkillSource;
  filePath?: string;
  tokenEstimate?: number;
  durationMs?: number;
  error?: string;
}

export type SkillReadRenderEvent = ExplicitSkillReadRenderEvent;

export function renderSkillReadStart(sink: SkillRenderSink, skillName: string): void {
  sink.line(
    `${chalk.magenta("◇")} ${chalk.bold("Reading skill")} ${chalk.cyan(skillName || "(unknown)")}`,
  );
}

export function renderSkillReadEnd(
  sink: SkillRenderSink,
  event: SkillReadRenderEvent,
  mode: "inferred" | "explicit" = "inferred",
): void {
  const status =
    event.status === SkillReadStatus.Failed
      ? chalk.red(SkillReadStatus.Failed)
      : event.status === SkillReadStatus.Cached
        ? chalk.yellow(SkillReadStatus.Cached)
        : chalk.green(SkillReadStatus.Loaded);
  const pieces = [
    mode === "explicit" ? chalk.dim("explicit") : null,
    sourceLabel(event.source),
    status,
    typeof event.tokenEstimate === "number"
      ? chalk.dim(`${event.tokenEstimate.toLocaleString()} tokens`)
      : null,
    typeof event.durationMs === "number" ? chalk.dim(`${event.durationMs}ms`) : null,
  ].filter((piece): piece is string => Boolean(piece));

  sink.line(`  ${pieces.join(chalk.dim(" · "))}`);
  if (event.status === SkillReadStatus.Failed && event.error) {
    sink.line(`  ${chalk.red(event.error)}`);
  }
  sink.spacer();
}

function sourceLabel(source: unknown): string | null {
  if (!source || typeof source !== "object") return null;
  const scope = (source as { scope?: unknown }).scope;
  return typeof scope === "string" ? chalk.dim(scope) : null;
}
