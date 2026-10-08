import http from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { NetworkCapability } from "@omni-agent/core";
import { NetworkGateway } from "../gateway";
import { openCapabilityProxy } from "../proxy";
import { assertNetworkAddress, resolveNetworkAddresses } from "../resolver";
import { DefaultNetworkRuntime } from "../runtime";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function upstream(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  return address.port;
}

function fixtureGateway(): NetworkGateway {
  return new NetworkGateway(async () => [{ address: "127.0.0.1", family: 4 }]);
}

function capability(port: number): NetworkCapability {
  return {
    targets: [{ scheme: "http", host: "fixture.test", port }],
    purpose: "network integration test",
  };
}

describe("NetworkGateway", () => {
  it("returns a bounded stream before an SSE-style response ends", async () => {
    let finish!: () => void;
    const port = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      finish = () => response.end("data: second\n\n");
    });
    const response = await fixtureGateway()
      .client(capability(port), "controlled")
      .requestStream({
        url: `http://fixture.test:${port}/events`,
        method: "GET",
        maxCompressedBytes: 1024,
        maxDecompressedBytes: 1024,
      });
    finish();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      chunks.push(value.value);
    }
    expect(Buffer.concat(chunks).toString()).toContain("data: second");
  });

  it("pins the authorized target and serves bounded local synthetic responses", async () => {
    const port = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end("fixture");
    });
    const gateway = fixtureGateway();
    const result = await gateway.client(capability(port), "controlled").request({
      url: `http://fixture.test:${port}/data`,
      method: "GET",
      maxCompressedBytes: 1024,
      maxDecompressedBytes: 1024,
    });
    expect(new TextDecoder().decode(result.body)).toBe("fixture");
    await expect(
      gateway.client(capability(port), "controlled").request({
        url: `http://other.test:${port}/data`,
        method: "GET",
        maxCompressedBytes: 1024,
        maxDecompressedBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "network_target_not_authorized" });
  });

  it.each(["controlled", "autonomous", "unrestricted"] as const)(
    "rejects cross-origin redirects without forwarding credentials in %s",
    async (mode) => {
      const port = await upstream((_request, response) => {
        response.writeHead(302, { location: "https://other.test/next" }).end();
      });
      await expect(
        fixtureGateway()
          .client(capability(port), mode)
          .request({
            url: `http://fixture.test:${port}/redirect`,
            method: "GET",
            maxCompressedBytes: 1024,
            maxDecompressedBytes: 1024,
          }),
      ).rejects.toMatchObject({ code: "network_redirect_not_authorized" });
    },
  );

  it("allows local services in production while keeping metadata sensitive", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "::1", "fe80::1"])
      expect(() => assertNetworkAddress(address, "controlled")).not.toThrow();
    for (const address of ["169.254.169.254", "::ffff:a9fe:a9fe", "fd00:ec2::254"]) {
      expect(() => assertNetworkAddress(address, "autonomous")).toThrowError(
        expect.objectContaining({ code: "network_metadata_denied" }),
      );
      expect(() => assertNetworkAddress(address, "unrestricted")).not.toThrow();
    }
    expect(await resolveNetworkAddresses("[::1]")).toEqual([{ address: "::1", family: 6 }]);
    const port = await upstream((_request, response) => response.end("local"));
    const local = {
      ...capability(port),
      targets: [{ scheme: "http" as const, host: "127.0.0.1", port }],
    };
    const result = await new NetworkGateway().client(local, "controlled").request({
      url: "http://127.0.0.1:" + port,
      method: "GET",
      maxCompressedBytes: 1024,
      maxDecompressedBytes: 1024,
    });
    expect(Buffer.from(result.body).toString()).toBe("local");
  });

  it.each(["controlled", "autonomous"] as const)(
    "checks targets internally in %s mode",
    async (mode) => {
      const port = await upstream((_request, response) => response.end("local"));
      await expect(
        new NetworkGateway().client(capability(port), mode).request({
          url: "http://127.0.0.1:" + port,
          method: "GET",
          maxCompressedBytes: 1024,
          maxDecompressedBytes: 1024,
        }),
      ).rejects.toMatchObject({ code: "network_target_not_authorized" });
    },
  );

  it("does not impose target grants in unrestricted mode", async () => {
    const port = await upstream((_request, response) => response.end("local"));
    await expect(
      new NetworkGateway().client(capability(port), "unrestricted").request({
        url: "http://127.0.0.1:" + port,
        method: "GET",
        maxCompressedBytes: 1024,
        maxDecompressedBytes: 1024,
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it.each(["request", "requestStream"] as const)(
    "propagates malformed gzip through %s",
    async (method) => {
      const port = await upstream((_request, response) => {
        response.writeHead(200, { "content-encoding": "gzip" }).end("not gzip");
      });
      const consume = async () => {
        const response = await fixtureGateway()
          .client(capability(port), "controlled")
          [method]({
            url: "http://fixture.test:" + port,
            method: "GET",
            maxCompressedBytes: 1024,
            maxDecompressedBytes: 1024,
          });
        if (response.body instanceof ReadableStream)
          await new Response(response.body).arrayBuffer();
      };
      await expect(consume()).rejects.toMatchObject({ code: "Z_DATA_ERROR" });
    },
  );

  it.each(["compressed", "decompressed"] as const)(
    "enforces the %s limit through the shared pipeline",
    async (kind) => {
      const body = gzipSync("x".repeat(4096));
      const port = await upstream((_request, response) =>
        response.writeHead(200, { "content-encoding": "gzip" }).end(body),
      );
      await expect(
        fixtureGateway()
          .client(capability(port), "controlled")
          .request({
            url: "http://fixture.test:" + port,
            method: "GET",
            maxCompressedBytes: kind === "compressed" ? 1 : 1024,
            maxDecompressedBytes: kind === "decompressed" ? 100 : 8192,
          }),
      ).rejects.toMatchObject({ code: "network_" + kind + "_limit" });
    },
  );

  it.each(["cancel", "abort"] as const)(
    "tears down the upstream when a stream consumer chooses %s",
    async (action) => {
      let closed!: () => void;
      const upstreamClosed = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const port = await upstream((_request, response) => {
        response.once("close", closed);
        response.write("first");
      });
      const abort = new AbortController();
      const response = await fixtureGateway()
        .client(capability(port), "controlled")
        .requestStream({
          url: "http://fixture.test:" + port,
          method: "GET",
          maxCompressedBytes: 1024,
          maxDecompressedBytes: 1024,
          signal: abort.signal,
        });
      const reader = response.body.getReader();
      await reader.read();
      if (action === "cancel") await reader.cancel();
      else {
        abort.abort();
        await expect(reader.read()).rejects.toBeDefined();
      }
      await upstreamClosed;
    },
  );
});

describe("authenticated capability proxy", () => {
  it("forwards HTTP methods and bodies while rejecting oversized uploads before dispatch", async () => {
    const received: string[] = [];
    const port = await upstream(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const value = `${request.method}:${Buffer.concat(chunks).toString()}`;
      received.push(value);
      if (request.method === "HEAD") response.setHeader("content-encoding", "gzip");
      response.end(value);
    });
    const lease = await openCapabilityProxy(fixtureGateway(), capability(port));
    const proxy = new URL(lease.route.url);
    const target = `http://fixture.test:${port}/api`;
    try {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
        const body = method === "HEAD" ? undefined : "local payload";
        await expect(proxyRequest(proxy, target, { method, body })).resolves.toBe(
          method === "HEAD" ? "" : `${method}:${body}`,
        );
      }
      await expect(
        proxyRequest(proxy, target, { method: "DELETE", body: "chunked payload", chunked: true }),
      ).resolves.toBe("DELETE:chunked payload");
      await expect(
        proxyRequest(proxy, target, { method: "POST", body: Buffer.alloc(8 * 1024 * 1024 + 1) }),
      ).rejects.toMatchObject({ status: 413 });
      await expect(
        proxyRequest(proxy, `http://other.test:${port}`, { method: "POST", body: "denied" }),
      ).rejects.toMatchObject({ status: 403 });
      expect(received).toEqual([
        "POST:local payload",
        "PUT:local payload",
        "PATCH:local payload",
        "DELETE:local payload",
        "OPTIONS:local payload",
        "HEAD:",
        "DELETE:chunked payload",
      ]);
    } finally {
      await lease.close();
    }
  });

  it("preserves separate cookies and decoded response framing through the proxy", async () => {
    const text = "hello proxy ".repeat(100);
    const body = gzipSync(text);
    const cookies = [
      "session=one; Path=/; HttpOnly; Expires=Wed, 09 Jun 2027 10:18:14 GMT",
      "csrf=two; Path=/; SameSite=Lax",
    ];
    const port = await upstream((_request, response) => {
      response
        .writeHead(200, {
          "content-encoding": "gzip",
          "content-length": body.length,
          "set-cookie": cookies,
        })
        .end(body);
    });
    const lease = await openCapabilityProxy(fixtureGateway(), capability(port));
    try {
      let headers: http.IncomingHttpHeaders | undefined;
      await expect(
        proxyRequest(new URL(lease.route.url), "http://fixture.test:" + port, {
          onHeaders: (value) => {
            headers = value;
          },
        }),
      ).resolves.toBe(text);
      expect(headers?.["set-cookie"]).toEqual(cookies);
      expect(headers?.["content-encoding"]).toBeUndefined();
    } finally {
      await lease.close();
    }
  });

  it.each(["GET", "CONNECT"])(
    "revokes pending %s requests before DNS completes",
    async (method) => {
      let started!: () => void;
      const resolving = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let connections = 0;
      const port = await upstream((_request, response) => response.end("late"));
      servers.at(-1)!.on("connection", () => {
        connections += 1;
      });
      const gateway = new NetworkGateway(async () => {
        started();
        await blocked;
        return [{ address: "127.0.0.1", family: 4 }];
      });
      const grant =
        method === "GET"
          ? capability(port)
          : {
              ...capability(port),
              targets: [{ scheme: "https" as const, host: "fixture.test", port }],
            };
      const lease = await openCapabilityProxy(gateway, grant);
      const proxy = new URL(lease.route.url);
      const request = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        method,
        path: method === "GET" ? "http://fixture.test:" + port : "fixture.test:" + port,
        headers: {
          "proxy-authorization":
            "Basic " + Buffer.from(proxy.username + ":" + proxy.password).toString("base64"),
        },
      });
      request.on("error", () => undefined);
      request.end();
      try {
        await resolving;
        await lease.close();
        release();
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(connections).toBe(0);
      } finally {
        release();
        request.destroy();
        await lease.close();
      }
    },
  );
  it("accepts only the per-call credential and becomes unavailable after close", async () => {
    const port = await upstream((_request, response) => response.end("through-proxy"));
    const lease = await openCapabilityProxy(fixtureGateway(), capability(port));
    const proxy = new URL(lease.route.url);

    await expect(proxyRequest(proxy, `http://fixture.test:${port}/ok`)).resolves.toBe(
      "through-proxy",
    );
    await expect(
      proxyRequest(
        new URL(`http://omni:wrong@127.0.0.1:${lease.route.port}`),
        `http://fixture.test:${port}/ok`,
      ),
    ).rejects.toMatchObject({ status: 407 });

    await lease.close();
    await lease.close();
    await expect(proxyRequest(proxy, `http://fixture.test:${port}/ok`)).rejects.toBeDefined();
  });

  it("expires the per-call proxy credential and listener", async () => {
    const port = await upstream((_request, response) => response.end("through-proxy"));
    const lease = await openCapabilityProxy(fixtureGateway(), capability(port), { ttlMs: 10 });
    const proxy = new URL(lease.route.url);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(proxyRequest(proxy, `http://fixture.test:${port}/ok`)).rejects.toBeDefined();
    await lease.close();
  });
});

