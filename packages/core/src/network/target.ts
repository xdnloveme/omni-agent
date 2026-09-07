import { domainToASCII } from "node:url";
import type { NetworkTarget } from "./types";

export const MAX_APPROVED_NETWORK_TARGETS = 64;

export function networkTargetFromUrl(value: string): NetworkTarget {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Network target URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Network targets support only HTTP and HTTPS");
  }
  if (url.username || url.password) throw new Error("Network target URLs cannot contain user info");
  return normalizeNetworkTarget({
    scheme: url.protocol.slice(0, -1) as NetworkTarget["scheme"],
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
  });
}

export function normalizeNetworkTarget(target: NetworkTarget): NetworkTarget {
  if (target.scheme !== "http" && target.scheme !== "https") {
    throw new Error("Network target scheme must be http or https");
  }
  const rawHost = target.host.endsWith(".") ? target.host.slice(0, -1) : target.host;
  const host = domainToASCII(rawHost).toLowerCase();
  if (!host || host.length > 253 || /[\s/@]/.test(host)) {
    throw new Error("Network target host is invalid");
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new Error("Network target port is invalid");
  }
  return { scheme: target.scheme, host, port: target.port };
}

export function networkTargetKey(target: NetworkTarget): string {
  const normalized = normalizeNetworkTarget(target);
  return `${normalized.scheme}://${normalized.host}:${normalized.port}`;
}

export function normalizeNetworkTargets(
  targets: readonly NetworkTarget[],
): readonly NetworkTarget[] {
  const unique = new Map<string, NetworkTarget>();
  for (const target of targets) {
    const normalized = normalizeNetworkTarget(target);
    unique.set(networkTargetKey(normalized), normalized);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, target]) => target);
}

export function networkTargetMatches(left: NetworkTarget, right: NetworkTarget): boolean {
  return networkTargetKey(left) === networkTargetKey(right);
}
