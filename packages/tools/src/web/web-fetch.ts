import * as cheerio from "cheerio";
import { type AgentToolDefinition, type JsonValue, type ToolResult } from "@omni-agent/core";
import { createWebAccess } from "./access/web-access-assessor";
import { truncateUtf8Text } from "../text/utf8";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_MODEL_BYTES = 64 * 1024;

export interface WebFetchResult {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly mimeType: string;
  readonly charset?: string;
  readonly title?: string;
  readonly content: string;
  readonly receivedBytes: number;
  readonly truncated: boolean;
}

export const webFetchTool: AgentToolDefinition = {
  name: "web_fetch",
  access: createWebAccess({ parameter: "url", valueKind: "url" }),
  execution: { kind: "in_process" },
  invocation: { action: "fetch", resource: { kind: "url", inputKey: "url" } },
  timeout: {
    kind: "input",
    parameter: "timeout_ms",
    defaultMs: DEFAULT_TIMEOUT_MS,
    minMs: 100,
    maxMs: 120_000,
  },
  strict: true,
  description:
    "Fetch one authorized HTTP/HTTPS URL with bounded redirects and response sizes. " +
    "Returns structured URL, status, MIME, byte-count, truncation, title, and readable content. " +
    "Binary content such as PDF, images, archives, and executables is rejected.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", minLength: 1, maxLength: 8192 },
      timeout_ms: { type: "integer", minimum: 100, maximum: 120_000 },
    },
    required: ["url"],
  },
  async execute(params, context): Promise<ToolResult> {
    if (!context.network)
      return error("network_runtime_unavailable", "Network runtime unavailable");
    const response = await context.network.request({
      url: params.url as string,
      method: "GET",
      headers: {
        "User-Agent": "OmniAgent/1.0",
        Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.1",
      },
      maxCompressedBytes: MAX_COMPRESSED_BYTES,
      maxDecompressedBytes: MAX_DECOMPRESSED_BYTES,
      signal: context.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      return error("web_http_error", `HTTP ${response.status}`, {
        requestedUrl: response.requestedUrl,
        finalUrl: response.finalUrl,
        status: response.status,
      });
    }
    const header = response.headers["content-type"];
    const contentType = parseContentType(Array.isArray(header) ? header[0] : header);
    if (!isSupported(contentType.mimeType)) {
      return error(
        "web_content_type_unsupported",
        `Unsupported content type: ${contentType.mimeType}`,
      );
    }
    let decoded: string;
    try {
      decoded = new TextDecoder(contentType.charset ?? "utf-8", { fatal: false }).decode(
        response.body,
      );
    } catch {
      return error("web_charset_unsupported", `Unsupported charset: ${contentType.charset}`);
    }
    let title: string | undefined;
    let content: string;
    if (contentType.mimeType === "text/html" || contentType.mimeType === "application/xhtml+xml") {
      const document = cheerio.load(decoded);
      title = normalizeText(document("title").first().text()) || undefined;
      document("script, style, nav, header, footer, aside, noscript, iframe, svg").remove();
      content = normalizeText(document("body").text());
    } else if (isJson(contentType.mimeType)) {
      try {
        content = JSON.stringify(JSON.parse(decoded), null, 2);
      } catch {
        return error("web_json_invalid", "Response declared JSON but contained invalid JSON");
      }
    } else {
      content = decoded;
    }
    const boundedTitle = truncateUtf8Text(title ?? "", 1024);
    const result = boundResult({
      requestedUrl: response.requestedUrl,
      finalUrl: response.finalUrl,
      status: response.status,
      mimeType: contentType.mimeType,
      ...(contentType.charset ? { charset: contentType.charset } : {}),
      ...(title ? { title: boundedTitle.text } : {}),
      content,
      receivedBytes: response.body.byteLength,
      truncated: boundedTitle.truncated,
    });
    if (!result)
      return error("web_metadata_limit_exceeded", "Response metadata exceeds output budget");
    return {
      content: [{ type: "text", text: render(result) }],
      structuredContent: result as unknown as JsonValue,
      isError: false,
      meta: {
        networkCompressedBytes: response.compressedBytes,
        networkDecompressedBytes: response.body.byteLength,
      },
    };
  },
};

function parseContentType(value: string | undefined): { mimeType: string; charset?: string } {
  const [rawMime = "application/octet-stream", ...parameters] = (value ?? "").split(";");
  const mimeType = rawMime.trim().toLowerCase() || "application/octet-stream";
  const charset = parameters
    .map((parameter) => /^\s*charset\s*=\s*["']?([^"';\s]+)["']?\s*$/i.exec(parameter)?.[1])
    .find(Boolean)
    ?.toLowerCase();
  return { mimeType, ...(charset ? { charset } : {}) };
}

function isSupported(mimeType: string): boolean {
  return mimeType.startsWith("text/") || isJson(mimeType) || mimeType === "application/xhtml+xml";
}

function isJson(mimeType: string): boolean {
  return mimeType === "application/json" || mimeType.endsWith("+json");
}

function normalizeText(value: string): string {
  return value
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function boundResult(value: WebFetchResult): WebFetchResult | undefined {
  const bounded = truncateUtf8Text(value.content, MAX_MODEL_BYTES);
  value = { ...value, content: bounded.text, truncated: value.truncated || bounded.truncated };
  // Both projections reach the model. Account for JSON escaping and leave framing room;
  // never truncate the rendered text independently from its structured source.
  const fits = (result: WebFetchResult) =>
    Buffer.byteLength(render(result)) + Buffer.byteLength(JSON.stringify(result)) <=
    MAX_MODEL_BYTES - 256;
  if (fits(value)) return value;
  let result = { ...value, content: "", truncated: true };
  if (!fits(result)) return undefined;
  let low = 0;
  let high = Math.min(Buffer.byteLength(value.content), MAX_MODEL_BYTES);
  while (low < high) {
    const limit = Math.ceil((low + high) / 2);
    const candidate = { ...result, content: truncateUtf8Text(value.content, limit).text };
    if (fits(candidate)) {
      low = limit;
      result = candidate;
    } else high = limit - 1;
  }
  return result;
}

function render(result: WebFetchResult): string {
  return [
    `Requested URL: ${result.requestedUrl}`,
    `Final URL: ${result.finalUrl}`,
    `Status: ${result.status}`,
    `Content-Type: ${result.mimeType}${result.charset ? `; charset=${result.charset}` : ""}`,
    `Received bytes: ${result.receivedBytes}`,
    `Truncated: ${result.truncated}`,
    ...(result.title ? [`Title: ${result.title}`] : []),
    "",
    result.content,
  ].join("\n");
}

function error(code: string, message: string, meta: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true, meta: { code, ...meta } };
}
