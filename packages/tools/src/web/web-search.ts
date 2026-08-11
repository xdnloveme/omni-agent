import * as cheerio from "cheerio";
import type { AgentToolDefinition, ToolResult } from "@omni-agent/core";
import { createWebReadPermission } from "./permission/web-permission";

const DEFAULT_MAX_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 15_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  $(".result, .web-result").each((_i, el) => {
    if (results.length >= maxResults) return false;

    const $el = $(el);
    const linkEl = $el.find(".result__a");
    const snippetEl = $el.find(".result__snippet");

    const title = linkEl.text().trim();
    let url = linkEl.attr("href") || "";
    const snippet = snippetEl.text().trim();

    // DuckDuckGo wraps URLs in a redirect — extract the actual URL
    if (url.includes("uddg=")) {
      try {
        const parsed = new URL(url, "https://duckduckgo.com");
        url = decodeURIComponent(parsed.searchParams.get("uddg") || url);
      } catch {
        // keep original url
      }
    }

    if (title && url) {
      results.push({ title, url, snippet });
    }
  });

  return results;
}

export const webSearchTool: AgentToolDefinition = {
  name: "web_search",
  authorization: createWebReadPermission({
    parameter: "query",
    title: "Search the web",
    valueKind: "text",
  }),
  execution: { kind: "host" },
  strict: true,
  description:
    "Search the web for current information using DuckDuckGo.\n\n" +
    "Usage:\n" +
    "- Use when you need up-to-date information not available in the local codebase.\n" +
    "- Returns an array of results, each with `title`, `url`, and `snippet`.\n" +
    "- No API key required — uses DuckDuckGo HTML search.\n" +
    "- Default returns 5 results; adjust with `max_results`.\n\n" +
    "When to use:\n" +
    "- Looking up library documentation, APIs, or error messages.\n" +
    "- Finding current best practices or solutions to problems.\n" +
    "- Verifying package names, versions, or installation instructions.\n\n" +
    "When NOT to use:\n" +
    "- Reading a specific URL you already have (use web_fetch instead).\n" +
    "- Searching local file contents (use grep instead).",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "The search query",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of results to return. Defaults to 5.",
      },
    },
    required: ["query"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const query = params.query as string;
    if (!query) {
      return {
        content: [{ type: "text", text: "Error: query is required" }],
        isError: true,
      };
    }

    const maxResults = Number(params.max_results) || DEFAULT_MAX_RESULTS;
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    try {
      const response = await fetch(searchUrl, {
        signal: context.signal
          ? AbortSignal.any([context.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])
          : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Search request failed with HTTP ${response.status}`,
            },
          ],
          isError: true,
        };
      }

      const html = await response.text();
      const results = parseDuckDuckGoResults(html, maxResults);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No results found for the given query." }],
          isError: false,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        isError: false,
      };
    } catch (err: unknown) {
      let msg: string;
      if (err instanceof Error) {
        if (err.name === "TimeoutError" || err.name === "AbortError") {
          msg = `Search request timed out`;
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
