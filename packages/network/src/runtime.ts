import {
  throwIfAborted,
  type NetworkCapability,
  type NetworkRuntimeContext,
  type NetworkRuntimeLease,
  type NetworkRuntimePort,
} from "@omni-agent/core";
import { NetworkGateway } from "./gateway";
import { NetworkPolicyError } from "./error";
import { openCapabilityProxy } from "./proxy";

export class DefaultNetworkRuntime implements NetworkRuntimePort {
  constructor(private readonly gateway = new NetworkGateway()) {}

  async open(
    capability: NetworkCapability,
    context: NetworkRuntimeContext,
  ): Promise<NetworkRuntimeLease> {
    throwIfAborted(context.signal);
    const lifetime = new AbortController();
    const client = this.gateway.client(capability, context.mode, lifetime.signal);
    const proxy =
      context.execution === "process" && context.mode !== "unrestricted"
        ? await openCapabilityProxy(this.gateway, capability)
        : undefined;
    let closePromise: Promise<void> | undefined;
    const onAbort = () => {
      lifetime.abort(context.signal?.reason);
      void proxy?.close();
    };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.signal?.aborted) {
      onAbort();
      context.signal.removeEventListener("abort", onAbort);
      await proxy?.close();
      throwIfAborted(context.signal);
    }
    return {
      client,
      ...(proxy ? { processProxy: proxy.route } : {}),
      sensitiveValues: proxy?.sensitiveValues ?? [],
      close() {
        if (closePromise) return closePromise;
        lifetime.abort(
          new NetworkPolicyError("network_capability_expired", "Network capability expired"),
        );
        context.signal?.removeEventListener("abort", onAbort);
        return (closePromise = proxy?.close() ?? Promise.resolve());
      },
    };
  }
}

export function createNetworkRuntime(): NetworkRuntimePort {
  return new DefaultNetworkRuntime();
}
