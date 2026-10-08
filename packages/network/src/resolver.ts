import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";
import type { ExecutionMode } from "@omni-agent/core";
import { NetworkPolicyError } from "./error";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type AddressResolver = (host: string) => Promise<readonly ResolvedAddress[]>;

export const resolveNetworkAddresses: AddressResolver = async (host) => {
  const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = isIP(address);
  if (family) return [{ address, family: family as 4 | 6 }];
  return (await dns.lookup(address, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));
};

const metadata = new BlockList();
for (const address of ["169.254.169.254", "169.254.170.2", "100.100.100.200"])
  metadata.addAddress(address, "ipv4");
metadata.addAddress("fd00:ec2::254", "ipv6");

export function assertNetworkAddress(address: string, mode: ExecutionMode): void {
  const family = isIP(address);
  if (!family)
    throw new NetworkPolicyError("network_dns_invalid", "DNS returned an invalid IP address");
  // Local services are ordinary targets. Known credential-bearing metadata endpoints are not.
  if (mode !== "unrestricted" && metadata.check(address, family === 4 ? "ipv4" : "ipv6"))
    throw new NetworkPolicyError(
      "network_metadata_denied",
      "Cloud metadata access requires unrestricted mode",
    );
}
