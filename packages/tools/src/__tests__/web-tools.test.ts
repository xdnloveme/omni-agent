import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolDefinition, NetworkResponse } from "@omni-agent/core";
import { webFetchTool } from "../web/web-fetch";
import { webSearchTool } from "../web/web-search";
import { invokeToolImplementation } from "./tool-test-helper";

const request = vi.fn();

beforeEach(() => request.mockReset());

function response(
  body: string,
  options: { status?: number; contentType?: string } = {},
): NetworkResponse {
  return {
    requestedUrl: "https://example.com/requested",
    finalUrl: "https://example.com/final",
    status: options.status ?? 200,
    headers: { "content-type": options.contentType ?? "text/html; charset=utf-8" },
    body: Buffer.from(body),
    compressedBytes: Buffer.byteLength(body),
    redirectCount: 0,
  };
}

function invoke(tool: AgentToolDefinition, input: Record<string, unknown>) {
  return invokeToolImplementation(tool, input, {
    cwd: process.cwd(),
    network: { request, requestStream: vi.fn() },
  });
}

describe("webFetchTool", () => {
  it("extracts safe HTML text and exposes navigation facts in both projections", async () => {
    request.mockResolvedValueOnce(
      response("<title>Example</title><script>bad()</script><main>Hello World</main>"),
    );
    const result = await invoke(webFetchTool, { url: "https://example.com" });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain("Requested URL: https://example.com/requested");
    expect(result.content[0]?.text).toContain("Hello World");
    expect(result.content[0]?.text).not.toContain("bad()");
    expect(result.structuredContent).toMatchObject({
      finalUrl: "https://example.com/final",
      title: "Example",
      truncated: false,
    });
  });

  it("formats valid JSON and rejects invalid declared JSON", async () => {
    request.mockResolvedValueOnce(response('{"key":"value"}', { contentType: "application/json" }));
    await expect(invoke(webFetchTool, { url: "https://example.com/data" })).resolves.toMatchObject({
      isError: false,
      structuredContent: { content: expect.stringContaining('"key": "value"') },
    });

    request.mockResolvedValueOnce(response("not-json", { contentType: "application/json" }));
    await expect(invoke(webFetchTool, { url: "https://example.com/data" })).resolves.toMatchObject({
      isError: true,
      meta: { code: "web_json_invalid" },
    });
  });

  it("rejects binary responses without decoding them as text", async () => {
    request.mockResolvedValueOnce(response("%PDF", { contentType: "application/pdf" }));
    await expect(
      invoke(webFetchTool, { url: "https://example.com/report.pdf" }),
    ).resolves.toMatchObject({ isError: true, meta: { code: "web_content_type_unsupported" } });
  });

  it("uses schema-bound deadline policy and bounded gateway sizes", async () => {
    request.mockResolvedValueOnce(response("ok", { contentType: "text/plain" }));
    await invoke(webFetchTool, { url: "https://example.com", timeout_ms: 250 });
    expect(webFetchTool.timeout).toEqual({
      kind: "input",
      parameter: "timeout_ms",
      defaultMs: 10_000,
      minMs: 100,
      maxMs: 120_000,
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        maxCompressedBytes: 8 * 1024 * 1024,
        maxDecompressedBytes: 16 * 1024 * 1024,
      }),
    );
  });

  it("returns a structured HTTP error", async () => {
    request.mockResolvedValueOnce(response("", { status: 404 }));
    await expect(
      invoke(webFetchTool, { url: "https://example.com/missing" }),
    ).resolves.toMatchObject({
      isError: true,
      meta: { code: "web_http_error", status: 404 },
    });
  });

  it.each(["plain", "large-title", "escaped-json"])(
    "bounds both output projections for %s",
    async (kind) => {
      const body =
        kind === "plain"
          ? "x".repeat(80 * 1024)
          : kind === "large-title"
            ? `<title>${"标".repeat(80 * 1024)}</title><body>BODY_SENTINEL</body>`
            : JSON.stringify({ text: '\\"'.repeat(80 * 1024) });
      request.mockResolvedValueOnce(
        response(body, {
          contentType:
            kind === "plain"
              ? "text/plain"
              : kind === "escaped-json"
                ? "application/json"
                : "text/html",
        }),
      );
      const result = await invoke(webFetchTool, { url: "https://example.com/large" });
      expect(
        Buffer.byteLength(result.content[0]?.text ?? "") +
          Buffer.byteLength(JSON.stringify(result.structuredContent)),
      ).toBeLessThanOrEqual(64 * 1024 - 256);
      expect(result.structuredContent).toMatchObject({ truncated: true });
      if (kind === "large-title") expect(result.content[0]?.text).toContain("BODY_SENTINEL");
      expect(result.content[0]?.text).not.toContain("\uFFFD");
    },
  );
});

describe("webSearchTool", () => {
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">One</a>
      <span class="result__snippet">First</span>
    </div>
    <div class="result">
      <a class="result__a" href="https://example.com/two">Two</a>
      <span class="result__snippet">Second</span>
    </div>`;

  it("returns ranked, provider-tagged structured results", async () => {
    request.mockResolvedValueOnce(response(html));
    const result = await invoke(webSearchTool, { query: "test" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual([
      {
        rank: 1,
        title: "One",
        url: "https://example.com/one",
        snippet: "First",
        provider: "duckduckgo",
      },
      {
        rank: 2,
        title: "Two",
        url: "https://example.com/two",
        snippet: "Second",
        provider: "duckduckgo",
      },
    ]);
  });

  it("distinguishes no results and HTTP failure", async () => {
    request.mockResolvedValueOnce(response("<div>No results</div>"));
    await expect(invoke(webSearchTool, { query: "none" })).resolves.toMatchObject({
      isError: false,
      meta: { code: "web_search_no_results" },
    });

    request.mockResolvedValueOnce(response("", { status: 503 }));
    await expect(invoke(webSearchTool, { query: "error" })).resolves.toMatchObject({
      isError: true,
      meta: { code: "web_search_http_error" },
    });
  });

  it("distinguishes transport failure from unrecognized provider markup", async () => {
    request.mockRejectedValueOnce(new Error("socket failed"));
    await expect(invoke(webSearchTool, { query: "transport" })).resolves.toMatchObject({
      isError: true,
      meta: { code: "web_search_transport_error" },
    });

    request.mockResolvedValueOnce(response("<main>provider layout changed</main>"));
    await expect(invoke(webSearchTool, { query: "parser" })).resolves.toMatchObject({
      isError: true,
      meta: { code: "web_search_parser_error" },
    });
  });

  it("uses the fixed timeout and does not imply result URL authorization", () => {
    expect(webSearchTool.timeout).toEqual({ kind: "fixed", timeoutMs: 15_000 });
    expect(webSearchTool.description).toContain("not automatically authorized");
  });
});
