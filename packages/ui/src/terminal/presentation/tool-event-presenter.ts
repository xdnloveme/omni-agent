import {
  formatSanitizedToolInput,
  sanitizeSensitiveText,
  type ToolResultPresentationData,
  type ToolResultMetadata,
  type ToolInvocationPreview,
} from "@omni-agent/core";
import type { DisclosureViewModel } from "./view-models";
import { previewResource } from "./tool-preview";
import { formatDuration } from "./format";

const MAX_OUTPUT_CHARS = 50_000;
const MAX_OUTPUT_LINES = 200;

export interface ToolResultView {
  readonly content: readonly import("@omni-agent/core").ToolResultContent[];
  readonly isError: boolean;
  readonly meta?: ToolResultMetadata;
}

export class ToolEventPresenter {
  private readonly calls = new Map<
    string,
    {
      readonly toolName: string;
      readonly input: Record<string, unknown>;
      readonly preview: ToolInvocationPreview;
    }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  waiting(
    toolName: string,
    toolCallId: string,
    preview: ToolInvocationPreview,
  ): DisclosureViewModel {
    return {
      id: `tool:${toolCallId}`,
      title: toolName,
      summary: previewResource(preview),
      state: "waiting",
      tone: "neutral",
      details: () => [],
      initiallyExpanded: false,
    };
  }

  start(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    preview: ToolInvocationPreview,
  ): DisclosureViewModel {
    const ownedInput = structuredClone(input);
    this.calls.set(toolCallId, { toolName, input: ownedInput, preview: structuredClone(preview) });
    return {
      id: `tool:${toolCallId}`,
      title: toolName,
      summary: previewResource(preview),
      state: "running",
      startedAt: this.now(),
      tone: "neutral",
      details: () => toolDetails(ownedInput),
      initiallyExpanded: false,
    };
  }

  complete(
    toolCallId: string,
    result: ToolResultView,
    durationMs: number,
  ): DisclosureViewModel | null {
    const call = this.calls.get(toolCallId);
    if (!call) return null;
    this.calls.delete(toolCallId);
    const ownedResult = structuredClone(result);
    return completedToolView(toolCallId, call, ownedResult, durationMs);
  }

  restore(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    preview: ToolInvocationPreview,
    result?: ToolResultView,
  ): DisclosureViewModel {
    const call = {
      toolName,
      input: structuredClone(input),
      preview: structuredClone(preview),
    };
    if (!result) {
      return {
        id: `tool:${toolCallId}`,
        title: toolName,
        summary: previewResource(preview),
        state: "cancelled",
        tone: "warning",
        details: () => [...toolDetails(call.input), "reason: result missing"],
        initiallyExpanded: false,
      };
    }
    return {
      ...completedToolView(toolCallId, call, structuredClone(result)),
      initiallyExpanded: false,
    };
  }

  cancelPending(): readonly DisclosureViewModel[] {
    const cancelled = [...this.calls.entries()].map(([toolCallId, call]) => ({
      id: `tool:${toolCallId}`,
      title: call.toolName,
      summary: previewResource(call.preview),
      state: "cancelled" as const,
      tone: "warning" as const,
      details: () => [...toolDetails(call.input), "reason: run cancelled"],
      initiallyExpanded: false,
    }));
    this.calls.clear();
    return cancelled;
  }
}

function resourcePath(presentation: ToolResultPresentationData | undefined): string | undefined {
  const resource = presentation?.resource;
  return resource?.kind === "file" && resource.path
    ? sanitizeSensitiveText(resource.path, 4_096)
    : undefined;
}

function toolDetails(input: Record<string, unknown>): readonly string[] {
  return inputDetailLines(input);
}

function completedToolDetails(
  input: Record<string, unknown>,
  result: ToolResultView,
  durationMs?: number,
): readonly string[] {
  const lines = [
    ...(durationMs === undefined ? [] : [`duration: ${formatDuration(durationMs)}`]),
    ...metadataLines(result.meta),
  ];
  lines.push(...inputDetailLines(input));
  const output = collectOutput(result);
  lines.push(output ? "output:" : "(no text output)");
  if (output) lines.push(...output.split("\n").map((line) => `  ${line}`));
  return lines;
}

