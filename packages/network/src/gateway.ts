import http from "node:http";
import https from "node:https";
import { connect, type LookupFunction, type Socket } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { addAbortSignal, pipeline, Readable, Transform } from "node:stream";
import {
  networkTargetFromUrl,
  networkTargetMatches,
  normalizeNetworkTargets,
  throwIfAborted,
  type ExecutionMode,
  type NetworkCapability,
  type NetworkRequest,
  type NetworkResponse,
  type NetworkStreamResponse,
} from "@omni-agent/core";
import { NetworkPolicyError } from "./error";
import {
  assertNetworkAddress,
  resolveNetworkAddresses,
  type AddressResolver,
  type ResolvedAddress,
} from "./resolver";

const MAX_REDIRECTS = 5;
const MAX_HEADER_BYTES = 64 * 1024;

export class NetworkGateway {
  constructor(private readonly resolveAddresses: AddressResolver = resolveNetworkAddresses) {}

  client(
    capability: NetworkCapability,
    mode: ExecutionMode,
    lifetime?: AbortSignal,
  ): import("@omni-agent/core").AuthorizedNetworkClient {
    const grant = { ...capability, targets: normalizeNetworkTargets(capability.targets) };
    const requestStream = async (request: NetworkRequest) => {
      throwIfAborted(lifetime);
      const signal =
        lifetime && request.signal
          ? AbortSignal.any([lifetime, request.signal])
          : (lifetime ?? request.signal);
      return this.openResponse(grant, mode, { ...request, signal });
    };
    return {
      requestStream,
      request: async (request): Promise<NetworkResponse> => {
        const response = await requestStream(request);
        const chunks: Uint8Array[] = [];
        for await (const chunk of Readable.fromWeb(response.body)) chunks.push(chunk);
        return {
          ...response,
          body: Buffer.concat(chunks),
          compressedBytes: response.compressedBytes,
        };
      },
    };
  }

  private async openResponse(
    capability: NetworkCapability,
    mode: ExecutionMode,
    request: NetworkRequest,
  ): Promise<NetworkStreamResponse & { readonly compressedBytes: number }> {
    const requestedUrl = request.url;
    for (let redirectCount = 0; ; redirectCount += 1) {
      throwIfAborted(request.signal);
      const target = networkTargetFromUrl(request.url);
      const address = await this.resolveTarget(capability, mode, target, request.signal);
      const response = await this.requestOnce(request, address);
      const location = response.headers.location;
      if (isRedirect(response.status) && location) {
        response.stream.destroy();
        if (redirectCount >= MAX_REDIRECTS)
          throw new NetworkPolicyError("network_redirect_limit", "Network redirect limit exceeded");
        if (request.method !== "GET")
          throw new NetworkPolicyError(
            "network_redirect_method_unsafe",
            "Redirects are not followed for non-GET requests",
          );
        const next = new URL(location, request.url).toString();
        if (!networkTargetMatches(target, networkTargetFromUrl(next)))
          throw new NetworkPolicyError(
            "network_redirect_not_authorized",
            "Cross-origin redirects are not authorized",
          );
        request = { ...request, url: next };
        continue;
      }
      const body = boundedBody(response.stream, response.headers, request);
      return {
        requestedUrl,
        finalUrl: request.url,
        status: response.status,
        headers: body.headers,
        body: body.stream,
        get compressedBytes() {
          return body.compressedBytes;
        },
        redirectCount,
      };
    }
  }

  async connectTlsTarget(
    capability: NetworkCapability,
    host: string,
    port: number,
    signal: AbortSignal,
  ): Promise<Socket> {
    const target = networkTargetFromUrl("https://" + host + ":" + port);
    const address = await this.resolveTarget(capability, "autonomous", target, signal);
    return new Promise((resolve, reject) => {
      const socket = connect({
        host: address.address,
        port: target.port,
        family: address.family,
        signal,
      });
      socket.once("connect", () => resolve(socket));
      socket.on("error", reject);
    });
  }

  private async resolveTarget(
    capability: NetworkCapability,
    mode: ExecutionMode,
    target: import("@omni-agent/core").NetworkTarget,
    signal?: AbortSignal,
  ): Promise<ResolvedAddress> {
    throwIfAborted(signal);
    if (
      mode !== "unrestricted" &&
      !capability.targets.some((entry) => networkTargetMatches(entry, target))
    )
      throw new NetworkPolicyError(
        "network_target_not_authorized",
        "Network target is not authorized",
      );
    const addresses = await this.resolveAddresses(target.host);
    // DNS itself may not be cancellable. Never open a socket after the grant has expired.
    throwIfAborted(signal);
    if (!addresses.length)
      throw new NetworkPolicyError("network_dns_empty", "DNS returned no addresses");
    for (const address of addresses) assertNetworkAddress(address.address, mode);
    return addresses[0]!;
  }

  private requestOnce(
    request: NetworkRequest,
    address: ResolvedAddress,
  ): Promise<{ status: number; headers: Record<string, string>; stream: http.IncomingMessage }> {
    const url = new URL(request.url);
    const transport = url.protocol === "https:" ? https : http;
    const lookup: LookupFunction = (_host, options, callback) => {
      if (typeof options === "object" && options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };
    return new Promise((resolve, reject) => {
      const client = transport.request(
        url,
        {
          method: request.method,
          headers: request.headers,
          maxHeaderSize: MAX_HEADER_BYTES,
          lookup,
          signal: request.signal,
        },
        (response) => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined)
              headers[name] = Array.isArray(value) ? value.join(", ") : value;
          }
          resolve({ status: response.statusCode ?? 0, headers, stream: response });
        },
      );
      client.once("error", reject);
      client.end(request.body);
    });
  }
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function byteLimit(
  maximum: number,
  kind: "compressed" | "decompressed",
  record?: (size: number) => void,
): Transform {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      record?.(size);
      callback(
        size > maximum
          ? new NetworkPolicyError("network_" + kind + "_limit", kind + " response is too large")
          : null,
        chunk,
      );
    },
  });
}

function boundedBody(
  source: http.IncomingMessage,
  originalHeaders: Record<string, string>,
  request: NetworkRequest,
) {
  const headers = { ...originalHeaders };
  // HEAD describes the GET representation, but carries no body to decompress.
  const encoding =
    request.method === "HEAD" ? undefined : headers["content-encoding"]?.trim().toLowerCase();
  const decoder =
    encoding === "gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : undefined;
  if (encoding && encoding !== "identity" && !decoder) {
    source.destroy();
    throw new NetworkPolicyError(
      "network_encoding_unsupported",
      "Unsupported response content encoding",
    );
  }
  delete headers["transfer-encoding"];
  if (decoder) {
    delete headers["content-encoding"];
    delete headers["content-length"];
  }
  let compressedBytes = 0;
  const compressed = byteLimit(request.maxCompressedBytes, "compressed", (size) => {
    compressedBytes = size;
  });
  const output = byteLimit(request.maxDecompressedBytes, "decompressed");
  // One pipeline propagates failures and tears down every stage, including reader cancellation.
  // Errors reach the terminal readable; its consumer owns reporting the failed request.
  pipeline([source, compressed, ...(decoder ? [decoder] : []), output], () => undefined);
  if (request.signal) addAbortSignal(request.signal, output);
  return {
    headers,
    stream: Readable.toWeb(output) as ReadableStream<Uint8Array>,
    get compressedBytes() {
      return compressedBytes;
    },
  };
}
