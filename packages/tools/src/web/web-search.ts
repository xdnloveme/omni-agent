import * as cheerio from "cheerio";
import { type AgentToolDefinition, type JsonValue, type ToolResult } from "@omni-agent/core";
import { createWebAccess } from "./access/web-access-assessor";

const DEFAULT_MAX_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_URL = "https://html.duckduckgo.com/html/";

export interface WebSearchResult {
  readonly rank: number;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly provider: "duckduckgo";
}

export const webSearchTool: AgentToolDefinition = {
  name: "web_search",
  access: createWebAccess({ parameter: "query", valueKind: "text" }),
  execution: { kind: "in_process" },
  invocation: { action: "search", resource: { kind: "text", inputKey: "query" } },
  timeout: { kind: "fixed", timeoutMs: SEARCH_TIMEOUT_MS },
  strict: true,
  description:
    "Search current public web pages through the fixed DuckDuckGo HTML endpoint. " +
    "Returns ranked title, URL, snippet, and provider fields. Result URLs are not automatically authorized for web_fetch.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 1, maxLength: 4096 },
      max_results: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["query"],
  },
  async execute(params, context): Promise<ToolResult> {
    if (!context.network)
      return error("network_runtime_unavailable", "Network runtime unavailable");
    const maxResults = Number(params.max_results) || DEFAULT_MAX_RESULTS;
    const url = `${SEARCH_URL}?q=${encodeURIComponent(params.query as string)}`;
    let response;
    try {
      response = await context.network.request({
        url,
        method: "GET",
        headers: { "User-Agent": "OmniAgent/1.0", Accept: "text/html" },
        maxCompressedBytes: 2 * 1024 * 1024,
        maxDecompressedBytes: 4 * 1024 * 1024,
        signal: context.signal,
      });
    } catch (cause) {
      if (context.signal?.aborted) throw cause;
      return error("web_search_transport_error", "Search request could not reach DuckDuckGo");
    }
    if (response.status < 200 || response.status >= 300) {
      return error("web_search_http_error", `Search request failed with HTTP ${response.status}`);
    }
    let results: WebSearchResult[];
    try {
      const html = new TextDecoder().decode(response.body);
      results = parseDuckDuckGoResults(html, maxResults);
      if (results.length === 0 && !isNoResultsDocument(html)) {
        throw new Error("DuckDuckGo result selectors were not present");
      }
    } catch {
      return error("web_search_parser_error", "DuckDuckGo response could not be parsed");
    }
    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No results found for the given query." }],
        structuredContent: [],
        isError: false,
        meta: { code: "web_search_no_results", provider: "duckduckgo" },
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      structuredContent: results as unknown as JsonValue,
      isError: false,
      meta: {
        networkCompressedBytes: response.compressedBytes,
        networkDecompressedBytes: response.body.byteLength,
      },
    };
  },
};

function parseDuckDuckGoResults(html: string, maxResults: number): WebSearchResult[] {
  const document = cheerio.load(html);
  const results: WebSearchResult[] = [];
  document(".result, .web-result").each((_index, element) => {
    if (results.length >= maxResults) return false;
    const item = document(element);
    const link = item.find(".result__a").first();
    const title = link.text().trim();
    const rawUrl = link.attr("href") ?? "";
    const snippet = item.find(".result__snippet").first().text().trim();
    const url = unwrapDuckDuckGoUrl(rawUrl);
    if (title && url) {
      results.push({ rank: results.length + 1, title, url, snippet, provider: "duckduckgo" });
    }
  });
  return results;
}

function isNoResultsDocument(html: string): boolean {
  const document = cheerio.load(html);
  if (document(".no-results, .result--no-result").length > 0) return true;
  return /\bno results\b/i.test(document("body").text());
}

function unwrapDuckDuckGoUrl(value: string): string {
  if (!value.includes("uddg=")) return value;
  const parsed = new URL(value, "https://duckduckgo.com");
  return parsed.searchParams.get("uddg") ?? value;
}

function error(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true, meta: { code } };
}