describe("DefaultNetworkRuntime", () => {
  it.each(["close", "abort"] as const)("revokes a live stream on lease %s", async (action) => {
    let closed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const port = await upstream((_request, response) => {
      response.once("close", closed);
      response.write("first");
    });
    const abort = new AbortController();
    const lease = await new DefaultNetworkRuntime(fixtureGateway()).open(capability(port), {
      agentId: "coding",
      workspaceId: "workspace",
      toolCallId: "call",
      mode: "autonomous",
      execution: "in_process",
      signal: abort.signal,
    });
    try {
      const response = await lease.client.requestStream({
        url: "http://fixture.test:" + port,
        method: "GET",
        maxCompressedBytes: 1024,
        maxDecompressedBytes: 1024,
      });
      const reader = response.body.getReader();
      await reader.read();
      if (action === "close") await lease.close();
      else abort.abort();
      await expect(reader.read()).rejects.toBeDefined();
      await upstreamClosed;
    } finally {
      await lease.close();
    }
  });

  it("does not create a process proxy in unrestricted mode", async () => {
    const lease = await new DefaultNetworkRuntime().open(capability(3000), {
      agentId: "coding",
      workspaceId: "workspace",
      toolCallId: "call",
      mode: "unrestricted",
      execution: "process",
    });
    expect(lease.processProxy).toBeUndefined();
    expect(lease.sensitiveValues).toEqual([]);
    await lease.close();
  });
  it("does not expose a proxy for in-process tools and expires the bound client on close", async () => {
    const port = await upstream((_request, response) => response.end("bounded-client"));
    const lease = await new DefaultNetworkRuntime(fixtureGateway()).open(capability(port), {
      agentId: "coding",
      workspaceId: "workspace",
      toolCallId: "call",
      execution: "in_process",
      mode: "controlled",
    });
    expect(lease.processProxy).toBeUndefined();
    await expect(
      lease.client.request({
        url: `http://fixture.test:${port}/ok`,
        method: "GET",
        maxCompressedBytes: 1024,
        maxDecompressedBytes: 1024,
      }),
    ).resolves.toMatchObject({ status: 200 });
    await lease.close();
    await expect(
      lease.client.request({
        url: `http://fixture.test:${port}/late`,
        method: "GET",
        maxCompressedBytes: 1024,
        maxDecompressedBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "network_capability_expired" });
  });
});

function proxyRequest(
  proxy: URL,
  target: string,
  options: {
    method?: string;
    body?: string | Buffer;
    chunked?: boolean;
    onHeaders?: (headers: http.IncomingHttpHeaders) => void;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        path: target,
        method: options.method ?? "GET",
        headers: {
          ...(options.chunked
            ? { "transfer-encoding": "chunked" }
            : options.body === undefined
              ? {}
              : { "content-length": Buffer.byteLength(options.body) }),
          "proxy-authorization": `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`,
        },
      },
      (response) => {
        options.onHeaders?.(response.headers);
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(
              Object.assign(new Error(`proxy status ${response.statusCode}`), {
                status: response.statusCode,
              }),
            );
          } else resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}
