import * as cheerio from "cheerio";
import { createAbortError, type AgentToolDefinition, type ToolResult } from "@omni-agent/core";
import { createWebAccess } from "./access/web-access-assessor";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 20_000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (truncated, ${text.length} total chars)`;
}

function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);
  // Remove non-content elements
  $("script, style, nav, header, footer, aside, noscript, iframe, svg").remove();
  // Get text and collapse whitespace
  const text = $("body").text();
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const webFetchTool: AgentToolDefinition = {
  name: "web_fetch",
  access: createWebAccess({
    parameter: "url",
    valueKind: "url",
  }),
  execution: { kind: "in_process" },
  invocation: { action: "fetch", resource: { kind: "url", inputKey: "url" } },
  timeout: { kind: "none" },
  strict: true,
  description:
    "Fetch a URL and return its content as readable text.\n\n" +
    "Usage:\n" +
    "- Use for fetching and reading web page content, documentation, or API responses.\n" +
    "- For HTML pages: extracts main text content (strips scripts, styles, nav, headers, footers).\n" +
    "- For JSON responses: returns formatted JSON.\n" +
    "- For plain text: returns raw content.\n" +
    "- Output is truncated to 20,000 characters — for very long pages, key content may be cut off.\n" +
    "- Default timeout is 10 seconds; increase `timeout_ms` for slow endpoints.\n\n" +
    "When to use:\n" +
    "- Reading documentation pages, blog posts, or articles.\n" +
    "- Fetching API responses or JSON data.\n" +
    "- Checking the content of a URL the user provides.\n\n" +
    "When NOT to use:\n" +
    "- Searching the web for information (use web_search instead).\n" +
    "- Downloading binary files (images, PDFs, archives).",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: {
        type: "string",
        minLength: 1,
        maxLength: 8192,
        description: "The URL to fetch",
      },
      timeout_ms: {
        type: "integer",
        minimum: 100,
        maximum: 120_000,
        description: "Request timeout in milliseconds. Defaults to 10000.",
      },
    },
    required: ["url"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const url = params.url as string;
    if (!url) {
      return {
        content: [{ type: "text", text: "Error: url is required" }],
        isError: true,
      };
    }

    const timeoutMs = Number(params.timeout_ms) || DEFAULT_TIMEOUT_MS;
    const requestTimeoutSignal = AbortSignal.timeout(timeoutMs);

    try {
      const response = await fetch(url, {
        signal: context.signal
          ? AbortSignal.any([context.signal, requestTimeoutSignal])
          : requestTimeoutSignal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; OmniAgent/1.0)",
          Accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
        },
      });

      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Error: HTTP ${response.status} ${response.statusText}`,
            },
          ],
          isError: true,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      let output: string;

      if (contentType.includes("application/json")) {
        const json = await response.json();
        output = JSON.stringify(json, null, 2);
      } else if (contentType.includes("text/html")) {
        const html = await response.text();
        output = extractTextFromHtml(html);
      } else {
        output = await response.text();
      }

      return {
        content: [{ type: "text", text: truncate(output, MAX_OUTPUT_CHARS) }],
        isError: false,
      };
    } catch (err: unknown) {
      if (context.signal?.aborted) throw createAbortError(context.signal);
      let msg: string;
      if (err instanceof Error) {
        if (requestTimeoutSignal.aborted) {
          msg = `Request timed out after ${timeoutMs}ms`;
        } else {
          msg = err.message;
        }
      } else {
        msg = String(err);
      }
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
};
