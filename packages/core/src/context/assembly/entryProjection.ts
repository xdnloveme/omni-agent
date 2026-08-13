import type { ModelContextMessage, TranscriptMessage } from "../../messages";
import type { ContextEntry } from "../contracts/types";
import { toContextMessages } from "./messageProjection";

export function projectContextEntries(entries: readonly ContextEntry[]): ModelContextMessage[] {
  const output: ModelContextMessage[] = [];
  for (const entry of entries) {
    if (entry.kind === "checkpoint") {
      output.push({ role: "user", content: checkpointContent(entry) });
      continue;
    }
    const message: TranscriptMessage =
      entry.kind === "transcript"
        ? entry.message
        : {
            ...entry.message,
            content: [
              {
                type: "text",
                text: [
                  `[Tool result content externalized: ${entry.artifact.id}]`,
                  `Path: ${entry.artifact.path}`,
                  `Original length: ${entry.artifact.originalLength} characters`,
                  `SHA-256: ${entry.artifact.contentDigest}`,
                  "Use file_read on the path when the complete result is needed.",
                ].join("\n"),
              },
            ],
          };
    output.push(...toContextMessages([message]));
  }
  return output;
}

function checkpointContent(entry: Extract<ContextEntry, { kind: "checkpoint" }>): string {
  const parent = entry.parentId ? ` parent_id="${entry.parentId}"` : "";
  return [
    `<context_checkpoint checkpoint_id="${entry.checkpointId}"${parent} covered_message_count="${entry.coveredMessageCount}" prompt_version="${entry.promptVersion}">`,
    entry.summary,
    "</context_checkpoint>",
  ].join("\n");
}
