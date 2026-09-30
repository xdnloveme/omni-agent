import { createAbortError, isAbortError, type AgentToolDefinition } from "@omni-agent/core";

export const outputReadTool: AgentToolDefinition = {
  name: "output_read",
  inputConstraint: "prefer",
  outputReader: true,
  description:
    "Read a saved tool output from this Session without executing the original tool. When a result includes saved output references, use this tool to inspect additional content instead of rerunning the original tool solely to retrieve output. Use outputId and partId from its result. Read bounded pages using offset/limit, or use tail for the last lines. Incomplete records contain only the retained portion. Continue long lines using the returned line_byte_offset and file_version.",
  access: { kind: "internal" },
  execution: { kind: "in_process" },
  timeout: { kind: "none" },
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      outputId: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
      partId: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 2000 },
      tail: { type: "integer", minimum: 1, maximum: 2000 },
      line_byte_offset: { type: "integer", minimum: 0 },
      file_version: { type: "string" },
    },
    required: ["outputId", "partId"],
  },
  async execute(input, context) {
    try {
      if (!context.outputs) throw new Error("Session output access is not configured");
      if (
        input.tail !== undefined &&
        (input.offset !== undefined ||
          input.limit !== undefined ||
          input.line_byte_offset !== undefined)
      )
        throw new Error("tail cannot be combined with pagination parameters");
      if (
        input.line_byte_offset !== undefined &&
        (input.offset === undefined ||
          input.file_version === undefined ||
          (input.limit !== undefined && input.limit !== 1))
      )
        throw new Error(
          "line_byte_offset requires offset, file_version, and limit omitted or equal to 1",
        );
      const request: import("@omni-agent/core").OutputReadRequest = {
        outputId: input.outputId as string,
        partId: input.partId as string,
        offset: input.offset as number | undefined,
        limit: input.line_byte_offset === undefined ? (input.limit as number | undefined) : 1,
        tail: input.tail as number | undefined,
        lineByteOffset: input.line_byte_offset as number | undefined,
        fileVersion: input.file_version as string | undefined,
      };
      const page = await context.outputs.read(request, context.signal);
      const part = page.record.parts.find((part) => part.id === request.partId);
      if (!part) throw new Error("Output part does not exist");
      const range =
        page.pagination.mode === "lines"
          ? `Lines: ${page.pagination.offset}; returned: ${page.pagination.returnedLines}.`
          : `Line: ${page.pagination.lineNumber}; byte offset: ${page.pagination.lineByteOffset}; returned bytes: ${page.pagination.returnedBytes}.`;
      // A successful page read does not imply the original execution output was complete.
      const status = `Output ${page.record.id} (${page.record.state}${page.record.reason ? `: ${page.record.reason}` : ""}). Part: ${part.id} (${part.complete ? "complete" : "incomplete"}; ${part.bytes} retained bytes). ${range}`;
      return {
        content: [
          { type: "text", text: page.text, outputSource: { kind: "page" } },
          { type: "text", text: status, outputSource: { kind: "page" } },
        ],
        isError: false,
        meta: {
          outputRead: { outputId: page.record.id, partId: part.id },
          pagination: page.pagination,
        },
      };
    } catch (error) {
      if (isAbortError(error, context.signal)) throw createAbortError(context.signal);
      return {
        content: [
          { type: "text", text: error instanceof Error ? error.message : "Output read failed" },
        ],
        isError: true,
        meta: { code: "output_read_failed" },
      };
    }
  },
};
