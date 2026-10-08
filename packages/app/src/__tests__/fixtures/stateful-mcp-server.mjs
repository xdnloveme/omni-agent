import { createInterface } from "node:readline";

// A deliberately small protocol peer: the client under test is the real official SDK.
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "server/discover") {
    result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } };
  } else if (request.method === "tools/list") {
    result = {
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
      tools: [{ name: "counter", inputSchema: { type: "object" } }],
    };
  } else if (request.method === "tools/call") {
    if (request.params.arguments?.wait) continue;
    result = {
      resultType: "complete",
      content: [{ type: "text", text: JSON.stringify({ count: ++count, pid: process.pid }) }],
    };
  } else {
    throw new Error(`Unexpected test request: ${request.method}`);
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
