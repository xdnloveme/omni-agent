import type { ToolResult } from "../types";
import type { SensitiveValueSet } from "../security";

export interface OutputPart {
  /** Display-only description; never used as identity. Older records may omit it. */
  readonly label?: string;
  readonly id: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly observedBytes: number;
  readonly complete: boolean;
  readonly sha256: string;
}

export interface OutputRecord {
  readonly version: 1;
  readonly id: string;
  readonly toolCallId: string;
  readonly state: "complete" | "interrupted" | "incomplete";
  readonly reason?:
    "limit" | "persistence_error" | "interrupted" | "abandoned" | "unsupported_content";
  readonly parts: readonly OutputPart[];
}

/** Logical identity only; display metadata is never validation input. */
export interface OutputReference {
  readonly outputId: string;
  readonly partId?: string;
}

export interface OutputReadRequest extends OutputReference {
  readonly partId: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly lineByteOffset?: number;
  readonly fileVersion?: string;
  readonly tail?: number;
}

export interface OutputReadResult {
  readonly text: string;
  readonly record: OutputRecord;
  readonly pagination: import("../io/text-page-reader").FilePagination;
}

/** A capability bound to one part; its parent writer owns all lifecycle state. */
export interface OutputPartWriterPort {
  readonly id: string;
  append(text: string, signal?: AbortSignal): Promise<void>;
}

export interface OutputWriterPort {
  readonly id: string;
  createPart(
    options: { label: string; mediaType: string },
    signal?: AbortSignal,
  ): Promise<OutputPartWriterPort>;
  finish(options?: {
    signal?: AbortSignal;
    interrupted?: boolean;
    failure?: "persistence_error" | "unsupported_content";
  }): Promise<OutputRecord>;
}

/** Immutable Session binding; callers cannot select another session or a filesystem path. */
export interface SessionOutputPort {
  readonly previewBytes: number;
  create(toolCallId: string, signal?: AbortSignal): Promise<OutputWriterPort>;
  read(request: OutputReadRequest, signal?: AbortSignal): Promise<OutputReadResult>;
  resolve(reference: OutputReference, signal?: AbortSignal): Promise<OutputRecord>;
}

export interface OutputCallContext {
  readonly session: SessionOutputPort;
  readonly toolCallId: string;
  readonly sensitive?: SensitiveValueSet;
  readonly signal?: AbortSignal;
  writer?: OutputWriterPort;
  failed?: boolean;
  unsupportedContent?: boolean;
  interrupted?: boolean;
}

/** Runtime-only provenance; final OutputRecord is the sole persisted capture fact. */
export interface CapturedOutputSource {
  readonly outputId: string;
  readonly partIds: readonly string[];
}

/** Runtime-only content classification, consumed before transcript projection. */
export type ToolOutputSource = CapturedOutputSource | { readonly kind: "page" };

export function outputFailure(result: ToolResult): ToolResult {
  return {
    ...result,
    meta: { ...result.meta, outputPersistence: "failed" },
    content: [
      ...result.content,
      {
        type: "text",
        text: "Output retention failed. Do not assume this result's previews have complete saved output.",
      },
    ],
  };
}
