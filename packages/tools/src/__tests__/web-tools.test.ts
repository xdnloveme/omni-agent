import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webFetchTool } from "../web/web-fetch";
import { webSearchTool } from "../web/web-search";
import { createWebReadPermission } from "../web/permission/web-permission";
import { invokeToolImplementation } from "./tool-test-helper";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeResponse(body: string, options: { status?: number; contentType?: string } = {}) {
  const { status = 200, contentType = "text/html" } = options;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    headers: new Headers({ "content-type": contentType }),
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ─── web_fetch ───────────────────────────────────────────────────────────────

describe("webFetchTool", () => {
  it("classifies HTTP reads and hard-denies unsupported protocols", async () => {
    const descriptor = createWebReadPermission({
      parameter: "url",
      title: "Fetch",
      valueKind: "url",
    });
    if (descriptor.kind !== "dynamic") throw new Error("expected dynamic permission");
    await expect(
      Promise.resolve(descriptor.assess({ url: "https://example.com" }, permissionContext())),
    ).resolves.toMatchObject({
      risk: "external_read",
      enforcement: "policy",
    });
    await expect(
      Promise.resolve(descriptor.assess({ url: "file:///etc/passwd" }, permissionContext())),
    ).resolves.toMatchObject({
      enforcement: "hard_deny",
      ruleIds: ["web.unsupported-protocol"],
    });
  });

  it("should extract text from HTML, stripping scripts and styles", async () => {
    const html = `
      <html>
        <head><style>body { color: red; }</style></head>
        <body>
          <script>alert('hi')</script>
          <nav>Navigation</nav>
          <main><p>Hello World</p></main>
          <footer>Footer content</footer>
        </body>
      </html>
    `;
    mockFetch.mockResolvedValueOnce(makeResponse(html, { contentType: "text/html" }));

    const result = await invokeToolImplementation(webFetchTool, { url: "https://example.com" });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain("Hello World");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("Navigation");
    expect(text).not.toContain("Footer content");
  });

  it("should return JSON content formatted", async () => {
    const json = JSON.stringify({ key: "value", num: 42 });
    mockFetch.mockResolvedValueOnce(makeResponse(json, { contentType: "application/json" }));

    const result = await invokeToolImplementation(webFetchTool, {
      url: "https://api.example.com/data",
    });

    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain('"key": "value"');
    expect(text).toContain('"num": 42');
  });

  it("should return plain text as-is", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("plain text content", { contentType: "text/plain" }),
    );

    const result = await invokeToolImplementation(webFetchTool, {
      url: "https://example.com/file.txt",
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("plain text content");
  });

  it("should return error for non-2xx status", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse("", { status: 404 }));

    const result = await invokeToolImplementation(webFetchTool, {
      url: "https://example.com/missing",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("HTTP 404");
  });

  it("should return error when url is missing", async () => {
    const result = await invokeToolImplementation(webFetchTool, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("url is required");
  });

  it("should truncate output exceeding 20000 chars", async () => {
    const longText = "x".repeat(25000);
    mockFetch.mockResolvedValueOnce(makeResponse(longText, { contentType: "text/plain" }));

    const result = await invokeToolImplementation(webFetchTool, { url: "https://example.com/big" });

    expect(result.isError).toBe(false);
    expect(result.content[0].text.length).toBeLessThan(25000);
    expect(result.content[0].text).toContain("truncated");
  });

  it("should handle network errors gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await invokeToolImplementation(webFetchTool, {
      url: "https://down.example.com",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ECONNREFUSED");
  });

  it("should handle timeout errors", async () => {
    mockFetch.mockImplementationOnce(
      async (_url: string, init: RequestInit) =>
        await new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    const result = await invokeToolImplementation(webFetchTool, {
      url: "https://slow.example.com",
      timeout_ms: 100,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("timed out");
  });

  it("propagates user cancellation instead of reporting a request timeout", async () => {
    mockFetch.mockImplementationOnce(
      async (_url: string, init: RequestInit) =>
        await new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    const pending = invokeToolImplementation(
      webFetchTool,
      { url: "https://slow.example.com" },
      { cwd: process.cwd(), signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

function permissionContext() {
  return {
    cwd: process.cwd(),
    agentId: "test",
    toolIdentity: "test:web_fetch",
    toolCallId: "call-1",
  };
}

// ─── web_search ──────────────────────────────────────────────────────────────

describe("webSearchTool", () => {
  const ddgHtml = `
    <html>
      <body>
        <div class="result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1">Result One</a>
          <a class="result__snippet">This is the first snippet</a>
        </div>
        <div class="result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage2">Result Two</a>
          <a class="result__snippet">This is the second snippet</a>
        </div>
        <div class="result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage3">Result Three</a>
          <a class="result__snippet">This is the third snippet</a>
        </div>
      </body>
    </html>
  `;

  it("should parse DuckDuckGo results correctly", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(ddgHtml, { contentType: "text/html" }));

    const result = await invokeToolImplementation(webSearchTool, { query: "test query" });

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({
      title: "Result One",
      url: "https://example.com/page1",
      snippet: "This is the first snippet",
    });
    expect(parsed[1].title).toBe("Result Two");
    expect(parsed[2].url).toBe("https://example.com/page3");
  });

  it("should respect max_results", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(ddgHtml, { contentType: "text/html" }));

    const result = await invokeToolImplementation(webSearchTool, { query: "test", max_results: 2 });

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
  });

  it("should return error when query is missing", async () => {
    const result = await invokeToolImplementation(webSearchTool, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("query is required");
  });

  it("should handle fetch failure gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await invokeToolImplementation(webSearchTool, { query: "test" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Network error");
  });

  it("should handle non-2xx response from DuckDuckGo", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse("", { status: 503 }));

    const result = await invokeToolImplementation(webSearchTool, { query: "test" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("HTTP 503");
  });

  it("should return message when no results found", async () => {
    const emptyHtml = "<html><body><div class='no-results'>No results</div></body></html>";
    mockFetch.mockResolvedValueOnce(makeResponse(emptyHtml, { contentType: "text/html" }));

    const result = await invokeToolImplementation(webSearchTool, { query: "xyznonexistent" });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("No results found");
  });
});
