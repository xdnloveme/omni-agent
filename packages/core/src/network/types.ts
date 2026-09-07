export interface NetworkTarget {
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: number;
}

export interface NetworkCapability {
  readonly targets: readonly NetworkTarget[];
  readonly purpose: string;
}

export interface NetworkRequest {
  readonly url: string;
  readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  readonly headers?: Readonly<Record<string, string | string[]>>;
  /** Bounded protocol payload. The owning adapter remains responsible for its semantics. */
  readonly body?: Uint8Array;
  readonly maxCompressedBytes: number;
  readonly maxDecompressedBytes: number;
  readonly signal?: AbortSignal;
}

export interface NetworkResponse {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  /** Preserve separate field values, notably Set-Cookie, across transport adapters. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Uint8Array;
  readonly compressedBytes: number;
  readonly redirectCount: number;
}

export interface NetworkStreamResponse extends Omit<NetworkResponse, "body" | "compressedBytes"> {
  readonly body: ReadableStream<Uint8Array>;
}

export interface AuthorizedNetworkClient {
  request(request: NetworkRequest): Promise<NetworkResponse>;
  requestStream(request: NetworkRequest): Promise<NetworkStreamResponse>;
}

export interface NetworkProxyRoute {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly url: string;
}

export interface NetworkRuntimeLease {
  readonly client: AuthorizedNetworkClient;
  readonly processProxy?: NetworkProxyRoute;
  readonly sensitiveValues: readonly string[];
  close(): Promise<void>;
}

export interface NetworkRuntimeContext {
  readonly mode: import("../execution/types").ExecutionMode;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly toolCallId: string;
  readonly execution: "in_process" | "process";
  readonly signal?: AbortSignal;
}

export interface NetworkRuntimePort {
  open(capability: NetworkCapability, context: NetworkRuntimeContext): Promise<NetworkRuntimeLease>;
}