function completedToolView(
  toolCallId: string,
  call: {
    readonly toolName: string;
    readonly input: Record<string, unknown>;
    readonly preview: ToolInvocationPreview;
  },
  result: ToolResultView,
  durationMs?: number,
): DisclosureViewModel {
  const path = resourcePath(result.meta?.presentation);
  const resource = path ?? previewResource(call.preview);
  const summary = [resource, durationMs === undefined ? undefined : formatDuration(durationMs)]
    .filter(Boolean)
    .join(" · ");
  return {
    id: `tool:${toolCallId}`,
    title: call.toolName,
    ...(summary ? { summary } : {}),
    state: result.isError ? "failed" : "completed",
    tone: result.isError ? "error" : "success",
    details: () => completedToolDetails(call.input, result, durationMs),
    initiallyExpanded: result.isError,
  };
}

function inputDetailLines(input: Record<string, unknown>): string[] {
  const oldText = typeof input.old_string === "string" ? input.old_string : undefined;
  const newText = typeof input.new_string === "string" ? input.new_string : undefined;
  const content = typeof input.content === "string" ? input.content : undefined;
  if (oldText !== undefined || newText !== undefined) {
    return [
      "old:",
      ...previewLines(oldText ?? "").map((line) => `  ${line}`),
      "new:",
      ...previewLines(newText ?? "").map((line) => `  ${line}`),
    ];
  }
  if (content !== undefined) {
    return ["content preview:", ...previewLines(content).map((line) => `  ${line}`)];
  }
  return [`input: ${formatSanitizedToolInput(input)}`];
}

function previewLines(value: string): string[] {
  const maximumCharacters = 2_000;
  const maximumLines = 40;
  const clipped = sanitizeSensitiveText(value.slice(0, maximumCharacters), maximumCharacters);
  const allLines = clipped.split("\n");
  const lines = allLines.slice(0, maximumLines);
  const omittedLines = Math.max(0, allLines.length - lines.length);
  const omittedCharacters = Math.max(0, value.length - maximumCharacters);
  if (omittedLines || omittedCharacters) {
    lines.push(
      `… truncated${omittedLines ? ` (${omittedLines} lines)` : ""}${
        omittedCharacters ? ` (${omittedCharacters.toLocaleString()} characters)` : ""
      }`,
    );
  }
  return lines;
}

function metadataLines(meta: ToolResultMetadata | undefined): string[] {
  if (!meta) return [];
  const lines: string[] = [];
  const path = resourcePath(meta.presentation);
  if (path) lines.push(`path: ${path}`);
  if (isRecord(meta.pagination)) {
    const start = numberValue(meta.pagination, "startLine");
    const end = numberValue(meta.pagination, "endLine");
    if (start !== undefined && end !== undefined) lines.push(`range: lines ${start}–${end}`);
    const version = stringValue(meta.pagination, "fileVersion");
    if (version) lines.push(`version: ${version}`);
  }
  const line = numberValue(meta, "line");
  if (line !== undefined) lines.push(`matched line: ${line}`);
  const added = numberValue(meta, "addedLines");
  const removed = numberValue(meta, "removedLines");
  if (added !== undefined || removed !== undefined) {
    lines.push(`change: +${added ?? 0} / -${removed ?? 0} lines`);
  }
  const bytes = numberValue(meta, "bytesWritten");
  if (bytes !== undefined) lines.push(`bytes written: ${bytes.toLocaleString()}`);
  return lines;
}

function collectOutput(result: ToolResultView): string {
  const complete = result.content.map(renderContentBlock).filter(Boolean).join("\n");
  const clippedChars = sanitizeSensitiveText(complete.slice(0, MAX_OUTPUT_CHARS), MAX_OUTPUT_CHARS);
  const allLines = clippedChars.split("\n");
  const lines = allLines.slice(0, MAX_OUTPUT_LINES);
  const omittedLines = Math.max(0, allLines.length - lines.length);
  const omittedChars = Math.max(0, complete.length - MAX_OUTPUT_CHARS);
  if (omittedLines || omittedChars) {
    lines.push(
      `… truncated${omittedLines ? ` (${omittedLines} lines)` : ""}${
        omittedChars ? ` (${omittedChars.toLocaleString()} characters)` : ""
      }`,
    );
  }
  return lines.join("\n");
}

function renderContentBlock(block: ToolResultView["content"][number]): string {
  if (block.type === "text") return block.text;
  if (block.type === "image" || block.type === "audio") return `[${block.type}: ${block.mimeType}]`;
  if (block.type === "resource_link") return `[resource: ${block.name} ${block.uri}]`;
  return `[embedded resource: ${block.resource.uri}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
}

function stringValue(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}
